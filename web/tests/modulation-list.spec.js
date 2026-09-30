import {test,expect} from './fixtures.js';
import {start,savePatch,mainMenu} from './helpers/ui.js';
// The original modulation list overlay (ModulationEditor.cpp) and the accessible
// modulation submenus of parameter menus (MenuCustomComponents.cpp).
const css=text=>text.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
const items=page=>page.getByRole('menu').last().locator('[role^=menuitem]').evaluateAll(n=>n.map(x=>x.getAttribute('aria-label')).filter((l,i,a)=>l!==a[i-1]));
async function closeMenus(page){
  if(!await page.getByRole('menu').count())return;
  await page.waitForTimeout(300);
  for(let i=0;i<8&&await page.getByRole('menu').count();++i){await page.keyboard.press('Escape');await page.waitForTimeout(150);}
  await expect(page.getByRole('menu')).toHaveCount(0);
}
// Opens a menu from `open` and follows `path`; [label, n] picks the n-th item with that label.
async function menu(page,open,...path){
  await closeMenus(page);
  await expect(async()=>{await open();await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});}).toPass();
  await page.waitForTimeout(300);
  for(const step of path){
    const [name,n]=Array.isArray(step)?step:[step,0];
    const before=JSON.stringify(await items(page));
    const item=page.getByRole('menu').last().locator(`[aria-label="${css(name)}"],[aria-label="${css(name)} (Checked)"]`).nth(n);
    await expect(item,name).toBeAttached();await item.dispatchEvent('click');
    await expect.poll(async()=>JSON.stringify(await items(page)),name).not.toBe(before);
  }
  return items(page);
}
async function pick(page,open,path,label){
  await menu(page,open,...path);
  const item=page.getByRole('menu').last().locator(`[aria-label="${css(label)}"],[aria-label="${css(label)} (Checked)"]`).first();
  await expect(item,label).toBeAttached();await item.dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);await page.waitForTimeout(300);
}
let saves=0;
const save=page=>savePatch(page,`Mod List ${Date.now()%100000}-${++saves}`);
const routes=(xml,param)=>[...(xml.match(new RegExp(`<${param}[^>]*>([\\s\\S]*?)</${param}>`))?.[1]??'').matchAll(/<modrouting[^>]*>/g)].map(m=>m[0]);
const list=page=>page.getByRole('group',{name:'Modulation List',exact:true}).first();
// Buttons are retitled after their selection (e.g. "Add Modulation Source: Macro 1").
const button=(page,name)=>list(page).getByRole('button',{name:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).first();
// Each routing row is a group named "Source: X to  Target: Y".
const rows=page=>list(page).locator('[role=group][aria-label^="Source: "]').evaluateAll(n=>n.map(x=>x.getAttribute('aria-label')));

test('modulation list adds routings from every source group and filters them',async({page})=>{
  test.setTimeout(180000);
  await start(page);
  await page.locator('canvas').first().focus();await page.keyboard.press('Alt+m');
  await expect(list(page)).toBeAttached();
  const addSource=()=>button(page,'Add Modulation Source').dispatchEvent('click');
  const addTarget=()=>button(page,'Add Modulation Target').dispatchEvent('click');
  // Source groups: global, then scene A and scene B.
  const root=await menu(page,addSource);
  expect(root.filter(l=>!/open manual/.test(l))).toEqual(['GLOBAL','Macros','MIDI','Internal','SCENE A','Voice LFOs','Scene LFOs','Envelopes','MIDI','SCENE B','Voice LFOs','Scene LFOs','Envelopes','MIDI']);
  expect(await menu(page,addSource,'Macros')).toEqual(['Macro 1','Macro 2','Macro 3','Macro 4','Macro 5','Macro 6','Macro 7','Macro 8']);
  expect(await menu(page,addSource,'Internal')).toEqual(expect.arrayContaining(['Random Bipolar','Alternate Bipolar']));
  expect(await menu(page,addSource,'Voice LFOs')).toEqual(['Voice LFO 1','Voice LFO 2','Voice LFO 3','Voice LFO 4','Voice LFO 5','Voice LFO 6']);
  expect(await menu(page,addSource,'Voice LFOs','Voice LFO 1')).toEqual(['Voice LFO 1','Voice LFO 1 (Raw Waveform)','Voice LFO 1 (EG Only)']);
  // Targets: sections (global, scene A, scene B), then control groups, then parameters.
  // The target button is enabled once a source is chosen.
  await pick(page,addSource,['Macros'],'Macro 1');
  const targets=await menu(page,addTarget);
  for(const name of ['GLOBAL','SCENE A','SCENE B','Oscillators','Mixer','Filters','Envelopes','Voice LFOs','Scene LFOs'])expect(targets,name).toContain(name);
  await closeMenus(page);
  const add=async(sourcePath,source,targetPath,target)=>{
    await pick(page,addSource,sourcePath,source);
    await pick(page,addTarget,targetPath,target);
  };
  const cases=[
    [[['Macros',0]],'Macro 2',[['Oscillators',0],'Osc 1 (Classic)'],'Osc 1 Pitch'],
    [[['Macros',0]],'Macro 3',[['Patch',0]],'Global Volume'],
    [[['Voice LFOs',0],'Voice LFO 1'],'Voice LFO 1 (EG Only)',[['Filters',0],'Filter 1 (Off)'],'Filter 1 Cutoff'],
    [[['Scene LFOs',0],'Scene LFO 2'],'Scene LFO 2',[['Filters',0],'Filter 1 (Off)'],'Filter 1 Resonance'],
    [[['Envelopes',0]],'Filter EG',[['Filters',0],'Filter 2 (Off)'],'Filter 2 Cutoff'],
    [[['MIDI',0]],'Velocity',[['Envelopes',0],'AEG'],'Amp EG Attack'],
    [[['MIDI',1]],'Latest Key',[['Envelopes',0],'AEG'],'Amp EG Decay'],
    [[['MIDI',0]],'Modwheel',[['Oscillators',0],'Osc 1 (Classic)'],'Osc 1 Pitch'],
    [[['Internal',0],'Random Bipolar'],'Random Bipolar (Normal)',[['Mixer',0]],'Osc 1 Volume'],
    [[['Internal',0]],'Alternate Bipolar',[['Scene',0]],'Pan'],
    // A scene B source offers only global and scene B targets.
    [[['Voice LFOs',1],'Voice LFO 1'],'Voice LFO 1',[['Oscillators',0],'Osc 2 (Classic)'],'Osc 2 Pitch'],
  ];
  expect(await menu(page,addSource,['MIDI',1])).toEqual(['Lowest Key','Highest Key','Latest Key']);await closeMenus(page);
  for(const c of cases)await add(...c);
  const xml=await save(page);
  expect((xml.match(/<modrouting /g)||[]).length).toBe(cases.length);
  expect(routes(xml,'a_osc1_pitch').length).toBe(2);expect(routes(xml,'b_osc2_pitch').length).toBe(1);
  // Filters: by source, target, target section, target scene, then clear.
  // The filter button is retitled after the current filter (e.g. "Filter By Source: Modwheel").
  const filter=()=>list(page).getByRole('button',{name:/^Filter /}).first().dispatchEvent('click');
  const filterMenu=await menu(page,filter);
  for(const name of ['BY SOURCE','BY TARGET','BY TARGET SECTION','BY TARGET SCENE','Macro 2','Modwheel','Global','Scene A','Scene B','Clear Filter'])expect(filterMenu,name).toContain(name);
  // An open menu hides the rest of the editor from assistive technology.
  await closeMenus(page);
  await expect.poll(async()=>(await rows(page)).length).toBe(cases.length);const all=cases.length;
  const target=r=>r.split('Target: ')[1];
  for(const [label,nth,check] of [
    ['Modwheel',0,r=>r.startsWith('Source: Modwheel ')],
    ['A Osc 1 Pitch',0,r=>target(r)==='A Osc 1 Pitch'],
    ['Filters',0,r=>/Filter \d/.test(target(r))],
    ['Scene B',0,r=>target(r).startsWith('B ')],
    ['Global',1,r=>!/^[AB] /.test(target(r))]]){
    await menu(page,filter);
    await page.getByRole('menu').last().locator(`[aria-label="${label}"]`).nth(nth).dispatchEvent('click');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(async()=>{const r=await rows(page);return r.length>0&&r.length<all&&r.every(check);},label).toBe(true);
  }
  await pick(page,filter,[],'Clear Filter');
  await expect.poll(async()=>(await rows(page)).length).toBe(all);
});

test('modulation list rows, sorting and clipboard export',async({page,context})=>{
  test.setTimeout(120000);
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await start(page);
  const target=page.locator('#juce-accessibility [aria-label="Scene A Osc 1 Pitch"]').first();
  const open=async()=>{const b=await target.boundingBox();await page.mouse.click(b.x+b.width/2,b.y+b.height/2,{button:'right'});};
  for(const source of ['Velocity','Modwheel']){
    await pick(page,open,['Add Modulation from','MIDI'],source);
    const field=page.getByRole('textbox',{name:'New Value',exact:true});await field.fill('4');await field.press('Enter');await expect(field).toHaveCount(0);
  }
  await pick(page,async()=>{const b=await page.locator('#juce-accessibility [aria-label="Scene A Amp EG Attack"]').first().boundingBox();await page.mouse.click(b.x+b.width/2,b.y+b.height/2,{button:'right'});},['Add Modulation from','Macros'],'Macro 1');
  {const f=page.getByRole('textbox',{name:'New Value',exact:true});await f.fill('10');await f.press('Enter');await expect(f).toHaveCount(0);}
  await page.locator('canvas').first().focus();await page.keyboard.press('Alt+m');
  await expect(list(page)).toBeAttached();
  await expect.poll(async()=>(await rows(page)).length).toBe(3);
  // Sorting orders rows by target parameter or by source, in the synth's own order.
  await list(page).getByRole('radio',{name:'Target',exact:true}).dispatchEvent('click');
  await expect.poll(async()=>(await rows(page)).map(r=>r.split('Target: ')[1])).toEqual(['A Osc 1 Pitch','A Osc 1 Pitch','A Amp EG Attack']);
  await list(page).getByRole('radio',{name:'Source',exact:true}).dispatchEvent('click');
  await expect.poll(async()=>(await rows(page)).map(r=>r.split(' to ')[0].replace('Source: ',''))).toEqual(['Velocity','Modwheel','Attack (Macro 1)']); // An unnamed macro takes its first target's name.
  // Copy to Clipboard exports the routings as text.
  await button(page,'Copy to Clipboard').dispatchEvent('click');
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('Modwheel');
  const text=await page.evaluate(()=>navigator.clipboard.readText());
  for(const name of ['Velocity','Macro 1','Osc 1 Pitch','Amp EG Attack'])expect(text,name).toContain(name);
  // Row controls: depth, mute, edit and clear.
  const row='Modwheel to A Osc 1 Pitch';
  const depth=list(page).getByRole('slider',{name:'Depth '+row,exact:true});
  const before=await depth.getAttribute('aria-valuenow');
  await depth.focus();await page.locator('canvas').first().focus();await page.keyboard.press('End');
  await expect.poll(()=>depth.getAttribute('aria-valuenow')).not.toBe(before);
  await list(page).getByRole('button',{name:'Mute '+row,exact:true}).dispatchEvent('click');
  // The original retitles the button "UnMute ..." while muted.
  await expect(list(page).getByRole('button',{name:'UnMute '+row,exact:true})).toBeAttached();
  await list(page).getByRole('button',{name:'Edit '+row,exact:true}).dispatchEvent('click');
  {const f=page.getByRole('textbox',{name:'New Value',exact:true});await f.fill('7');await f.press('Enter');await expect(f).toHaveCount(0);}
  await list(page).getByRole('button',{name:'Clear '+row,exact:true}).dispatchEvent('click');
  await expect.poll(async()=>(await rows(page)).length).toBe(2);
  await closeMenus(page);
  const xml=await save(page);
  expect(routes(xml,'a_osc1_pitch').length).toBe(1);expect(routes(xml,'a_env1_attack').length).toBe(1);
});

test('accessible modulation submenus edit, mute and clear routings',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  await mainMenu(page,'Accessibility','Add Sub-Menus for Modulation Menu Items');
  const target=page.locator('#juce-accessibility [aria-label="Scene A Osc 1 Pitch"]').first();
  const open=async()=>{const b=await target.boundingBox();await page.mouse.click(b.x+b.width/2,b.y+b.height/2,{button:'right'});};
  for(const source of ['Velocity','Modwheel']){
    await pick(page,open,['Add Modulation from','MIDI'],source);
    const field=page.getByRole('textbox',{name:'New Value',exact:true});await field.fill('4');await field.press('Enter');await expect(field).toHaveCount(0);
  }
  const top=await menu(page,open);
  const velocity=top.find(l=>/^From Velocity by /.test(l)),all=top.find(l=>l==='Apply to all modulations');
  expect(velocity,JSON.stringify(top)).toBeTruthy();expect(all,JSON.stringify(top)).toBeTruthy();
  expect(await menu(page,open,velocity)).toEqual(['Edit Velocity','Mute Velocity','Clear Velocity']);
  expect(await menu(page,open,all)).toEqual(['Mute All Modulations','Unmute All Modulations','Clear All Modulations']);
  // Edit opens the modulation depth type-in.
  await pick(page,open,[velocity],'Edit Velocity');
  const field=page.getByRole('textbox',{name:'New Value',exact:true});await field.fill('6');await field.press('Enter');await expect(field).toHaveCount(0);
  // The row label follows the new depth.
  const current=async pattern=>(await menu(page,open)).find(l=>pattern.test(l));
  expect(await current(/^From Velocity by /)).toBe('From Velocity by 6.00 semitones');
  await pick(page,open,[await current(/^From Velocity by /)],'Mute Velocity');
  let xml=await save(page);
  expect(routes(xml,'a_osc1_pitch').filter(r=>/muted="1"/.test(r)).length).toBe(1);
  expect(await menu(page,open,(await menu(page,open)).find(l=>/^From Velocity by /.test(l)))).toContain('Unmute Velocity');
  await pick(page,open,[(await menu(page,open)).find(l=>/^From Velocity by /.test(l))],'Unmute Velocity');
  await pick(page,open,[all],'Mute All Modulations');
  xml=await save(page);expect(routes(xml,'a_osc1_pitch').filter(r=>/muted="1"/.test(r)).length).toBe(2);
  await pick(page,open,[(await menu(page,open)).find(l=>l==='Apply to all modulations')],'Unmute All Modulations');
  xml=await save(page);expect(routes(xml,'a_osc1_pitch').filter(r=>/muted="1"/.test(r)).length).toBe(0);
  // With a third routing, clearing one leaves the all-modulations row.
  await pick(page,open,['Add Modulation from','MIDI'],'Keytrack');
  {const f=page.getByRole('textbox',{name:'New Value',exact:true});await f.fill('2');await f.press('Enter');await expect(f).toHaveCount(0);}
  await pick(page,open,[(await menu(page,open)).find(l=>/^From Velocity by /.test(l))],'Clear Velocity');
  xml=await save(page);expect(routes(xml,'a_osc1_pitch').length).toBe(2);
  await pick(page,open,[(await menu(page,open)).find(l=>l==='Apply to all modulations')],'Clear All Modulations');
  xml=await save(page);expect(routes(xml,'a_osc1_pitch').length).toBe(0);
});
