import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
const html=await readFile(new URL('../wclap/ui/index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('  // The host persists'),html.indexOf('  // Messages the page answers'));
const listing=()=>({protocol:2,available:true,entries:[],skipped:[]});
const fileToken=bytes=>'file:'+createHash('sha256').update(bytes).digest('hex');
const ack=operations=>({protocol:2,versions:[...new Map(operations.map(operation=>[operation.path,operation])).values()].map(operation=>({path:operation.path,token:operation.op===1?fileToken(operation.data):operation.op===3?'directory':null}))});
const host=(apply=operations=>ack(operations))=>({onBeforeClose(){return()=>{};},exportFile:async()=>({started:true}),userFiles:request=>request.op==='list'?listing():apply(request.operations)});
function adapter(service,globals={}){
 const context=vm.createContext({wclapHost:service,crypto:webcrypto,Uint8Array,stopped:false,setTimeout,clearTimeout,...globals});
 return vm.runInContext(source+'\n({userFiles,closeUserFiles,discardUserFiles,register:()=>{unregisterClose=wclapHost.onBeforeClose(closeUserFiles);}})',context);
}
test('versioned user-file requests preserve order and snapshot caller bytes',async()=>{
 let finish;const seen=[];
 const files=adapter({onBeforeClose(){return()=>{};},exportFile:async()=>({started:true}),userFiles:request=>{seen.push(request);return request.op==='list'?new Promise(resolve=>{finish=resolve;}):ack(request.operations);}}).userFiles;
 const opened=files.list(),bytes=new Uint8Array([1,2]);const saving=files.send([{op:1,path:'settings.xml',expected:null,data:bytes}]);bytes[0]=99;
 await Promise.resolve();assert.equal(seen.length,1);finish(listing());await opened;await saving;
 assert.equal(seen[0].protocol,2);assert.equal(seen[1].protocol,2);assert.deepEqual([...seen[1].operations[0].data],[1,2]);
});
test('failed durable save is reported and a retry can complete',async()=>{
 let count=0;const files=adapter(host(operations=>{if(++count===1)throw Error('disk full');return ack(operations);})).userFiles;await files.list();
 await assert.rejects(files.send([{op:3,path:'presets',expected:null}]),/disk full/);assert.equal((await files.send([{op:3,path:'presets',expected:null}])).protocol,2);
});
test('missing host capability or lifecycle rejects before accepting writes',async()=>{
 await assert.rejects(adapter(undefined).userFiles.list(),/does not support durable/);
 await assert.rejects(adapter({...host(),onBeforeClose:undefined}).userFiles.list(),/cannot safely close/);
 await assert.rejects(adapter({...host(),exportFile:undefined}).userFiles.list(),/cannot download/);
});
test('missing protocol advertisement refuses even an empty folder before writes',async()=>{
 let writes=0;const files=adapter({onBeforeClose(){return()=>{};},exportFile:async()=>({started:true}),userFiles:request=>request.op==='list'?{available:true,entries:[],skipped:[]}:++writes}).userFiles;
 await assert.rejects(files.list(),/conflict-safe/);await assert.rejects(files.send([{op:3,path:'presets',expected:null}]),/not opened/);assert.equal(writes,0);
});
test('invalid or ambiguous listing tokens reject before interaction',async()=>{
 for(const entries of [[{path:'x',kind:1,data:new Uint8Array(),token:'wrong'}],[{path:'x',kind:2,token:'directory'},{path:'x',kind:2,token:'directory'}]])
  await assert.rejects(adapter({onBeforeClose(){return()=>{};},exportFile:async()=>({started:true}),userFiles:()=>({...listing(),entries})}).userFiles.list(),/base version/);
});
test('every operation must carry its initial expected base',async()=>{
 const files=adapter(host()).userFiles;await files.list();assert.throws(()=>files.send([{op:3,path:'presets'}]),/Invalid conflict-safe/);
});
test('missing duplicate extra or wrong-postimage acknowledgments cannot confirm saving',async()=>{
 const bad=[{protocol:2,versions:[]},{protocol:2,versions:[{path:'x',token:'directory'},{path:'x',token:'directory'}]},{protocol:2,versions:[{path:'other',token:'directory'}]},{protocol:2,versions:[{path:'x',token:'file:'+'0'.repeat(64)}]}];
 for(const reply of bad){const files=adapter(host(()=>reply)).userFiles;await files.list();await assert.rejects(files.send([{op:1,path:'x',expected:null,data:new Uint8Array([1])}]),/did not confirm/);}
});
test('close waits for worker barrier dirty flush and durable request tail',async()=>{
 let completeHost,completeFlush;const order=[];
 const value=adapter(host(operations=>new Promise(resolve=>{completeHost=()=>resolve(ack(operations));})),{SurgeWclapPage:{worker:{},call:async()=>order.push('worker')},SurgeBrowser:{flush:()=>{order.push('flush');return new Promise(resolve=>{completeFlush=resolve;});}}});
 await value.userFiles.list();const save=value.userFiles.send([{op:3,path:'presets',expected:null}]);let closed=false;const close=value.closeUserFiles().then(()=>{closed=true;});
 for(let i=0;i<8;i++)await Promise.resolve();assert.deepEqual(order,['worker','flush']);assert.equal(closed,false);
 completeFlush();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(closed,false);completeHost();await Promise.all([save,close]);assert.equal(closed,true);
});
test('close propagates retryable persistence errors',async()=>{
 await assert.rejects(adapter(host(),{SurgeBrowser:{flush:async()=>{throw Error('disk full');}}}).closeUserFiles(),/disk full/);
});

test('explicit discard drains worker and outstanding requests before unregistering and reloading',async()=>{
 let completeHost,completeFlush,reloads=0,unregistered=0;
 const platform={storageState:'error',discarding:false,pendingFlush:new Promise(resolve=>{completeFlush=resolve;}),flushTimer:1};
 const service=host(operations=>new Promise(resolve=>{completeHost=()=>resolve(ack(operations));}));service.onBeforeClose=()=>()=>{unregistered++;};
 const value=adapter(service,{SurgeWclapPage:{worker:{},call:async()=>0},SurgeBrowser:platform,document:{body:{inert:false}},window:{location:{reload(){reloads++;}}}});value.register();await value.userFiles.list();
 const saving=value.userFiles.send([{op:3,path:'presets',expected:null}]);const discard=value.discardUserFiles();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(platform.discarding,true);assert.equal(unregistered,0);assert.equal(reloads,0);
 completeFlush();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(unregistered,0);assert.equal(reloads,0);
 completeHost();await Promise.all([saving,discard]);assert.equal(unregistered,1);assert.equal(reloads,1);assert.equal(platform.storageState,'error');
});
test('timed-out discard retains a retryable live window and never reloads later',async()=>{
 let expire,finishWorker,reloads=0,unregistered=0;
 const body={inert:false},platform={storageState:'error',discarding:false,flushTimer:1,report(){}};
 const service=host();service.onBeforeClose=()=>()=>{unregistered++;};
 const value=adapter(service,{SurgeWclapPage:{worker:{},call:()=>new Promise(resolve=>{finishWorker=resolve;})},SurgeBrowser:platform,document:{body},window:{location:{reload(){reloads++;}}},setTimeout(fn){expire=fn;return 1;},clearTimeout(){}});value.register();
 const discard=value.discardUserFiles();assert.equal(body.inert,true);expire();await discard;assert.equal(platform.discarding,false);assert.equal(body.inert,false);assert.equal(platform.storageState,'error');assert.equal(unregistered,0);assert.equal(reloads,0);
 finishWorker();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(unregistered,0);assert.equal(reloads,0);
});

test('a rejected re-list invalidates the previous protocol advertisement',async()=>{
 let count=0,writes=0;const service=host(()=>{writes++;});service.userFiles=request=>request.op==='list'?(++count===1?listing():{available:true,entries:[],skipped:[]}):++writes;
 const files=adapter(service).userFiles;await files.list();await assert.rejects(files.list(),/conflict-safe/);await assert.rejects(files.send([{op:3,path:'x',expected:null}]),/not opened/);assert.equal(writes,0);
});
