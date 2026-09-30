import {expect} from '../fixtures.js';

// Shared drivers for the original JUCE interface through the accessibility mirror.
// Mirrored nodes are not pointer targets, so clicks are dispatched directly.
export const patchName=page=>page.evaluate(()=>Module.ccall('surge_browser_patch_name','string',[],[]));
export async function start(page,patch){
  page.setDefaultTimeout(10000);await page.goto('/surge-xt-browser.html');
  await expect(page.getByRole('button',{name:'Main Menu',exact:true})).toBeAttached();
  if(!patch)return expect.poll(()=>patchName(page)).toBe('Init Saw');
  await page.evaluate(path=>Module.ccall('surge_browser_request_patch','number',['string'],[path]),patch);
  await expect.poll(()=>patchName(page)).toBe(patch.split('/').pop().replace(/\.fxp$/,''));
}
export const factoryPatch=path=>`/factory/patches_factory/${path}.fxp`;
export async function enableAudio(page){
  await page.getByRole('button',{name:'Enable audio',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>Module._surge_browser_audio_status())).toBe(2);
}
// Opens `opener` (a button name or locator), then each menu item in order.
export async function menu(page,opener,...path){
  await (typeof opener==='string'||opener instanceof RegExp?page.getByRole('button',{name:opener,exact:typeof opener==='string'}):opener).dispatchEvent('click');
  for(const name of path)await page.getByRole('menuitem',{name,exact:typeof name==='string'}).dispatchEvent('click');
}
export const mainMenu=(page,...path)=>menu(page,'Main Menu',...path);
export async function closeMenus(page){
  for(let i=0;i<8&&await page.getByRole('menu').count();++i){await page.keyboard.press('Escape');await page.evaluate(()=>SurgeAccessibility.update?.());}
  await expect(page.getByRole('menu')).toHaveCount(0);
}
// Lists the item names of the innermost open menu after opening `path`.
export async function menuItems(page,opener,...path){
  await menu(page,opener,...path);
  const menus=page.getByRole('menu');await expect(menus.first()).toBeAttached();
  const names=await menus.last().locator('[role^="menuitem"]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')||node.textContent));
  await closeMenus(page);return names;
}
export async function prompt(page,value,button='OK'){
  await page.getByRole('textbox',{name:'Value',exact:true}).fill(value);
  await page.getByRole('button',{name:button,exact:true}).dispatchEvent('click');
}
export const readText=(page,path)=>page.evaluate(path=>Module.FS.readFile(path,{encoding:'utf8'}),path);
export const exists=(page,path)=>page.evaluate(path=>Module.FS.analyzePath(path).exists,path);
// Saves through the original patch dialog and returns the patch XML text.
export async function savePatch(page,name,category='Browser Tests'){
  await page.getByRole('button',{name:'Save Patch',exact:true}).dispatchEvent('click');
  await page.getByRole('textbox',{name:'patch name',exact:true}).fill(name);
  await page.getByRole('textbox',{name:'patch category',exact:true}).fill(category);
  await page.getByRole('button',{name:'OK',exact:true}).dispatchEvent('click');
  const path=`/user/Patches/${category}/${name}.fxp`;
  await expect.poll(()=>exists(page,path)).toBe(true);
  return page.evaluate(path=>{
    const data=Module.FS.readFile(path),size=new DataView(data.buffer,data.byteOffset).getUint32(64,true);
    return new TextDecoder().decode(data.subarray(92,92+size)).replace(/\0+$/,'');
  },path);
}
// Returns {name: attributes} for every <param> or nested element in saved patch XML.
export const patchParameters=xml=>Object.fromEntries([...xml.matchAll(/<(\w+) ([^>]*?)\/?>/g)].map(([,name,attributes])=>
  [name,Object.fromEntries([...attributes.matchAll(/(\w+)="([^"]*)"/g)].map(([,key,value])=>[key,value]))]));
export async function reloadPersisted(page){
  await page.evaluate(()=>SurgeBrowser.flush());await page.reload();
  await expect(page.getByRole('button',{name:'Main Menu',exact:true})).toBeAttached();
}
// Replaces the File System Access pickers with in-memory handles.
export function stubOpenPicker(page,files){
  return page.evaluate(files=>{window.showOpenFilePicker=async()=>files.map(({name,text,base64})=>({kind:'file',name,
    getFile:async()=>new File([base64?Uint8Array.from(atob(base64),c=>c.charCodeAt(0)):text],name)}));},files);
}
export function stubSavePicker(page){
  return page.evaluate(()=>{window.__saved=[];window.showSaveFilePicker=async({suggestedName})=>({name:suggestedName,createWritable:async()=>{
    const chunks=[];return {write:async chunk=>{chunks.push(chunk);},close:async()=>{window.__saved.push({name:suggestedName,
      text:await new Blob(chunks).text()});}};}});});
}
export const saved=page=>page.evaluate(()=>window.__saved);
export async function focusCanvas(page){await page.locator('canvas').first().focus();}
