import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../browser/user-files.js',import.meta.url),'utf8');
function page(exportFile,size=3){
 const all=[];
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.textContent='';this.isConnected=true;all.push(this);}
  append(...children){this.children.push(...children);}
  setAttribute(name,value){this[name]=value;}
  replaceChildren(...children){this.children=children;}
  addEventListener(){}
  showModal(){}
 }
 const bytes=new Uint8Array([7,8,9]),storage={storageState:'error'},document={createElement:tag=>new Element(tag),body:new Element('body')};
 let reads=0,pickers=0;
 const module={surgeWclap:true,FS:{readdir:()=>['.','..','recovery.bin'],lstat:()=>({mode:1,size}),isDir:()=>false,isFile:()=>true,readFile(){reads++;return bytes;}}};
 const context={document,Uint8Array,SurgeBrowser:storage,wclapHost:{exportFile},window:{showSaveFilePicker(){pickers++;throw Error('unexpected picker');},showDirectoryPicker(){pickers++;throw Error('unexpected picker');}}};
 vm.runInNewContext(source,context);context.SurgeUserFiles.attach(module);all.find(e=>e.id==='user-files').onclick();
 return{all,bytes,storage,reads:()=>reads,pickers:()=>pickers,find:text=>all.find(e=>e.textContent===text),status:()=>all.find(e=>e.role==='status'),error:()=>all.find(e=>e.role==='alert')};
}
test('WCLAP recovery downloads snapshot bytes without marking local edits saved',async()=>{
 let finish,captured;const value=page(request=>{captured=request;return new Promise(resolve=>{finish=resolve;});});
 const download=value.find('Download recovery.bin').onclick();value.bytes[0]=99;
 assert.deepEqual([...captured.data],[7,8,9]);assert.equal(captured.name,'recovery.bin');
 finish({started:true});await download;
 assert.equal(value.storage.storageState,'error');assert.match(value.status().textContent,/Download started.*Unsaved changes remain/);assert.equal(value.pickers(),0);
});
test('failed or unconfirmed recovery downloads preserve retry and local edits',async()=>{
 for(const service of [async()=>{throw Error('canceled');},async()=>({started:false})]){
  const value=page(service),button=value.find('Download recovery.bin');await button.onclick();
  assert.match(value.error().textContent,/Unable to download.*remains in this window/);assert.equal(button.disabled,false);assert.equal(value.storage.storageState,'error');assert.deepEqual([...value.bytes],[7,8,9]);
 }
});
test('WCLAP disables unsupported folder picking and oversized exports before reading',async()=>{
 const value=page(()=>{throw Error('unexpected export');},256*1024*1024+1);
 const folder=value.find('Download this folder'),file=value.find('Download recovery.bin');
 assert.equal(folder.disabled,true);assert.match(folder.title,/download files individually/);await folder.onclick();assert.equal(value.pickers(),0);
 assert.equal(file.disabled,true);assert.match(file.title,/256 MiB/);assert.equal(value.reads(),0);
});
