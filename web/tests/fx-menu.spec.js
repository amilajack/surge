import {test,expect} from './fixtures.js';
import {start,prompt,exists} from './helpers/ui.js';
// The original FX and oscillator type menus (XMLConfiguredMenus.cpp).
const css=text=>text.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
const items=page=>page.getByRole('menu').last().locator('[role^=menuitem]').evaluateAll(n=>n.map(x=>x.getAttribute('aria-label')).filter((l,i,a)=>l!==a[i-1]));
async function closeMenus(page){
  if(!await page.getByRole('menu').count())return;
  await page.waitForTimeout(300);
  for(let i=0;i<8&&await page.getByRole('menu').count();++i){await page.keyboard.press('Escape');await page.waitForTimeout(150);}
  await expect(page.getByRole('menu')).toHaveCount(0);
}
const slot=(page,name)=>page.getByRole('radio',{name:new RegExp('^'+name+':')});
async function select(page,name){
  await closeMenus(page);
  const radio=slot(page,name);await radio.dispatchEvent('click');await expect(radio).toHaveAttribute('aria-checked','true');
  await page.waitForTimeout(300); // The FX Type button follows the newly selected slot.
}
// The dropdown below the FX grid; with an effect loaded it lists only that effect's presets.
async function openDropdown(page){
  await expect(async()=>{
    await page.getByRole('button',{name:'FX Type',exact:true}).dispatchEvent('click');
    await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});
  }).toPass();
}
// A right click on the selected slot opens the full FX browser.
async function openGrid(page){
  let current=null;
  for(const radio of await page.getByRole('radio').all())
    if(/Insert FX|Send FX|Global FX/.test(await radio.getAttribute('aria-label'))&&await radio.getAttribute('aria-checked')==='true'){current=radio;break;}
  await expect(async()=>{
    const b=await current.boundingBox();
    await page.mouse.click(b.x+b.width/2,b.y+b.height/2,{button:'right'});
    await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});
  }).toPass();
}
async function fxMenu(page,...path){
  await closeMenus(page);
  const grid=path[0]==='grid';if(grid||path[0]==='dropdown')path=path.slice(1);
  await (grid?openGrid:openDropdown)(page);
  await page.waitForTimeout(300);
  for(const name of path){
    const before=JSON.stringify(await items(page));
    const item=page.getByRole('menu').last().locator(`[aria-label="${css(name)}"],[aria-label="${css(name)} (Checked)"]`).first();
    await expect(item,name).toBeAttached();await item.dispatchEvent('click');
    await expect.poll(async()=>JSON.stringify(await items(page)),name).not.toBe(before);
  }
  return items(page);
}
async function choose(page,path,label){
  await fxMenu(page,...path);
  const item=page.getByRole('menu').last().locator(`[aria-label="${css(label)}"],[aria-label="${css(label)} (Checked)"]`).first();
  await expect(item,label).toBeAttached();await item.dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);await page.waitForTimeout(300);
}
const slotName=async(page,name)=>(await slot(page,name).getAttribute('aria-label')).replace(/^[^:]*:\s*/,'');

test('FX type folders, factory and user presets, save and delete',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  await select(page,'A Insert FX 1');
  // An empty slot's dropdown shows the full browser: type folders and functions.
  const types=await fxMenu(page);
  for(const name of ['EQ','Bonsai','Combulator','Chorus','Delay','Reverb 2','Airwindows','FUNCTIONS'])expect(types).toContain(name);
  expect(await fxMenu(page,'Reverb 2')).toEqual(expect.arrayContaining(['Init (Dry)','Back Room']));
  await choose(page,['Reverb 2'],'Back Room');
  expect(await slotName(page,'A Insert FX 1')).toMatch(/Reverb 2/);
  // In the grid browser the loaded type's folder is ticked.
  expect(await fxMenu(page,'grid')).toContain('Reverb 2 (Checked)');
  // With an effect loaded, the dropdown lists only its presets.
  const presets=await fxMenu(page);
  expect(presets).toEqual(expect.arrayContaining(['FACTORY PRESETS','Back Room','Save FX Preset As...','Copy FX Preset']));
  expect(presets).not.toContain('Bonsai');
  // Save a user preset; it appears in the user section and reloads.
  await choose(page,[],'Save FX Preset As...');await prompt(page,'Browser Room');
  await expect.poll(()=>exists(page,'/user/FX Presets/Reverb 2/Browser Room.srgfx')).toBe(true);
  await expect.poll(async()=>{const l=await fxMenu(page);await closeMenus(page);return l;}).toContain('Browser Room');
  expect(await fxMenu(page,'grid','Reverb 2')).toContain('Browser Room');
  await choose(page,[],'Back Room');
  expect(await fxMenu(page)).not.toContain('Delete FX Preset');
  await choose(page,[],'Browser Room');
  // Delete FX Preset is offered for the loaded user preset.
  await choose(page,[],'Delete FX Preset');
  await page.getByRole('button',{name:'OK',exact:true}).dispatchEvent('click');
  await expect.poll(()=>exists(page,'/user/FX Presets/Reverb 2/Browser Room.srgfx')).toBe(false);
  await expect.poll(async()=>{const l=await fxMenu(page);await closeMenus(page);return l;}).not.toContain('Browser Room');
});

test('FX slot copy, paste, deactivate, clear chain and clear all chains',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  await select(page,'A Insert FX 1');await choose(page,['Reverb 2'],'Back Room');
  const functions=await fxMenu(page,'grid');
  expect(functions).toEqual(expect.arrayContaining(['Deactivate Scene A, Insert FX Slot 1','Clear Scene A, Insert FX Slot 1','Clear Scene A Insert FX Chain','Clear All FX Chains','Save FX Preset As...','Save FX Chain Preset As...','Copy FX Preset','Copy FX Chain','Refresh FX Preset List']));
  expect(functions).not.toContain('Paste FX Preset');
  await choose(page,['grid'],'Copy FX Preset');
  await select(page,'A Insert FX 2');
  expect(await fxMenu(page,'grid')).toContain('Paste FX Preset');
  await choose(page,['grid'],'Paste FX Preset');
  await expect.poll(()=>slotName(page,'A Insert FX 2')).toMatch(/Reverb 2/);
  // Deactivation toggles the slot and the menu offers the reverse; the dropdown names the current slot.
  await choose(page,[],'Deactivate Current FX Slot');
  expect(await fxMenu(page,'grid')).toContain('Activate Scene A, Insert FX Slot 2');
  await choose(page,['grid'],'Activate Scene A, Insert FX Slot 2');
  expect(await fxMenu(page)).toContain('Deactivate Current FX Slot');
  // Clear the single slot.
  await choose(page,[],'Clear Current FX Slot');
  await expect.poll(()=>slotName(page,'A Insert FX 2')).toMatch(/Off/);
  // Clear the scene A chain only.
  await select(page,'B Insert FX 1');await choose(page,['Delay'],'Basic 1/4');
  await select(page,'A Insert FX 1');await choose(page,['grid'],'Clear Scene A Insert FX Chain');
  await expect.poll(()=>slotName(page,'A Insert FX 1')).toMatch(/Off/);
  expect(await slotName(page,'B Insert FX 1')).toMatch(/Delay/);
  // Clear All FX Chains clears every slot.
  await choose(page,['grid'],'Clear All FX Chains');
  await expect.poll(()=>slotName(page,'B Insert FX 1')).toMatch(/Off/);
});
test('oscillator type folders and factory presets',async({page})=>{
  await start(page);
  const node=name=>page.locator(`#juce-accessibility [aria-label="${css(name)}"]`).first();
  const oscMenu=async(...path)=>{
    await closeMenus(page);
    await expect(async()=>{
      await page.getByRole('button',{name:'Oscillator Type',exact:true}).dispatchEvent('click');
      await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});
    }).toPass();
    await page.waitForTimeout(800);
    // The current type's preset folder opens with the menu; step back to the type list.
    for(let i=0;i<3&&!(await items(page)).includes('Wavetable');i++){await page.keyboard.press('ArrowLeft');await page.waitForTimeout(350);}
    for(const name of path){
      const before=JSON.stringify(await items(page));
      const item=page.getByRole('menu').last().locator(`[aria-label="${css(name)}"],[aria-label="${css(name)} (Checked)"]`).first();
      await expect(item,name).toBeAttached();await item.dispatchEvent('click');
      await expect.poll(async()=>JSON.stringify(await items(page)),name).not.toBe(before);
    }
    return items(page);
  };
  const types=await oscMenu();
  expect(types).toEqual(expect.arrayContaining(['Classic (Checked)','Modern','Wavetable','Window','Sine','FM2','FM3','String','Twist','Alias','S&H Noise','Audio Input']));
  const presets=await oscMenu('Modern');
  expect(presets).toEqual(expect.arrayContaining(['Sawtooth','Square','Triangle','Sine']));
  const square=page.getByRole('menu').last().locator('[aria-label="Square"]').first();await square.dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(node('Scene A Osc 1 Sawtooth')).toBeAttached();
  expect(await oscMenu()).toContain('Modern (Checked)');
  await closeMenus(page);
});
