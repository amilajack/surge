import {test,expect} from './fixtures.js';
import {start} from './helpers/ui.js';
const scale='! ok.scl\nTransaction scale\n2\n!\n600.0\n2/1\n';
const listing=(page,path)=>page.evaluate(path=>{
  const walk=p=>Module.FS.analyzePath(p).exists?Module.FS.readdir(p).filter(n=>n!=='.'&&n!=='..').flatMap(n=>{
    const c=p+'/'+n;return Module.FS.isDir(Module.FS.stat(c).mode)?walk(c):[c];}):[];
  return walk(path);
},path);
test('a batch with one invalid file publishes none of its files',async({page})=>{
  await start(page);
  const before=await listing(page,'/user/imports');
  const result=await page.evaluate(async scale=>{
    try{await SurgeBrowser.importFiles([new File([scale],'ok.scl'),new File(['not a mapping'],'bad.kbm')]);return 'accepted';}
    catch(error){return String(error);}
  },scale);
  expect(result).toContain('Invalid bad.kbm');expect(result).toContain('Invalid tuning file');
  expect(await listing(page,'/user/imports')).toEqual(before);
  const accepted=await page.evaluate(async scale=>SurgeBrowser.importFiles([new File([scale],'ok.scl')]),scale);
  expect(accepted).toHaveLength(1);expect(accepted[0]).toMatch(/\/ok\.scl$/);
});
for(const [name,text,message] of [['broken.modpreset','<lfo><params>','Invalid modulator preset'],
  ['broken.srgfx','<not-fx/>','Invalid FX preset'],['broken.wt','vawt'+'\0'.repeat(8),'Invalid wavetable dimensions']])
  test(`${name} is rejected before the application sees it`,async({page})=>{
    await start(page);
    const result=await page.evaluate(async ([name,text])=>SurgeBrowser.importFiles([new File([text],name)]).then(()=>'accepted',String),[name,text]);
    expect(result).toContain(message);
  });
test('a folder read that fails part-way leaves no partial copy',async({page})=>{
  await start(page);
  const result=await page.evaluate(async()=>{
    const file=(name,fail)=>({kind:'file',name,getFile:async()=>{if(fail)throw Error('Unreadable entry');return new File(['data'],name);}});
    const folder=(name,entries)=>({kind:'directory',name,values:async function*(){yield* entries;}});
    const handle=folder('Skin',[file('a.txt'),folder('Nested',[file('b.txt'),file('c.txt',true)])]);
    try{await SurgeBrowser.copyDirectory(handle,'/user/directories/transaction/Skin');return 'copied';}
    catch(error){return String(error);}
  });
  expect(result).toContain('Unreadable entry');
  expect(await page.evaluate(()=>Module.FS.analyzePath('/user/directories/transaction/Skin').exists)).toBe(false);
});
test('a failed folder download removes its new destination folder',async({page})=>{
  await start(page);
  await page.evaluate(()=>{
    Module.FS.mkdirTree('/user/Transaction');Module.FS.writeFile('/user/Transaction/one.txt','1');Module.FS.writeFile('/user/Transaction/two.txt','2');
    const entries=new Map();globalThis.removed=[];
    const directory=name=>({kind:'directory',name,entries:new Map(),
      keys:async function*(){yield* this.entries.keys();},
      getDirectoryHandle:async function(n){if(!this.entries.has(n))this.entries.set(n,directory(n));return this.entries.get(n);},
      getFileHandle:async function(n){let writes=0;const handle={kind:'file',name:n,createWritable:async()=>({write:async()=>{if(n==='two.txt')throw Error('Disk full');},close:async()=>{},abort:async()=>{}})};this.entries.set(n,handle);return handle;},
      removeEntry:async function(n,options){removed.push([n,options?.recursive]);this.entries.delete(n);}});
    const parent=directory('Destination');globalThis.destination=parent;
    window.showDirectoryPicker=async()=>parent;
  });
  await page.getByRole('button',{name:'User files',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'User files',exact:true});
  await dialog.getByRole('button',{name:'Open folder Transaction',exact:true}).click();
  await dialog.getByRole('button',{name:'Download this folder',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('Disk full');
  await expect(dialog.getByRole('alert')).not.toContainText('Written before the failure');
  expect(await page.evaluate(()=>[removed,[...destination.entries.keys()]])).toEqual([[['Transaction',true]],[]]);
});
