import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryFiles} from '../wclap/host/wasi.mjs';
import {userFileRequest} from './wclap-host/user-files.js';

test('standalone host shares its WASI user backend and snapshots listings', () => {
  const store = memoryFiles();
  userFileRequest(store, {op:'apply', operations:[{op:3,path:'presets'}, {op:1,path:'presets/test.fxp',data:new Uint8Array([1,2])}]});
  assert.deepEqual([...store.read('/presets/test.fxp')], [1,2]);
  const listing=userFileRequest(store,{op:'list'});
  assert.equal(listing.entries.find(x=>x.path==='presets').kind,2);
  listing.entries.find(x=>x.path==='presets/test.fxp').data[0]=9;
  assert.equal(store.read('/presets/test.fxp')[0],1);
});
test('standalone host retains successful prefix and rejects escaping paths', () => {
  const store=memoryFiles();
  assert.throws(()=>userFileRequest(store,{op:'apply',operations:[{op:3,path:'kept'},{op:1,path:'../escape',data:new Uint8Array()}]}),/path/);
  assert.equal(store.stat('/kept').type,'dir');
  assert.equal(store.entries.has('/../escape'),false);
});
