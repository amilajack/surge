import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const platform=await readFile(new URL('../browser/platform.js',import.meta.url),'utf8');
const begin=platform.indexOf('function wclapUserFolder(user)'),end=platform.indexOf('// A plugin must not hold',begin);
assert.ok(begin>=0&&end>begin);
function harness(send){
 const nodes=new Map(),sent=[],maps=[];let clock=1,next=0;
 const rawWrite=(stream,data,offset,length,position=0)=>{
  const node=stream.node,old=node.data||new Uint8Array(),bytes=new Uint8Array(Math.max(old.length,position+length));
  bytes.set(old);bytes.set(data.subarray(offset,offset+length),position);node.data=bytes;node.mtime=++clock;return length;
 };
 const ops={
  mknod(parent,name,mode){
   const path=parent.path+'/'+name,node={path,mode,mtime:++clock,id:++next,node_ops:ops,stream_ops:{}};
   if(mode==='file')node.stream_ops={write:rawWrite,msync:(stream,data,offset,length,flags)=>flags&2?0:rawWrite(stream,data,offset,length,0),allocate(stream,offset,length){const old=stream.node.data||new Uint8Array();const bytes=new Uint8Array(Math.max(old.length,offset+length));bytes.set(old);stream.node.data=bytes;}};
   nodes.set(path,node);return node;
  },
  setattr(node,attributes){
   if(attributes.size!==undefined){const bytes=new Uint8Array(attributes.size);bytes.set((node.data||new Uint8Array()).subarray(0,attributes.size));node.data=bytes;}
   Object.assign(node,attributes);
  }
 };
 const root={path:'/user',mode:'dir',mtime:1,id:++next,node_ops:ops,stream_ops:{}};nodes.set('/user',root);
 const FS={
  mount:()=>root,isDir:mode=>mode==='dir',isFile:mode=>mode==='file',
  lookupPath(path){const node=nodes.get(path);if(!node)throw Error('missing');return{node};},
  mkdirTree(path){let current='';for(const part of path.split('/').filter(Boolean)){const parent=current;current+='/'+part;if(!nodes.has(current))nodes.get(parent).node_ops.mknod(nodes.get(parent),part,'dir');}},
  writeFile(path,data){let node=nodes.get(path);if(!node){const slash=path.lastIndexOf('/'),parent=nodes.get(path.slice(0,slash));node=parent.node_ops.mknod(parent,path.slice(slash+1),'file');}node.node_ops.setattr(node,{size:0});node.stream_ops.write({node},data,0,data.length,0);},
  utime(path,access,mtime){const node=nodes.get(path);node.node_ops.setattr(node,{mtime});},
  truncate(path,size){const node=nodes.get(path);node.node_ops.setattr(node,{size});},
  lstat(path){const node=nodes.get(path);if(!node)throw Error('missing');return node;},readFile:path=>nodes.get(path).data.slice(),
  readdir:path=>['.','..',...[...nodes.keys()].filter(key=>key.startsWith(path+'/')&&!key.slice(path.length+1).includes('/')).map(key=>key.slice(path.length+1))]
 };
 const IDBFS={},context={FS,IDBFS,WeakMap:class extends WeakMap{constructor(){super();maps.push(this);}},platform:{changed(){}},SurgeWclapPage:{userFiles:{send:operations=>{sent.push(operations);return send?send(operations):Promise.resolve();}}}};
 vm.runInNewContext(platform.slice(begin,end)+';globalThis.mount=wclapUserFolder;',context);
 context.mount({entries:[{path:'data',kind:2,mtime:1,data:new Uint8Array()},{path:'settings.xml',kind:1,mtime:1,data:new Uint8Array([1])}],skipped:[{path:'data/large.wav',size:512*1024*1024+1,reason:'oversized'}]});
 const sync=()=>new Promise(resolve=>IDBFS.syncfs({},false,resolve));return{nodes,FS,sent,sync,revisions:maps[0]};
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

test('same-millisecond writes persist changed bytes even with an unchanged timestamp',async()=>{
 const h=harness();h.FS.writeFile('/user/settings.xml',new Uint8Array([42]));h.FS.utime('/user/settings.xml',1,1);
 assert.equal(await h.sync(),null);assert.equal(h.sent.length,1);assert.deepEqual([...h.sent[0][0].data],[42]);
});
test('a replacement inode cannot hide behind equal mtime and revision',async()=>{
 const h=harness(),old=h.nodes.get('/user/settings.xml'),revision=h.revisions.get(old);
 h.nodes.delete('/user/settings.xml');h.FS.writeFile('/user/settings.xml',new Uint8Array([99]));h.FS.utime('/user/settings.xml',1,1);
 h.revisions.set(h.nodes.get('/user/settings.xml'),revision);
 assert.equal(await h.sync(),null);assert.deepEqual([...h.sent[0][0].data],[99]);
});
test('newer in-flight writes retain their revision until their own durable reply',async()=>{
 const completions=[],h=harness(()=>new Promise(resolve=>completions.push(resolve)));
 h.FS.writeFile('/user/settings.xml',new Uint8Array([2]));h.FS.utime('/user/settings.xml',1,1);const first=h.sync();
 h.FS.writeFile('/user/settings.xml',new Uint8Array([3]));h.FS.utime('/user/settings.xml',1,1);const later=h.sync();
 completions.shift()();await first;for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(h.sent.length,2);assert.deepEqual([...h.sent[1][0].data],[3]);completions.shift()();await later;
 assert.equal(await h.sync(),null);assert.equal(h.sent.length,2);
});
test('truncate, mmap flush and allocation mutations advance inode revisions',async()=>{
 const h=harness();h.FS.truncate('/user/settings.xml',0);h.FS.utime('/user/settings.xml',1,1);await h.sync();assert.equal(h.sent[0][0].data.length,0);
 const node=h.nodes.get('/user/settings.xml');node.stream_ops.msync({node},new Uint8Array([5]),0,1);h.FS.utime('/user/settings.xml',1,1);await h.sync();assert.deepEqual([...h.sent[1][0].data],[5]);
 node.stream_ops.allocate({node},1,2);h.FS.utime('/user/settings.xml',1,1);await h.sync();assert.deepEqual([...h.sent[2][0].data],[5,0,0]);
});
test('revision exhaustion refuses mutations and persistence instead of wrapping',async()=>{
 const h=harness(),node=h.nodes.get('/user/settings.xml');h.revisions.set(node,Number.MAX_SAFE_INTEGER);
 assert.throws(()=>h.FS.writeFile('/user/settings.xml',new Uint8Array([99])),/counter is exhausted/);
 assert.deepEqual([...h.FS.readFile('/user/settings.xml')],[1]);assert.match(String(await h.sync()),/counter is exhausted/);assert.equal(h.sent.length,0);
});

test('replacing a directory preserves remove/recreate ordering for shared host capabilities',async()=>{
 const h=harness();h.FS.mkdirTree('/user/replace');h.FS.writeFile('/user/replace/child',new Uint8Array([1]));await h.sync();h.sent.length=0;
 h.nodes.delete('/user/replace/child');h.nodes.delete('/user/replace');h.FS.mkdirTree('/user/replace');h.FS.writeFile('/user/replace/child',new Uint8Array([2]));await h.sync();
 assert.deepEqual(Array.from(h.sent[0],({op,path})=>[op,path]),[[2,'replace/child'],[4,'replace'],[3,'replace'],[1,'replace/child']]);
});
test('a mutation during bytes-read refuses publication and a retry captures the new revision',async()=>{
 const h=harness();h.FS.writeFile('/user/settings.xml',new Uint8Array([2]));const read=h.FS.readFile;
 h.FS.readFile=path=>{h.FS.readFile=read;h.FS.writeFile(path,new Uint8Array([3]));return read(path);};
 assert.match(String(await h.sync()),/changed during its snapshot/);assert.equal(h.sent.length,0);
 assert.equal(await h.sync(),null);assert.deepEqual([...h.sent[0][0].data],[3]);
});
test('a private mmap flush does not dirty or replace the underlying user file',async()=>{
 const h=harness(),node=h.nodes.get('/user/settings.xml');node.stream_ops.msync({node},new Uint8Array([99]),0,1,2);
 assert.equal(await h.sync(),null);assert.equal(h.sent.length,0);assert.deepEqual([...h.FS.readFile('/user/settings.xml')],[1]);
});

test('inode replacement during bytes-read refuses publication even with equal revisions',async()=>{
 const h=harness();h.FS.writeFile('/user/settings.xml',new Uint8Array([2]));const read=h.FS.readFile;
 h.FS.readFile=path=>{h.FS.readFile=read;h.nodes.delete(path);h.FS.writeFile(path,new Uint8Array([9]));return read(path);};
 assert.match(String(await h.sync()),/changed during its snapshot/);assert.equal(h.sent.length,0);
 assert.equal(await h.sync(),null);assert.deepEqual([...h.sent[0][0].data],[9]);
});
