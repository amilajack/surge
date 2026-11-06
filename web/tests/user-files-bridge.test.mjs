import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('../wclap/ui/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('  // The host persists'), html.indexOf('  // Messages the page answers'));
function adapter(host) {
  const context = vm.createContext({wclapHost: host && {onBeforeClose() {}, ...host}, Uint8Array, stopped: false});
  return vm.runInContext(source + '\nuserFiles', context);
}
test('user-file requests preserve order and snapshot caller bytes', async () => {
  let finish;
  const seen=[];
  const files=adapter({userFiles: request => {
    seen.push(request);
    if(request.op==='list') return new Promise(resolve => {finish=resolve;});
    return true;
  }});
  const listing=files.list();
  const bytes=new Uint8Array([1,2]);
  const saving=files.send([{op:1,path:'settings.xml',data:bytes}]);
  bytes[0]=99;
  await Promise.resolve();
  assert.equal(seen.length,1);
  finish({available:true,entries:[]});
  await listing;await saving;
  assert.deepEqual([...seen[1].operations[0].data],[1,2]);
});
test('failed durable save is reported and a retry can complete', async () => {
  let count=0;
  const files=adapter({userFiles: () => {if(++count===1) throw new Error('disk full');return true;}});
  await assert.rejects(files.send([{op:3,path:'presets'}]),/disk full/);
  assert.equal(await files.send([{op:3,path:'presets'}]),true);
});
test('missing durable host capability rejects rather than claiming a save', async () => {
  await assert.rejects(adapter(undefined).list(),/does not support durable Surge user files/);
});

test('missing close lifecycle rejects before accepting durable writes', async () => {
  await assert.rejects(adapter({userFiles: () => true, onBeforeClose: undefined}).list(), /cannot safely close/);
});
test('close waits for the worker barrier, dirty flush and durable request tail', async () => {
  let completeHost, completeFlush;
  const order=[];
  const context=vm.createContext({Uint8Array,stopped:false,wclapHost:{onBeforeClose(){},userFiles:()=>new Promise(resolve=>{completeHost=resolve;})},SurgeWclapPage:{worker:{},call:async()=>order.push('worker')},SurgeBrowser:{flush:()=>{order.push('flush');return new Promise(resolve=>{completeFlush=resolve;});}}});
  const {userFiles,closeUserFiles}=vm.runInContext(source+'\n({userFiles,closeUserFiles})',context);
  const save=userFiles.send([{op:1,path:'patch.fxp',data:new Uint8Array([1])}]);
  let closed=false;const close=closeUserFiles().then(()=>{closed=true;});
  for(let i=0;i<4;i++)await Promise.resolve();
  assert.deepEqual(order,['worker','flush']);assert.equal(closed,false);
  completeFlush();for(let i=0;i<4;i++)await Promise.resolve();assert.equal(closed,false);
  completeHost(true);await Promise.all([save,close]);assert.equal(closed,true);
});
test('close propagates a retryable persistence error',async()=>{
  const context=vm.createContext({Uint8Array,stopped:false,SurgeBrowser:{flush:async()=>{throw Error('disk full');}}});
  const close=vm.runInContext(source+'\ncloseUserFiles',context);
  await assert.rejects(close(),/disk full/);
});
