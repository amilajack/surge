import {test,expect} from './fixtures.js';
import {start,savePatch,patchParameters} from './helpers/ui.js';
// Every control the unchanged skin model places, checked through the editor's
// own component table (surge_browser_skin_controls) and the accessibility mirror.
const controls=async page=>JSON.parse(await page.evaluate(()=>Module.ccall('surge_browser_skin_controls','string',[],[])));
const node=(page,title)=>page.locator(`#juce-accessibility [aria-label="${title.replace(/"/g,'\\"')}"]`).first();

test('every skin-placed parameter control edits its parameter in the saved patch',async({page},testInfo)=>{
  test.setTimeout(240000);
  await start(page);
  // Scene selection is reviewed separately and would rename every scene control.
  const parameters=(await controls(page)).filter(c=>c.parameter&&c.id!=='global.active_scene');
  expect(parameters.length).toBeGreaterThan(100);
  const before=patchParameters(await savePatch(page,'Skin Before'));
  const edits=[];
  for(const control of parameters){
    const target=node(page,control.title);
    await expect(target,control.id).toBeAttached();
    expect(await target.evaluate(n=>n.getAttribute('aria-disabled'))).toBe('false');
    const role=await target.getAttribute('role');
    // Filter subtypes are click-to-cycle switches (their value is not set directly).
    if(role==='checkbox'||/^filter\.subtype_/.test(control.id)){await target.dispatchEvent('click');}
    else{
      const now=Number(await target.getAttribute('aria-valuenow')),max=Number(await target.getAttribute('aria-valuemax'));
      // A filter type with subtypes (one step up from Off), so the subtype edit that follows changes too.
      await target.focus();await page.keyboard.press(/^filter\.type_/.test(control.id)?'ArrowUp':now<max?'End':'Home');
      // Let the 250 ms accessibility snapshot publish the new type's subtype range.
      if(/^filter\.type_/.test(control.id))await page.waitForTimeout(400);
    }
    edits.push({id:control.id,parameter:control.parameter,role});
  }
  const after=patchParameters(await savePatch(page,'Skin After'));
  const unchanged=edits.filter(edit=>before[edit.parameter]?.value===after[edit.parameter]?.value);
  await testInfo.attach('skin-parameter-edits',{body:JSON.stringify({edits,unchanged},null,2),contentType:'application/json'});
  expect(unchanged).toEqual([]);
});

async function clickControl(page,control,part=0.5){
  const [x,y,w,h]=control.bounds;await page.mouse.click(x+w*part,y+h/2);
}
const patchName=page=>page.evaluate(()=>Module.ccall('surge_browser_patch_name','string',[],[]));
async function closeMenus(page){for(let i=0;i<6&&await page.getByRole('menu').count();++i)await page.keyboard.press('Escape');await expect(page.getByRole('menu')).toHaveCount(0);}

test('skin-placed action, jog, status and selector controls perform their original actions',async({page})=>{
  test.setTimeout(180000);
  await start(page);
  const all=Object.fromEntries((await controls(page)).map(c=>[c.id,c]));
  const menuOpens=async id=>{await node(page,all[id].title).dispatchEvent('click');await expect(page.getByRole('menu').first(),id).toBeAttached();await closeMenus(page);};
  await menuOpens('controls.surge_menu');await menuOpens('lfo.presets');await menuOpens('controls.patch_browser');
  // Status toggles and the zoom menu.
  const status=name=>page.getByRole('checkbox',{name,exact:true});
  const mpe=status('MPE');await mpe.dispatchEvent('click');await expect(mpe).toHaveAttribute('aria-checked','true');
  await mpe.dispatchEvent('click');await expect(mpe).toHaveAttribute('aria-checked','false');
  await status('Zoom').dispatchEvent('click');await expect(page.getByRole('menuitemcheckbox',{name:'Zoom to 100% (Checked)',exact:true})).toBeAttached();await closeMenus(page);
  // With standard tuning the Tune status opens the original Tuning menu.
  await status('Tune').dispatchEvent('click');await expect(page.getByRole('menuitem',{name:'Load .scl Tuning...',exact:true})).toBeAttached();await closeMenus(page);
  // Oscillator selector.
  await node(page,'Oscillator Select').focus();await page.keyboard.press('End');
  await expect(node(page,'Scene A Osc 3 Pitch')).toBeAttached();await page.keyboard.press('Home');
  // Undo and redo buttons, after an edit through the slider's own key handling.
  const volume=node(page,'Global Volume'),value=()=>volume.getAttribute('aria-valuenow');
  await expect.poll(value).not.toBe('1');const before=await value();
  await volume.focus();await page.locator('canvas').first().focus();await page.keyboard.press('End');
  await expect.poll(value).not.toBe(before);const edited=await value();
  await clickControl(page,all['controls.action.undo']);await expect.poll(value).toBe(before);
  await clickControl(page,all['controls.action.redo']);await expect.poll(value).toBe(edited);
  // Patch and category jogs: the right half steps forward, the left half back.
  for(const id of ['controls.patch.prevnext','controls.category.prevnext']){
    const name=await patchName(page);
    await clickControl(page,all[id],0.75);await expect.poll(()=>patchName(page),id).not.toBe(name);
    const next=await patchName(page);
    await clickControl(page,all[id],0.75);await expect.poll(()=>patchName(page),id).not.toBe(next);
    await clickControl(page,all[id],0.25);await expect.poll(()=>patchName(page),id).toBe(next);
  }
  // Save button opens the original dialog.
  await node(page,'Save Patch').dispatchEvent('click');
  await expect(page.getByRole('textbox',{name:'patch name',exact:true})).toBeAttached();
  await page.getByRole('button',{name:'Cancel',exact:true}).dispatchEvent('click');
  // Menu-button selectors built by the editor for these connectors.
  for(const name of ['Oscillator Type','FX Type']){
    await node(page,name).dispatchEvent('click');await expect(page.getByRole('menu').first(),name).toBeAttached();await closeMenus(page);
  }
  const shaper=node(page,'Scene A Waveshaper Type'),shape=await shaper.getAttribute('aria-valuetext');
  expect(shape).toBeTruthy();
  // The waveshaper jog steps the type forward (right half) and back (left half).
  await clickControl(page,all['filter.waveshaper_prevnext'],0.75);await expect(shaper).not.toHaveAttribute('aria-valuetext',shape);
  await clickControl(page,all['filter.waveshaper_prevnext'],0.25);await expect(shaper).toHaveAttribute('aria-valuetext',shape);
  await expect(page.getByRole('group',{name:'LFO Type',exact:true})).toBeAttached();
  await expect(page.getByRole('radio',{name:'MSEG',exact:true})).toBeAttached();
});

const groupBounds=(page,name)=>page.getByRole('group',{name,exact:true}).first().evaluate(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(Math.round);});
test('overlay window connectors place each editor at its skin rectangle',async({page})=>{
  test.setTimeout(180000);
  const {factoryPatch}=await import('./helpers/ui.js');
  const cases=[['modlist.window','Modulation List',p=>p.keyboard.press('Alt+m')],['oscilloscope.window','Oscilloscope',p=>p.keyboard.press('Alt+o')],
    ['tuningeditor.window',/^Tuning Editor/,p=>p.keyboard.press('Alt+t')],['wtseditor.window','Osc 1 Wavetable Script Editor',p=>p.keyboard.press('Alt+w')],
    ['filter.filter_analysis.window','Filter Analysis','filter.filter_preview'],['filter.waveshaper_analysis.window','Waveshaper Analysis','filter.waveshaper_preview'],
    ['msegeditor.window','Voice MSEG 1 Editor','MSEG'],['formulaeditor.window','Voice Formula 1 Editor','Formula']];
  for(const [id,name,open] of cases){
    await start(page,factoryPatch('Templates/Init Wavetable'));
    const all=Object.fromEntries((await controls(page)).map(c=>[c.id,c]));
    if(typeof open==='function'){await page.locator('canvas').first().focus();await open(page);}
    else if(all[open])await clickControl(page,all[open]);
    else{await page.getByRole('radio',{name:open,exact:true}).dispatchEvent('click');await page.locator('canvas').first().focus();await page.keyboard.press('Alt+e');}
    const group=page.getByRole('group',{name,exact:typeof name==='string'}).first();
    await expect(group,id).toBeAttached();
    await expect.poll(()=>group.evaluate(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(Math.round);}),id).toEqual(all[id].skin);
  }
  // The save dialog takes its size from its connector and is centred by the original overlay code.
  await start(page);const save=Object.fromEntries((await controls(page)).map(c=>[c.id,c]))['controls.patch.save.window'].skin;
  await page.getByRole('button',{name:'Save Patch',exact:true}).dispatchEvent('click');
  const field=page.getByRole('textbox',{name:'patch name',exact:true});await expect(field).toBeAttached();
  // Its content group excludes the 2 px border and the 16 px title bar, centred in the editor.
  const sizes=await page.evaluate(()=>[...document.querySelectorAll('#juce-accessibility [role=group]')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(Math.round);}));
  const editor=await page.locator('canvas').first().boundingBox();
  const centred=[(editor.width-save[2])/2+2,(editor.height-save[3])/2+16];
  expect(sizes.some(([x,y,w,h])=>w===save[2]-4&&h===save[3]-18&&Math.abs(x-centred[0])<=2&&Math.abs(y-centred[1])<=2)).toBe(true);
});

test('panel connectors anchor their child controls at the skin offsets',async({page})=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../../src/common/SkinModel.cpp',import.meta.url),'utf8');
  const children=[...source.matchAll(/Connector\s*\(\s*"([^"]+)"\s*,\s*(-?\d+)\s*,\s*(-?\d+)[^;]*?\.inParent\("([^"]+)"\)/g)]
    .map(([,id,x,y,parent])=>({id,x:Number(x),y:Number(y),parent}));
  await start(page);
  const all=Object.fromEntries((await controls(page)).map(c=>[c.id,c]));
  const checked={};
  // The editor lays out FX parameters (with section headers) and modulation source
  // buttons in code, starting at their panel origins.
  const modulation=all['controls.modulation.panel'].skin;
  for(const name of ['Macro 1','LFO 1','Velocity']){
    const box=await page.getByRole('group',{name,exact:true}).first().boundingBox();
    expect(box.x,name).toBeGreaterThanOrEqual(modulation[0]);expect(box.y,name).toBeGreaterThanOrEqual(modulation[1]);
    (checked['controls.modulation.panel']??=[]).push(name);
  }
  await page.getByRole('button',{name:'FX Type',exact:true}).dispatchEvent('click');
  await page.getByRole('menuitem',{name:'Delay',exact:true}).dispatchEvent('click');
  await page.getByRole('menuitem',{name:'Basic 1/4',exact:true}).dispatchEvent('click');
  await expect.poll(async()=>(await controls(page)).filter(c=>/^fx\.param_/.test(c.id)&&c.visible).length).toBeGreaterThan(8);
  const fxPanel=all['fx.param.panel'].skin;
  for(const control of (await controls(page)).filter(c=>/^fx\.param_/.test(c.id)&&c.visible)){
    expect(control.bounds[0],control.id).toBe(fxPanel[0]);expect(control.bounds[1],control.id).toBeGreaterThanOrEqual(fxPanel[1]);
    (checked['fx.param.panel']??=[]).push(control.id);
  }
  for(const child of children){
    const panel=all[child.parent],control=all[child.id];
    if(!panel||child.parent==='fx.param.panel'||!control?.bounds||!control.visible)continue;
    // The component sits at the position the skin engine resolved from its panel:
    // the panel origin plus the source offset (some component kinds add a fixed inset).
    expect([control.bounds[0],control.bounds[1]],child.id).toEqual([control.skin[0],control.skin[1]]);
    for(const axis of [0,1]){
      const inset=control.skin[axis]-(axis?child.y:child.x)-panel.skin[axis];
      expect(inset,child.id).toBeGreaterThanOrEqual(0);expect(inset,child.id).toBeLessThanOrEqual(8);
    }
    (checked[child.parent]??=[]).push(child.id);
  }
  // Every panel connector anchors at least one placed control.
  for(const id of Object.keys(all).filter(id=>id.endsWith('.panel')))expect(checked[id]?.length,id).toBeGreaterThan(0);
});

test('FX connectors: parameter slots, preset label and jog, slot deactivation and stacked sends',async({page})=>{
  test.setTimeout(180000);
  await start(page);
  const seen=new Set();
  // Each effect goes into its own empty slot, where the FX Type menu lists every type.
  for(const [slot,type] of [['A Insert FX 1','Delay'],['A Insert FX 2','Reverb 2'],['A Insert FX 3','Phaser'],['A Insert FX 4','Nimbus'],['B Insert FX 1','Rotary Speaker']]){
    const radio=page.getByRole('radio',{name:new RegExp('^'+slot+':')});
    await radio.dispatchEvent('click');await expect(radio).toHaveAttribute('aria-checked','true');
    await page.waitForTimeout(300); // The FX Type button follows the newly selected slot.
    await page.getByRole('button',{name:'FX Type',exact:true}).dispatchEvent('click');
    await page.getByRole('menuitem',{name:type,exact:true}).dispatchEvent('click');
    // The type opens its preset submenu; load its first preset.
    const presets=page.getByRole('menu').last().locator('[role^=menuitem]');
    await expect(presets.first()).not.toHaveAttribute('aria-label','FILTERING');
    await presets.first().dispatchEvent('click');
    await expect(page.getByRole('menu')).toHaveCount(0);await page.waitForTimeout(500);
    for(const control of (await controls(page)).filter(c=>/^fx\.param_\d+$/.test(c.id)&&c.parameter&&c.title&&c.visible)){
      const target=node(page,control.title);await expect(target,control.id).toBeAttached();
      const before=await target.getAttribute('aria-valuenow');
      if(before===null){seen.add(control.id);continue;}
      await target.focus();await page.keyboard.press(Number(before)<Number(await target.getAttribute('aria-valuemax'))?'End':'Home');
      await expect(target,control.id).not.toHaveAttribute('aria-valuenow',before);
      seen.add(control.id);
    }
  }
  expect([...seen].sort()).toEqual(Array.from({length:12},(_,i)=>'fx.param_'+(i+1)).sort());
  // Preset label and jog, on a fresh slot.
  await page.getByRole('radio',{name:/^B Insert FX 2:/}).dispatchEvent('click');
  await page.getByRole('button',{name:'FX Type',exact:true}).dispatchEvent('click');
  await page.getByRole('menuitem',{name:'Delay',exact:true}).dispatchEvent('click');
  await page.getByRole('menuitem',{name:'Basic 1/4',exact:true}).dispatchEvent('click');
  const label=page.locator('#juce-accessibility [role=paragraph][aria-description="Show"]');
  await expect(label).toHaveText('Basic 1/4');
  const all=Object.fromEntries((await controls(page)).map(c=>[c.id,c]));
  await clickControl(page,all['fx.preset.prevnext'],0.75);await expect(label).not.toHaveText('Basic 1/4');
  await clickControl(page,all['fx.preset.prevnext'],0.25);await expect(label).toHaveText('Basic 1/4');
  // Stacked send 3/4 controls replace sends 1/2 while a send 3/4 slot is selected.
  await page.getByRole('radio',{name:/^Send FX 3:/}).dispatchEvent('click');
  for(const name of ['Send FX 3 Return','Send FX 4 Return','Scene A Send FX 3 Level','Scene A Send FX 4 Level'])
    await expect(page.getByRole('slider',{name,exact:true})).toBeAttached();
  await page.getByRole('radio',{name:/^Send FX 1:/}).dispatchEvent('click');
  await expect(page.getByRole('slider',{name:'Send FX 1 Return',exact:true})).toBeAttached();
  // The hidden fx_disable parameter records slot deactivation in the patch.
  await page.getByRole('radio',{name:/^A Insert FX 1:/}).dispatchEvent('click');
  const before=patchParameters(await savePatch(page,'FX Enabled')).fx_disable.value;
  await page.getByRole('button',{name:'FX Type',exact:true}).dispatchEvent('click');
  await page.getByRole('menuitem',{name:'Deactivate Current FX Slot',exact:true}).dispatchEvent('click');
  expect(patchParameters(await savePatch(page,'FX Disabled')).fx_disable.value).not.toBe(before);
});

test('LFO, VU meter and MSEG button connectors show their original state',async({page})=>{
  await start(page);
  const all=Object.fromEntries((await controls(page)).map(c=>[c.id,c]));
  for(const id of ['lfo.title','controls.vu_meter','filter.filter_preview','filter.waveshaper_preview'])expect(all[id].visible,id).toBe(true);
  // The vertical LFO title follows the selected modulator.
  const title=()=>page.screenshot({clip:{x:all['lfo.title'].bounds[0],y:all['lfo.title'].bounds[1],width:all['lfo.title'].bounds[2],height:all['lfo.title'].bounds[3]}});
  const lfo1=await title();
  const source=await page.getByRole('group',{name:'LFO 2',exact:true}).boundingBox();
  await page.mouse.click(source.x+source.width/2,source.y+source.height/2);
  await expect.poll(async()=>(await title()).equals(lfo1)).toBe(false);
  // The VU meter's original context menu.
  const [x,y,w,h]=all['controls.vu_meter'].bounds;await page.mouse.click(x+w/2,y+h/2,{button:'right'});
  await expect(page.getByRole('menuitem',{name:'Show CPU Usage',exact:true}).or(page.getByRole('menuitemcheckbox',{name:/Show CPU Usage/}))).toBeAttached();
  await closeMenus(page);
  // The MSEG editor button appears for MSEG LFOs and opens the editor.
  expect(all['lfo.mseg_editor'].visible).toBe(false);
  await page.getByRole('radio',{name:'MSEG',exact:true}).dispatchEvent('click');
  await expect.poll(async()=>(await controls(page)).find(c=>c.id==='lfo.mseg_editor').visible).toBe(true);
  await clickControl(page,(await controls(page)).find(c=>c.id==='lfo.mseg_editor'));
  // LFO 2 is selected above, so its MSEG editor opens.
  await expect(page.getByRole('group',{name:'Voice MSEG 2 Editor',exact:true})).toBeAttached();
});
