import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const platform=await readFile(new URL('../browser/platform.js',import.meta.url),'utf8');
const begin=platform.indexOf('function wclapUserFolder(user)'),end=platform.indexOf('// A plugin must not hold',begin);
assert.ok(begin>=0&&end>begin);
function harness(send){
 const nodes=new Map([['/user',{mode:'dir',mtime:1}]]);let clock=1;const sent=[];
 const FS={mount(){},isDir:mode=>mode==='dir',isFile:mode=>mode==='file',mkdirTree(path){let current='';for(const part of path.split('/').filter(Boolean)){current+='/'+part;if(!nodes.has(current))nodes.set(current,{mode:'dir',mtime:++clock});}},writeFile(path,data){nodes.set(path,{mode:'file',mtime:++clock,data:new Uint8Array(data)});},utime(path,access,mtime){nodes.get(path).mtime=mtime;},lstat(path){const node=nodes.get(path);if(!node)throw Error('missing');return node;},readFile:path=>nodes.get(path).data.slice(),readdir:path=>['.','..',...[...nodes.keys()].filter(key=>key.startsWith(path+'/')&&!key.slice(path.length+1).includes('/')).map(key=>key.slice(path.length+1))]};
 const IDBFS={},context={FS,IDBFS,platform:{},SurgeWclapPage:{userFiles:{send:operations=>{sent.push(operations);return send ? send(operations) : Promise.resolve();}}}};
 vm.runInNewContext(platform.slice(begin,end)+';globalThis.mount=wclapUserFolder;',context);
 context.mount({entries:[{path:'data',kind:2,mtime:1,data:new Uint8Array()},{path:'settings.xml',kind:1,mtime:1,data:new Uint8Array([1])}],skipped:[{path:'data/large.wav',size:512*1024*1024+1,reason:'oversized'}]});
 const sync=()=>new Promise(resolve=>IDBFS.syncfs({},false,resolve));return{nodes,FS,sent,sync};
}
test('syncing ordinary edits does not infer deletion of skipped or unlisted files',async()=>{
 const h=harness();h.FS.writeFile('/user/settings.xml',new Uint8Array([2]));assert.equal(await h.sync(),null);
 assert.equal(h.sent.length,1);assert.equal(h.sent[0].length,1);assert.equal(h.sent[0][0].op,1);assert.equal(h.sent[0][0].path,'settings.xml');
});
test('removing a parent folder with skipped files is refused before any host mutation',async()=>{
 const h=harness();h.nodes.delete('/user/data');const error=await h.sync();assert.match(String(error),/not loaded/);assert.equal(h.sent.length,0);
});
test('overwriting an omitted path retains the saved original and exposes a retryable error',async()=>{
 const h=harness();h.FS.writeFile('/user/data/large.wav',new Uint8Array([3]));const error=await h.sync();assert.match(String(error),/original remains saved/);assert.equal(h.sent.length,0);
});

test('concurrent direct fd_sync calls keep one snapshot and coalesce the waiting generation',async()=>{
 const completions=[];const h=harness(()=>new Promise((resolve,reject)=>completions.push({resolve,reject})));
 h.FS.writeFile('/user/settings.xml',new Uint8Array([2]));const first=h.sync();
 h.FS.writeFile('/user/settings.xml',new Uint8Array([3]));const later=Array.from({length:1000},()=>h.sync());
 assert.equal(h.sent.length,1);assert.deepEqual([...h.sent[0][0].data],[2]);
 completions.shift().resolve();assert.equal(await first,null);
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(h.sent.length,2);assert.deepEqual([...h.sent[1][0].data],[3]);
 completions.shift().resolve();assert.ok((await Promise.all(later)).every(error=>error===null));
});
test('a failed in-flight snapshot rejects its waiting syncs without dropping retryable edits',async()=>{
 const completions=[];const h=harness(()=>new Promise((resolve,reject)=>completions.push({resolve,reject})));
 h.FS.writeFile('/user/settings.xml',new Uint8Array([2]));const first=h.sync(),later=h.sync();
 completions.shift().reject(new Error('disk full'));assert.match(String(await first),/disk full/);assert.match(String(await later),/disk full/);assert.equal(h.sent.length,1);
 const retry=h.sync();assert.deepEqual([...h.sent[1][0].data],[2]);completions.shift().resolve();assert.equal(await retry,null);
});
test('direct sync waiting callbacks have an explicit bound',async()=>{
 let finish;const h=harness(()=>new Promise(resolve=>{finish=resolve;}));h.FS.writeFile('/user/settings.xml',new Uint8Array([2]));
 const accepted=Array.from({length:4096},()=>h.sync());const error=await h.sync();assert.match(String(error),/Too many pending/);assert.equal(h.sent.length,1);
 finish();assert.ok((await Promise.all(accepted)).every(error=>error===null));assert.equal(h.sent.length,1);
});
