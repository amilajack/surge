import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const platform=await readFile(new URL('../browser/platform.js',import.meta.url),'utf8');
const begin=platform.indexOf('function wclapUserFolder(user)'),end=platform.indexOf('// A plugin must not hold',begin);
assert.ok(begin>=0&&end>begin);
function harness(){
 const nodes=new Map([['/user',{mode:'dir',mtime:1}]]);let clock=1;const sent=[];
 const FS={mount(){},isDir:mode=>mode==='dir',isFile:mode=>mode==='file',mkdirTree(path){let current='';for(const part of path.split('/').filter(Boolean)){current+='/'+part;if(!nodes.has(current))nodes.set(current,{mode:'dir',mtime:++clock});}},writeFile(path,data){nodes.set(path,{mode:'file',mtime:++clock,data:new Uint8Array(data)});},utime(path,access,mtime){nodes.get(path).mtime=mtime;},lstat(path){const node=nodes.get(path);if(!node)throw Error('missing');return node;},readFile:path=>nodes.get(path).data.slice(),readdir:path=>['.','..',...[...nodes.keys()].filter(key=>key.startsWith(path+'/')&&!key.slice(path.length+1).includes('/')).map(key=>key.slice(path.length+1))]};
 const IDBFS={},context={FS,IDBFS,platform:{},SurgeWclapPage:{userFiles:{send:async operations=>sent.push(operations)}}};
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
