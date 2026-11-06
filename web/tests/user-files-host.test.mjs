import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryFiles} from '../wclap/host/wasi.mjs';
import {userFileRequest} from './wclap-host/user-files.js';
const apply=(store,operations)=>userFileRequest(store,{op:'apply',protocol:2,operations});
test('standalone host shares its WASI user backend and snapshots versioned listings',async()=>{
 const store=memoryFiles();await apply(store,[{op:3,path:'presets',expected:null},{op:1,path:'presets/test.fxp',expected:null,data:new Uint8Array([1,2])}]);
 assert.deepEqual([...store.read('/presets/test.fxp')],[1,2]);const listing=await userFileRequest(store,{op:'list',protocol:2});
 assert.equal(listing.protocol,2);assert.equal(listing.entries.find(x=>x.path==='presets').token,'directory');assert.match(listing.entries.find(x=>x.path==='presets/test.fxp').token,/^file:[0-9a-f]{64}$/);
 listing.entries.find(x=>x.path==='presets/test.fxp').data[0]=9;assert.equal(store.read('/presets/test.fxp')[0],1);
});
test('standalone host preserves I/O prefix and preflights invalid paths',async()=>{
 const store=memoryFiles();await assert.rejects(apply(store,[{op:3,path:'kept',expected:null},{op:1,path:'missing/child',expected:null,data:new Uint8Array()}]),/operation failed/);
 assert.equal(store.stat('/kept').type,'dir');await assert.rejects(apply(store,[{op:3,path:'never',expected:null},{op:1,path:'../escape',expected:null,data:new Uint8Array()}]),/path/);assert.equal(store.entries.has('/never'),false);
});
test('standalone host refuses a stale whole-file snapshot and accepts disjoint files',async()=>{
 const store=memoryFiles();await apply(store,[{op:1,path:'favorites.db',expected:null,data:new Uint8Array([1])}]);const base=(await userFileRequest(store,{op:'list',protocol:2})).entries[0].token;
 await apply(store,[{op:1,path:'favorites.db',expected:base,data:new Uint8Array([2])}]);await assert.rejects(apply(store,[{op:1,path:'favorites.db',expected:base,data:new Uint8Array([3])}]),/conflict/);assert.deepEqual([...store.read('/favorites.db')],[2]);
 await apply(store,[{op:1,path:'other.fxp',expected:null,data:new Uint8Array([4])}]);assert.deepEqual([...store.read('/other.fxp')],[4]);
});
test('standalone host accepts an already durable final postimage on retry',async()=>{
 const store=memoryFiles(),operations=[{op:1,path:'retry.fxp',expected:null,data:new Uint8Array([5])}];await apply(store,operations);assert.equal((await apply(store,operations)).versions.length,1);
});

test('standalone host rejects an unversioned list before exposing user files',async()=>{
 await assert.rejects(userFileRequest(memoryFiles(),{op:'list'}),/Update this plug-in/);
});
