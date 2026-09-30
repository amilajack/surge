import {test,expect} from './fixtures.js';
import {readFileSync} from 'node:fs';
import {start,mainMenu,reloadPersisted} from './helpers/ui.js';
const fxp=[...readFileSync(new URL('../../resources/data/patches_factory/Templates/Init FM2.fxp',import.meta.url))];
const count=page=>page.evaluate(()=>Module._surge_browser_patch_count());
const userPatches=page=>page.evaluate(()=>{
  const walk=p=>Module.FS.readdir(p).filter(n=>n!=='.'&&n!=='..').flatMap(n=>{const c=p+'/'+n;return Module.FS.isDir(Module.FS.stat(c).mode)?walk(c):[c];});
  return walk('/user/directories').filter(p=>p.endsWith('.fxp'));
});
test('a custom user data folder is imported, scanned, persisted and rescanned',async({page})=>{
  test.setTimeout(90000);
  await start(page);
  const factoryOnly=await count(page);
  await page.evaluate(bytes=>{
    const file=name=>({kind:'file',name,getFile:async()=>new File([new Uint8Array(bytes)],name)});
    const folder=(name,entries)=>({kind:'directory',name,values:async function*(){yield* entries;}});
    const root=folder('My Surge Data',[folder('Patches',[folder('Folder Category',[file('Folder Patch.fxp'),file('Second Patch.fxp')])])]);
    window.showDirectoryPicker=async()=>root;
  },fxp);
  await mainMenu(page,'Data Folders','Set Custom User Data Folder...');
  await expect.poll(()=>count(page)).toBe(factoryOnly+2);
  const patches=await userPatches(page);
  expect(patches.map(p=>p.split('/').slice(-3).join('/')).sort()).toEqual(['Patches/Folder Category/Folder Patch.fxp','Patches/Folder Category/Second Patch.fxp']);
  // The chosen folder's patches load like any user patch.
  await page.evaluate(path=>Module.ccall('surge_browser_request_patch','number',['string'],[path]),patches[0]);
  await expect.poll(()=>page.evaluate(()=>Module.ccall('surge_browser_patch_name','string',[],[]))).toMatch(/Folder Patch|Second Patch/);
  // The override survives a reload: the same folder is scanned at startup.
  await reloadPersisted(page);
  await expect.poll(()=>count(page)).toBe(factoryOnly+2);
  // Rescan picks up a file added to the folder since the last scan.
  await page.evaluate(([path,bytes])=>Module.FS.writeFile(path.replace(/[^/]+$/,'Added Later.fxp'),new Uint8Array(bytes)),[patches[0],fxp]);
  await mainMenu(page,'Data Folders','Rescan All Data Folders');
  await expect.poll(()=>count(page)).toBe(factoryOnly+3);
});
