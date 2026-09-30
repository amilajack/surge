import {test,expect} from './fixtures.js';
import {readFileSync} from 'node:fs';
import {start,patchName,savePatch,prompt,reloadPersisted,stubSavePicker,saved,exists} from './helpers/ui.js';
// The original patch browser menu (PatchSelector.cpp), opened from the patch name strip.
// Section headers are exposed twice (label and item); drop repeats.
const items=page=>page.getByRole('menu').last().locator('[role^=menuitem]').evaluateAll(n=>n.map(x=>x.getAttribute('aria-label')).filter((l,i,a)=>l!==a[i-1]));
async function closeMenus(page){for(let i=0;i<8&&await page.getByRole('menu').count();++i){await page.keyboard.press('Escape');await page.waitForTimeout(80);}}
const css=text=>text.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
async function open(page,...path){
  await closeMenus(page);
  await expect(async()=>{
    const box=await page.getByRole('group',{name:'Patch Selector',exact:true}).boundingBox();
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});
  }).toPass();
  for(const name of path){
    const before=JSON.stringify(await items(page));
    const item=page.getByRole('menu').last().locator(`[aria-label="${css(name)}"],[aria-label="${css(name)} (Checked)"]`).first();
    await expect(item,name).toBeAttached();await item.dispatchEvent('click');
    await expect.poll(async()=>JSON.stringify(await items(page)),name).not.toBe(before);
  }
  return items(page);
}
async function choose(page,path,label){
  await open(page,...path);
  const item=page.getByRole('menu').last().locator(`[aria-label="${css(label)}"],[aria-label="${css(label)} (Checked)"]`).first();
  await expect(item,[...path,label].join(' > ')).toBeAttached();await item.dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);
}
const sine=[...readFileSync(new URL('../../resources/data/patches_factory/Templates/Init Sine.fxp',import.meta.url))];

test('category submenus load factory, third-party and tutorial patches',async({page})=>{
  test.setTimeout(90000);
  await start(page);
  const top=await open(page);
  // The current category carries the checkmark; the others do not.
  expect(top).toContain('Templates (Checked)');
  for(const name of ['Basses','Leads','Pads','Kuniklo','Tutorials','Initialize Patch','Refresh Patch Browser'])expect(top).toContain(name);
  // The patch database overlay is compiled out of the original (INCLUDE_PATCH_BROWSER is never defined).
  expect(top.filter(l=>/Patch Database/.test(l))).toEqual([]);
  expect(await open(page,'Templates')).toContain('Init Saw (Checked)');
  await choose(page,['Templates'],'Init FM2');await expect.poll(()=>patchName(page)).toBe('Init FM2');
  const leads=await open(page,'Leads');expect(leads.length).toBeGreaterThan(10);
  await choose(page,['Leads'],leads[0]);await expect.poll(()=>patchName(page)).toBe(leads[0]);
  expect(await open(page)).toContain('Leads (Checked)');
  // Third-party folders nest subcategories inside the author's submenu.
  expect(await open(page,'Kuniklo')).toEqual(['Arps','Basses','FX','Leads','Organs','Pads','Sequences']);
  const third=await open(page,'Kuniklo','Arps');
  await choose(page,['Kuniklo','Arps'],third[0]);await expect.poll(()=>patchName(page)).toBe(third[0]);
  // The factory tutorials sit in a Formula Modulator subfolder.
  expect(await open(page,'Tutorials')).toEqual(['Formula Modulator']);
  const lessons=await open(page,'Tutorials','Formula Modulator');expect(lessons[0]).toBe('01 A Simple Formula');
  await choose(page,['Tutorials','Formula Modulator'],lessons[0]);await expect.poll(()=>patchName(page)).toBe(lessons[0]);
});

test('initialize, default, save and load-from-file functions',async({page})=>{
  test.setTimeout(90000);
  await start(page);
  await choose(page,['Templates'],'Init FM2');await expect.poll(()=>patchName(page)).toBe('Init FM2');
  await choose(page,[],'Initialize Patch');await expect.poll(()=>patchName(page)).toBe('Init Saw');
  // Set Current Patch as Default changes the startup patch and Initialize Patch.
  await choose(page,['Templates'],'Init Sine');await expect.poll(()=>patchName(page)).toBe('Init Sine');
  await choose(page,[],'Set Current Patch as Default');
  await reloadPersisted(page);await expect.poll(()=>patchName(page)).toBe('Init Sine');
  await choose(page,['Templates'],'Init FM2');await expect.poll(()=>patchName(page)).toBe('Init FM2');
  await choose(page,[],'Initialize Patch');await expect.poll(()=>patchName(page)).toBe('Init Sine');
  await choose(page,['Templates'],'Init Saw');await expect.poll(()=>patchName(page)).toBe('Init Saw');
  await choose(page,[],'Set Current Patch as Default');
  // Save Patch opens the original save dialog.
  await choose(page,[],'Save Patch');
  await expect(page.getByRole('textbox',{name:'patch name',exact:true})).toBeAttached();
  await page.getByRole('button',{name:'Cancel',exact:true}).dispatchEvent('click');
  await expect(page.getByRole('textbox',{name:'patch name',exact:true})).toHaveCount(0);
  // Load Patch from File uses the browser file picker and keeps the previous patch on the undo stack.
  await page.evaluate(bytes=>{window.showOpenFilePicker=async()=>[{kind:'file',name:'Picked.fxp',getFile:async()=>new File([new Uint8Array(bytes)],'Picked.fxp')}];},sine);
  await choose(page,[],'Load Patch from File...');await expect.poll(()=>patchName(page)).toBe('Picked');
  await page.getByRole('button',{name:'Undo',exact:true}).dispatchEvent('click');
  await expect.poll(()=>patchName(page)).toBe('Init Saw');
});

test('user patch rename, delete and refresh',async({page})=>{
  test.setTimeout(90000);
  await start(page);
  await savePatch(page,'Menu Original','Menu Tests');
  // Rename and Delete appear only for user patches.
  expect(await open(page)).toEqual(expect.arrayContaining(['Rename Patch...','Delete Patch']));
  await choose(page,[],'Rename Patch...');
  const name=page.getByRole('textbox',{name:'patch name',exact:true});
  await expect(name).toHaveValue('Menu Original');await name.fill('Menu Renamed');
  await page.getByRole('button',{name:'OK',exact:true}).dispatchEvent('click');
  await expect.poll(()=>exists(page,'/user/Patches/Menu Tests/Menu Renamed.fxp')).toBe(true);
  await expect.poll(()=>exists(page,'/user/Patches/Menu Tests/Menu Original.fxp')).toBe(false);
  await expect.poll(async()=>{const l=await open(page,'Menu Tests');await closeMenus(page);return l;}).toEqual(['Menu Renamed']);
  await choose(page,['Menu Tests'],'Menu Renamed');await expect.poll(()=>patchName(page)).toBe('Menu Renamed');
  await choose(page,[],'Delete Patch');
  await page.getByRole('button',{name:'OK',exact:true}).dispatchEvent('click');
  await expect.poll(()=>exists(page,'/user/Patches/Menu Tests/Menu Renamed.fxp')).toBe(false);
  await expect.poll(async()=>{const l=await open(page);await closeMenus(page);return l;}).not.toContain('Menu Tests');
  expect(await open(page)).not.toContain('Delete Patch');
  // A patch written outside the menu appears after Refresh Patch Browser.
  await page.evaluate(bytes=>{Module.FS.mkdirTree('/user/Patches/Outside');Module.FS.writeFile('/user/Patches/Outside/Outside Patch.fxp',new Uint8Array(bytes));},sine);
  await choose(page,[],'Refresh Patch Browser');
  // The deleted patch's index now falls on the new patch, so it may carry the checkmark (as on desktop).
  await expect.poll(async()=>{const l=await open(page);await closeMenus(page);return l.some(x=>/^Outside( \(Checked\))?$/.test(x));}).toBe(true);
  await choose(page,['Outside'],'Outside Patch');await expect.poll(()=>patchName(page)).toBe('Outside Patch');
});

test('favorites submenu and favorites button menu load, export and import favorites',async({page})=>{
  test.setTimeout(90000);
  await start(page);
  await savePatch(page,'Menu Favorite','Menu Tests');
  await page.getByRole('button',{name:'Add to Favorites',exact:true}).dispatchEvent('click');
  await choose(page,['Templates'],'Init FM2');await expect.poll(()=>patchName(page)).toBe('Init FM2');
  await page.getByRole('button',{name:'Add to Favorites',exact:true}).dispatchEvent('click');
  // In the patch menu, favorites sit in a submenu next to the user patches.
  expect(await open(page,'Favorites')).toEqual(['Init FM2','Menu Favorite','Export favorites to...','Load favorites from...']);
  await choose(page,['Favorites'],'Menu Favorite');await expect.poll(()=>patchName(page)).toBe('Menu Favorite');
  await stubSavePicker(page);
  await choose(page,['Favorites'],'Export favorites to...');
  await expect.poll(async()=>(await saved(page))?.length).toBe(1);
  const exported=(await saved(page))[0].text;
  expect(exported.split('\n').filter(Boolean).sort()).toEqual(['FACTORY:patches_factory/Templates/Init FM2.fxp','USER:Menu Tests/Menu Favorite.fxp']);
  // Clear both favorites, then import them back from the exported file.
  await page.getByRole('button',{name:'Remove from Favorites',exact:true}).dispatchEvent('click');
  await choose(page,['Favorites'],'Init FM2');await expect.poll(()=>patchName(page)).toBe('Init FM2');
  await page.getByRole('button',{name:'Remove from Favorites',exact:true}).dispatchEvent('click');
  await expect.poll(async()=>{const l=await open(page);await closeMenus(page);return l;}).not.toContain('Favorites');
  const importFrom=async()=>page.evaluate(text=>{window.showOpenFilePicker=async()=>[{kind:'file',name:'Browser.surgefav',getFile:async()=>new File([text],'Browser.surgefav')}];},exported);
  // The favorites button menu offers the same functions without a submenu.
  await page.getByRole('button',{name:'Add to Favorites',exact:true}).dispatchEvent('click');
  await page.getByRole('button',{name:'Remove from Favorites',exact:true}).focus();await page.keyboard.press('Shift+F10');
  await expect.poll(()=>items(page)).toEqual(['FAVORITES','Init FM2','Export favorites to...','Load favorites from...']);
  await importFrom();
  await page.getByRole('menu').last().locator('[aria-label="Load favorites from..."]').dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect.poll(async()=>{const l=await open(page,'Favorites');await closeMenus(page);return l;}).toEqual(['Init FM2','Menu Favorite','Export favorites to...','Load favorites from...']);
  await page.getByRole('button',{name:'Remove from Favorites',exact:true}).focus();await page.keyboard.press('Shift+F10');
  await expect.poll(()=>items(page)).toEqual(['FAVORITES','Init FM2','Menu Favorite','Export favorites to...','Load favorites from...']);
  await stubSavePicker(page);
  await page.getByRole('menu').last().locator('[aria-label="Export favorites to..."]').dispatchEvent('click');
  await expect.poll(async()=>(await saved(page))?.length).toBe(1);
  expect((await saved(page))[0].text).toBe(exported);
  await page.getByRole('menu').count().then(n=>n&&closeMenus(page));
  await page.getByRole('button',{name:'Remove from Favorites',exact:true}).focus();await page.keyboard.press('Shift+F10');
  await page.getByRole('menu').last().locator('[aria-label="Menu Favorite"]').dispatchEvent('click');
  await expect.poll(()=>patchName(page)).toBe('Menu Favorite');
});
