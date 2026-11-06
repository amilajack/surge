import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../browser/platform.js',import.meta.url),'utf8');
const begin=source.indexOf('  const platform = globalThis.SurgeBrowser = {');
const end=source.indexOf('    devicePreference(',begin);
function harness(){
 let next=0;const timers=new Map(),syncs=[],status={textContent:''},retry={hidden:true};
 const context=vm.createContext({Module:{surgeWclap:true},FS:{syncfs(_populate,callback){syncs.push(callback);}},host:{status(){return status;}},document:{getElementById:()=>retry},setTimeout(fn){const id=++next;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}});
 vm.runInContext(source.slice(begin,end)+'};',context);
 const platform=context.SurgeBrowser;platform.restoring=false;platform.storageState='saved';
 return{platform,syncs,timers,status,retry};
}
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('dirty edits are pending immediately and a burst queues one snapshot',async()=>{
 const h=harness();for(let i=0;i<1000;i++)h.platform.changed();
 assert.equal(h.platform.storageState,'saving');assert.equal(h.platform.savedGeneration,0);assert.equal(h.timers.size,1);
 const saved=h.platform.flush();await tick();assert.equal(h.timers.size,0);assert.equal(h.syncs.length,1);
 h.syncs.shift()(null);await saved;assert.equal(h.platform.storageState,'saved');assert.equal(h.platform.savedGeneration,1000);
});
test('close joins in-flight save and coalesces newer writes before resolving',async()=>{
 const h=harness();h.platform.changed();const first=h.platform.flush();await tick();
 for(let i=0;i<1000;i++)h.platform.changed();
 let closed=false;const close=h.platform.flush().then(()=>{closed=true;});
 assert.equal(h.timers.size,0);assert.equal(h.syncs.length,1);h.syncs.shift()(null);await tick();
 assert.equal(closed,false);assert.equal(h.syncs.length,1);assert.equal(h.platform.storageState,'saving');
 h.syncs.shift()(null);await Promise.all([first,close]);assert.equal(closed,true);assert.equal(h.platform.savedGeneration,1001);assert.equal(h.platform.storageState,'saved');
});
test('failed persistence keeps dirty bytes retryable and never claims saved',async()=>{
 const h=harness();h.platform.changed();const first=h.platform.flush();const rejected=assert.rejects(first,/disk full/);await tick();
 h.syncs.shift()(new Error('disk full'));await rejected;
 assert.equal(h.platform.storageState,'error');assert.equal(h.platform.savedGeneration,0);assert.equal(h.platform.generation,1);assert.equal(h.platform.pendingFlush,null);assert.equal(h.retry.hidden,false);
 const retried=h.platform.flush();await tick();h.syncs.shift()(null);await retried;assert.equal(h.platform.savedGeneration,1);assert.equal(h.platform.storageState,'saved');assert.equal(h.retry.hidden,true);
});
