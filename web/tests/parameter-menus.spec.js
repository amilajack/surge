import {test,expect} from './fixtures.js';
import {start,savePatch,prompt,enableAudio,patchName} from './helpers/ui.js';
// The original right-click menus of parameters, modulators and selectors
// (SurgeGUIEditorValueCallbacks.cpp), opened on the controls' own canvas areas.
const css=text=>text.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
// Section headers are exposed twice (label and item); drop repeats.
const items=page=>page.getByRole('menu').last().locator('[role^=menuitem]').evaluateAll(n=>n.map(x=>x.getAttribute('aria-label')).filter((l,i,a)=>l!==a[i-1]));
// Disabled and informational items are hidden from assistive technology, as on desktop.
const allTitles=page=>page.evaluate(()=>JSON.parse(Module.ccall('surge_browser_open_menu_texts','string',[],[])));
async function closeMenus(page){
  if(!await page.getByRole('menu').count())return;
  // Closing within JUCE's 250 ms popup guard can leave the menu's mouse state behind.
  await page.waitForTimeout(300);
  for(let i=0;i<8&&await page.getByRole('menu').count();++i){await page.keyboard.press('Escape');await page.waitForTimeout(150);}
  await expect(page.getByRole('menu')).toHaveCount(0);
}
const node=(page,name)=>page.locator(`#juce-accessibility [aria-label="${css(name)}"]`).first();
const sel=label=>label instanceof RegExp?null:`[aria-label="${css(label)}"],[aria-label="${css(label)} (Checked)"]`;
async function item(page,label){
  const menu=page.getByRole('menu').last();
  if(label instanceof RegExp){
    const labels=await items(page),match=labels.find(l=>label.test(l));
    expect(match,String(label)).toBeTruthy();return menu.locator(`[aria-label="${css(match)}"]`).first();
  }
  const found=menu.locator(sel(label)).first();
  await expect(found,label).toBeAttached();return found;
}
// Right-clicks a control and opens each submenu in `path`; returns the innermost items.
async function context(page,target,...path){
  await closeMenus(page);
  const control=typeof target==='string'?node(page,target):target;
  await expect(async()=>{
    const b=await control.boundingBox();
    await page.mouse.click(b.x+b.width/2,b.y+b.height/2,{button:'right'});
    await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});
  }).toPass();
  for(const name of path){
    const before=JSON.stringify(await items(page));
    await (await item(page,name)).dispatchEvent('click');
    await expect.poll(async()=>JSON.stringify(await items(page)),String(name)).not.toBe(before);
  }
  return items(page);
}
async function pick(page,target,path,label){
  await context(page,target,...path);
  await (await item(page,label)).dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);
  // Let JUCE finish dismissing the menu before another one opens.
  await page.waitForTimeout(300);
}
const checked=async(page,target,path,label)=>{const l=await context(page,target,...path);await closeMenus(page);return l.includes(label+' (Checked)');};
// Attributes of one element in saved patch XML.
const tag=(xml,name)=>{
  const m=xml.match(new RegExp(`<${name}((?:\\s+[\\w]+="[^"]*")*)\\s*/?>`));
  return m&&Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(([,k,v])=>[k,v]));
};
async function typein(page,value){
  const field=page.getByRole('textbox',{name:'New Value',exact:true});await expect(field).toBeAttached();
  await field.fill(value);await field.press('Enter');await expect(field).toHaveCount(0);
}
let saves=0;
const save=page=>savePatch(page,`Menus ${Date.now()%100000}-${++saves}`);
const mappingReport=async page=>{
  await closeMenus(page);
  await page.getByRole('button',{name:'Main Menu',exact:true}).dispatchEvent('click');
  await (await item(page,'MIDI Settings')).dispatchEvent('click');
  await (await item(page,'Show Current MIDI Mapping...')).dispatchEvent('click');
  const report=page.frameLocator('#surge-report iframe').locator('body');await expect(report).toContainText('MIDI Mapping');
  const text=await report.innerText();await page.getByRole('button',{name:'Close report',exact:true}).click();return text;
};

test('MIDI learn, CC assignment and channel menus on parameters and macros',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  expect(await context(page,'Global Volume')).toEqual(expect.arrayContaining(['MIDI Learn...','Assign to MIDI CC']));
  expect(await context(page,'Global Volume','Assign to MIDI CC')).toEqual(['0 ... 19','20 ... 39','40 ... 59','60 ... 79','80 ... 99','100 ... 119','120 ... 127','MIDI Channel: Omni']);
  const low=await context(page,'Global Volume','Assign to MIDI CC','0 ... 19');
  expect(low.some(l=>l.startsWith('CC 1 (Modulation Wheel MSB)'))).toBe(true);
  // Reserved controllers are listed but disabled.
  expect(low.some(l=>l.startsWith('CC 0 '))).toBe(false);
  expect((await allTitles(page)).some(t=>/^CC 0 .*- RESERVED$/.test(t))).toBe(true);
  await (await item(page,/^CC 1 \(/)).dispatchEvent('click');await expect(page.getByRole('menu')).toHaveCount(0);
  expect(await context(page,'Global Volume','Assign to MIDI CC')).toContain('0 ... 19 (Checked)');
  expect(await context(page,'Global Volume')).toContain('Clear Learned MIDI (CC 1, Omni)');
  await pick(page,'Global Volume',['Assign to MIDI CC','MIDI Channel: Omni'],'Channel 3');
  expect(await context(page,'Global Volume')).toContain('Clear Learned MIDI (CC 1, Channel 3)');
  expect(await context(page,'Global Volume','Assign to MIDI CC','MIDI Channel: 3')).toContain('Channel 3 (Checked)');
  await pick(page,'Global Volume',['Assign to MIDI CC','MIDI Channel: 3'],'Omni');
  expect(await mappingReport(page)).toContain('\n1\tOmni\tGlobal Volume\n');
  await pick(page,'Global Volume',[],'Clear Learned MIDI (CC 1, Omni)');
  expect((await context(page,'Global Volume')).filter(l=>l.startsWith('Clear Learned MIDI'))).toEqual([]);
  expect(await mappingReport(page)).toContain('No parameter MIDI mappings present!');
  // MIDI Learn waits for the next controller; the item then offers to abort.
  await enableAudio(page);
  await pick(page,'Scene A Amp EG Sustain',[],'MIDI Learn...');
  expect(await context(page,'Scene A Amp EG Sustain')).toContain('Abort MIDI Learn');
  await pick(page,'Scene A Amp EG Sustain',[],'Abort MIDI Learn');
  expect(await context(page,'Scene A Amp EG Sustain')).toContain('MIDI Learn...');
  await pick(page,'Scene A Amp EG Sustain',[],'MIDI Learn...');
  await page.evaluate(()=>Module._surge_browser_midi(0xB0,21,90,0));
  // Learning records the incoming controller and its channel.
  await expect.poll(async()=>(await context(page,'Scene A Amp EG Sustain')).includes('Clear Learned MIDI (CC 21, Channel 1)')).toBe(true);
  await pick(page,'Scene A Amp EG Sustain',[],'Clear Learned MIDI (CC 21, Channel 1)');
  // Macros use the same entries for their own controller assignment.
  await pick(page,'Macro 1',['Assign to MIDI CC','0 ... 19'],/^CC 2 \(/);
  expect(await context(page,'Macro 1')).toContain('Clear Learned MIDI (CC 2, Omni)');
  await pick(page,'Macro 1',[],'Clear Learned MIDI (CC 2, Omni)');
  expect(await context(page,'Macro 1')).not.toContain('Clear Learned MIDI (CC 2, Omni)');
  await closeMenus(page);
});

test('macro, modulator and sustain pedal button menus',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  // Macro value, polarity and name.
  const macro=await context(page,'Macro 1');
  expect(macro).toEqual(expect.arrayContaining(['Edit Value: 0.00 %','Bipolar Mode','Rename Macro...']));
  // Type-in sets the macro target; the running engine then smooths its output there.
  await enableAudio(page);
  await pick(page,'Macro 1',[],'Edit Value: 0.00 %');await typein(page,'40');
  await expect.poll(async()=>(await context(page,'Macro 1')).find(l=>l.startsWith('Edit Value'))).toMatch(/^Edit Value: (39\.9\d|40\.00) %$/);
  await pick(page,'Macro 1',[],'Bipolar Mode');expect(await checked(page,'Macro 1',[],'Bipolar Mode')).toBe(true);
  await pick(page,'Macro 1',[],'Rename Macro...');
  await prompt(page,'Wobble');
  await expect(node(page,'Wobble')).toBeAttached();
  // Voice LFO 1: switch the displayed output, rename, copy and paste.
  expect(await context(page,'LFO 1','Switch To')).toEqual(['Voice LFO 1 (Raw Waveform)','Voice LFO 1 (EG Only)','Amplitude Parameter Applies to Raw and EG Outputs']);
  await pick(page,'LFO 1',['Switch To'],'Voice LFO 1 (EG Only)');
  // The button now shows the EG output.
  expect(await context(page,'LFO 1 EG','Switch To')).toEqual(['Voice LFO 1','Voice LFO 1 (Raw Waveform)','Amplitude Parameter Applies to Raw and EG Outputs']);
  await pick(page,'LFO 1 EG',['Switch To'],'Voice LFO 1');
  await pick(page,'LFO 1',[],'Rename Modulator...');
  await prompt(page,'Sweep');
  await expect(node(page,'Sweep')).toBeAttached();
  const sweep='Sweep';
  // Route LFO 1 to Osc 1 Pitch, give it a distinct rate, then copy it to LFO 2 in three ways.
  // Renamed modulators keep their slot name in the menu.
  await pick(page,'Scene A Osc 1 Pitch',['Add Modulation from','Voice LFOs','Voice LFO 1'],'Sweep (LFO 1)');
  await typein(page,'5');
  await pick(page,'Scene A LFO 1 Rate',[],/^Edit Value: /);await typein(page,'3.5');
  let xml=await save(page);
  const lfo1=tag(xml,'a_lfo0_rate').value;expect(Number(lfo1)).toBeGreaterThan(0);
  const routes=(xml,param)=>[...(xml.match(new RegExp(`<${param}[^>]*>([\\s\\S]*?)</${param}>`))?.[1]??'').matchAll(/source="(\d+)"/g)].map(m=>Number(m[1]));
  const sourcesBefore=routes(xml,'a_osc1_pitch');expect(sourcesBefore.length).toBe(1);
  expect(await context(page,sweep)).toEqual(expect.arrayContaining(['Copy Modulator','Copy Modulator with Targets','Copy Targets']));
  await pick(page,sweep,[],'Copy Modulator');
  await pick(page,'LFO 2',[],'Paste');
  xml=await save(page);expect(tag(xml,'a_lfo1_rate').value).toBe(lfo1);expect(routes(xml,'a_osc1_pitch').length).toBe(1);
  await pick(page,sweep,[],'Copy Modulator with Targets');
  await pick(page,'LFO 3',[],'Paste');
  xml=await save(page);expect(tag(xml,'a_lfo2_rate').value).toBe(lfo1);expect(routes(xml,'a_osc1_pitch').length).toBe(2);
  await pick(page,sweep,[],'Copy Targets');
  await pick(page,'LFO 4',[],'Paste');
  xml=await save(page);expect(tag(xml,'a_lfo3_rate').value).not.toBe(lfo1);expect(routes(xml,'a_osc1_pitch').length).toBe(3);
  // Non-LFO sources copy and paste their targets.
  await pick(page,'Scene A Osc 1 Pitch',['Add Modulation from','MIDI'],'Velocity');await typein(page,'3');
  expect(await context(page,'Velocity')).toEqual(expect.arrayContaining(['Copy Targets']));
  await pick(page,'Velocity',[],'Copy Targets');
  await pick(page,'Keytrack',[],'Paste');
  xml=await save(page);expect(routes(xml,'a_osc1_pitch').length).toBe(5);
  // Sustain Pedal: detach from voicing, stored with the patch.
  await pick(page,'Sustain',[],'Detach Sustain Pedal from Voicing');
  expect(await checked(page,'Sustain',[],'Detach Sustain Pedal from Voicing')).toBe(true);
  xml=await save(page);expect(tag(xml,'detachSustainPedalFromVoicing')).toEqual({v:'1'});
  await pick(page,'Sustain',[],'Detach Sustain Pedal from Voicing');
  expect(await checked(page,'Sustain',[],'Detach Sustain Pedal from Voicing')).toBe(false);
});

const controls=async page=>JSON.parse(await page.evaluate(()=>Module.ccall('surge_browser_skin_controls','string',[],[])));
async function setFx(page,slot,type){
  const radio=page.getByRole('radio',{name:new RegExp('^'+slot+':')});
  await radio.dispatchEvent('click');await expect(radio).toHaveAttribute('aria-checked','true');await page.waitForTimeout(300);
  await page.getByRole('button',{name:'FX Type',exact:true}).dispatchEvent('click');
  await page.getByRole('menuitem',{name:type,exact:true}).dispatchEvent('click');
  // The type opens its preset submenu; load its first preset.
  const presets=page.getByRole('menu').last().locator('[role^=menuitem]');
  await expect(presets.first()).not.toHaveAttribute('aria-label','FILTERING');
  await presets.first().dispatchEvent('click');await expect(page.getByRole('menu')).toHaveCount(0);await page.waitForTimeout(500);
}
async function setOsc(page,path,expected){
  await expect(async()=>{
    await page.getByRole('button',{name:'Oscillator Type',exact:true}).dispatchEvent('click');
    await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});
  }).toPass();
  await page.waitForTimeout(800);
  // The checked type's submenu opens with the menu; step back to the type list.
  for(let i=0;i<3&&!(await items(page)).some(l=>l===path[0]||l===path[0]+' (Checked)');i++){
    await page.keyboard.press('ArrowLeft');await page.waitForTimeout(350);
  }
  for(const [index,label] of path.entries()){
    const before=JSON.stringify(await items(page));
    await (await item(page,label)).dispatchEvent('click');
    // A submenu replaces the mirrored items; the final choice closes the menu.
    if(index<path.length-1)await expect.poll(async()=>JSON.stringify(await items(page)),label).not.toBe(before);
  }
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(node(page,'Scene A Osc 1 '+expected),path.join(' > ')).toBeAttached();
  await page.waitForTimeout(300);
}
// Picks each option of a radio-style group and checks that only it is ticked.
async function radioGroup(page,target,path,options){
  for(const option of options){
    await pick(page,target,path,option);
    const listed=await context(page,target,...path);
    expect(listed.filter(l=>options.includes(l.replace(/ \(Checked\)$/,''))&&l.endsWith(' (Checked)')),`${target} ${option}`).toEqual([option+' (Checked)']);
  }
  await closeMenus(page);
}
async function toggle(page,target,label){
  const before=await checked(page,target,[],label);
  await pick(page,target,[],label);expect(await checked(page,target,[],label),label).toBe(!before);
  return before;
}
const routes=(xml,param)=>[...(xml.match(new RegExp(`<${param}[^>]*>([\\s\\S]*?)</${param}>`))?.[1]??'').matchAll(/source="(\d+)"/g)].map(m=>Number(m[1]));

test('oscillator and scene copy and paste',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  await pick(page,'Scene A Osc 1 Pitch',[],/^Edit Value: /);await typein(page,'7');
  await pick(page,'Scene A Osc 1 Pitch',['Add Modulation from','MIDI'],'Velocity');await typein(page,'2');
  expect(await context(page,'Oscillator Select')).toEqual(expect.arrayContaining(['Copy from Osc 1','Copy from Osc 1 with Modulation']));
  expect((await context(page,'Oscillator Select')).filter(l=>l.startsWith('Paste'))).toEqual([]);
  await pick(page,'Oscillator Select',[],'Copy from Osc 1');
  const select=await node(page,'Oscillator Select').boundingBox();
  await page.mouse.click(select.x+select.width/2,select.y+select.height/2);
  await expect(node(page,'Scene A Osc 2 Pitch')).toBeAttached();
  await pick(page,'Oscillator Select',[],'Paste to Osc 2');
  let xml=await save(page);
  expect(Number(tag(xml,'a_osc2_pitch').value)).toBeCloseTo(7,3);expect(routes(xml,'a_osc2_pitch')).toEqual([]);
  // With modulation, the routings travel with the oscillator.
  await node(page,'Oscillator Select').focus();await page.keyboard.press('Home');
  await expect(node(page,'Scene A Osc 1 Pitch')).toBeAttached();
  await pick(page,'Oscillator Select',[],'Copy from Osc 1 with Modulation');
  await node(page,'Oscillator Select').focus();await page.keyboard.press('End');
  await expect(node(page,'Scene A Osc 3 Pitch')).toBeAttached();
  await pick(page,'Oscillator Select',[],'Paste to Osc 3');
  xml=await save(page);
  expect(Number(tag(xml,'a_osc3_pitch').value)).toBeCloseTo(7,3);expect(routes(xml,'a_osc3_pitch').length).toBe(1);
  // Scenes: Paste Scene is disabled until a scene is copied.
  expect(await context(page,'Active Scene')).toEqual(expect.arrayContaining(['Copy Scene']));
  expect(await items(page)).not.toContain('Paste Scene');
  expect(await allTitles(page)).toContain('Paste Scene');
  await pick(page,'Active Scene',[],'Copy Scene');
  const sceneB=page.getByRole('radio',{name:'Scene B',exact:true});
  await sceneB.dispatchEvent('click');await expect(sceneB).toHaveAttribute('aria-checked','true');await page.waitForTimeout(300);
  await pick(page,'Active Scene',[],'Paste Scene');
  xml=await save(page);
  expect(Number(tag(xml,'b_osc1_pitch').value)).toBeCloseTo(7,3);expect(routes(xml,'b_osc1_pitch').length).toBe(1);
  await page.getByRole('button',{name:'Undo',exact:true}).dispatchEvent('click');
  xml=await save(page);expect(Number(tag(xml,'b_osc1_pitch').value)).toBeCloseTo(0,3);
});

test('value entry, type groups, scene and play mode menus',async({page})=>{
  test.setTimeout(180000);
  await start(page);
  await pick(page,'Scene A Amp EG Sustain',[],'Edit Value: 100.00 %');await typein(page,'50');
  await pick(page,'Polyphony Limit',[],/^Edit Value: /);await typein(page,'8');
  await toggle(page,'Scene A Pitch Bend Up Range','Use Decimal Values');
  let xml=await save(page);
  expect(Number(tag(xml,'a_env1_sustain').value)).toBeCloseTo(0.5,3);expect(tag(xml,'polylimit').value).toBe('8');
  expect(tag(xml,'a_pbrange_up').extend_range).toBe('1');
  await toggle(page,'Scene A Pitch Bend Up Range','Use Decimal Values');
  // Keytrack and retrigger for all oscillators.
  expect(await context(page,'Scene A Osc 1 Keytrack')).toContain('Disable Keytrack for All Oscillators');
  await pick(page,'Scene A Osc 1 Keytrack',[],'Disable Keytrack for All Oscillators');
  expect(await context(page,'Scene A Osc 1 Retrigger')).toContain('Enable Retrigger for All Oscillators');
  await pick(page,'Scene A Osc 1 Retrigger',[],'Enable Retrigger for All Oscillators');
  xml=await save(page);
  for(const osc of [1,2,3]){expect(tag(xml,`a_osc${osc}_keytrack`).value).toBe('0');expect(tag(xml,`a_osc${osc}_retrigger`).value).toBe('1');}
  expect(await context(page,'Scene A Osc 1 Keytrack')).toContain('Enable Keytrack for All Oscillators');
  expect(await context(page,'Scene A Osc 1 Retrigger')).toContain('Disable Retrigger for All Oscillators');
  await closeMenus(page);
  // Filter type groups, subtype values, comb tuning and deactivation.
  const groups=await context(page,'Scene A Filter 1 Type');
  expect(groups).toEqual(expect.arrayContaining(['Off (Checked)','Lowpass','Bandpass','Highpass','Notch','Multi','Effect','Enabled (Checked)']));
  expect(await context(page,'Scene A Filter 1 Type','Lowpass')).toEqual(expect.arrayContaining(['12 dB','24 dB','Legacy Ladder','Vintage Ladder','K35','Diode Ladder','OB-Xd 12 dB','OB-Xd 24 dB']));
  await pick(page,'Scene A Filter 1 Type',['Lowpass'],'24 dB');
  expect(await context(page,'Scene A Filter 1 Type')).toContain('Lowpass (Checked)');
  await radioGroup(page,'Scene A Filter 1 Subtype',[],['Driven','Clean','Standard']);
  await pick(page,'Scene A Filter 1 Type',['Effect'],'Comb +');
  // Precise comb tuning is on for new patches.
  expect(await context(page,'Scene A Filter 1 Subtype')).toEqual(expect.arrayContaining(['50% Wet (Checked)','100% Wet','Precise Tuning (Checked)']));
  await toggle(page,'Scene A Filter 1 Subtype','Precise Tuning');
  await pick(page,'Scene A Filter 1 Type',[],'Enabled');
  xml=await save(page);expect(tag(xml,'a_filter1_type').deactivated).toBe('1');
  await pick(page,'Scene A Filter 1 Type',[],'Enabled');
  xml=await save(page);expect(tag(xml,'a_filter1_type').deactivated).toBe('0');
  // Scene mode values and the split point, which exists only in split modes.
  await radioGroup(page,'Scene Mode',[],['Key Split','Channel Split','Dual','Single']);
  await pick(page,'Scene Mode',[],'Key Split');
  const split=await context(page,'Split Point');expect(split.some(l=>l.startsWith('Edit Value: '))).toBe(true);
  await pick(page,'Split Point',[],/^Edit Value: /);await typein(page,'72');
  xml=await save(page);expect(tag(xml,'scenemode').value).toBe('1');expect(tag(xml,'splitkey').value).toBe('72');
  await pick(page,'Scene Mode',[],'Single');
  // Play modes and their voice options.
  expect(await context(page,'Scene A Play Mode')).toEqual(expect.arrayContaining(['Poly (Checked)','Mono','Mono (Single Trigger)','Mono (Fingered Portamento)','Mono (Single Trigger & Fingered Portamento)','Latch (Monophonic)','Stack Multiple (Checked)','Reuse Single']));
  await radioGroup(page,'Scene A Play Mode',[],['Reuse Single','Stack Multiple']);
  await pick(page,'Scene A Play Mode',[],'Reuse Single');
  await pick(page,'Scene A Play Mode',[],'Mono');
  const mono=await context(page,'Scene A Play Mode');
  expect(mono.map(l=>l==='Mono (Checked)'?l:l.replace(/ \(Checked\)$/,''))).toEqual(expect.arrayContaining(['Mono (Checked)','Last','High','Low','Legacy','Reset to Zero','Continue from Current Level','Sustain Pedal in Mono Mode']));
  await radioGroup(page,'Scene A Play Mode',[],['High','Low','Legacy','Last']);
  await radioGroup(page,'Scene A Play Mode',[],['Continue from Current Level','Reset to Zero']);
  await pick(page,'Scene A Play Mode',[],'High');await pick(page,'Scene A Play Mode',[],'Continue from Current Level');
  await radioGroup(page,'Scene A Play Mode',['Sustain Pedal in Mono Mode'],['Sustain Pedal Allows Note Off Retrigger','Sustain Pedal Holds All Notes (No Note Off Retrigger)']);
  xml=await save(page);
  expect(tag(xml,'a_polymode').value).toBe('1');expect(tag(xml,'polyVoiceRepeatedKeyMode_0').v).toBe('1');
  const priority=tag(xml,'monoVoicePrority_0').v,envelope=tag(xml,'monoVoiceEnvelope_0').v;
  await pick(page,'Scene A Play Mode',[],'Last');await pick(page,'Scene A Play Mode',[],'Reset to Zero');
  xml=await save(page);
  expect(tag(xml,'monoVoicePrority_0').v).not.toBe(priority);expect(tag(xml,'monoVoiceEnvelope_0').v).not.toBe(envelope);
  // Latch also offers the envelope retrigger choice.
  await pick(page,'Scene A Play Mode',[],'Latch (Monophonic)');
  expect(await context(page,'Scene A Play Mode')).toEqual(expect.arrayContaining(['Reset to Zero (Checked)','Continue from Current Level']));
  await closeMenus(page);
});

test('tempo sync menus',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  const rate='Scene A LFO 1 Rate';
  await toggle(page,rate,'Tempo Sync');
  let listed=await context(page,rate);
  expect(listed).toEqual(expect.arrayContaining(['Straight','Dotted','Triplet','Tempo Sync (Checked)']));
  // The first entry shows the synced value without an Edit Value prefix.
  const current=listed.find(l=>/ (note|notes|dotted|triplet|triplets)$/.test(l));expect(current).toBeTruthy();
  for(const [group,label] of [['Straight','1/8 note'],['Dotted','1/4 dotted'],['Triplet','1/8 triplet'],['Straight','whole note']]){
    const values=await context(page,rate,group);expect(values).toContain(label);
    await pick(page,rate,[group],label);
    expect(await context(page,rate)).toContain(label);
  }
  await closeMenus(page);
  let xml=await save(page);expect(tag(xml,'a_lfo0_rate').temposync).toBe('1');
  // Tempo sync for a whole envelope.
  expect(await context(page,'Scene A Amp EG Attack')).toContain('Enable Tempo Sync for All Amp EG Parameters');
  await pick(page,'Scene A Amp EG Attack',[],'Enable Tempo Sync for All Amp EG Parameters');
  xml=await save(page);for(const p of ['attack','decay','release'])expect(tag(xml,'a_env1_'+p).temposync,p).toBe('1');
  expect(await context(page,'Scene A Amp EG Decay')).toContain('Disable Tempo Sync for All Amp EG Parameters');
  await pick(page,'Scene A Amp EG Decay',[],'Disable Tempo Sync for All Amp EG Parameters');
  xml=await save(page);for(const p of ['attack','decay','release'])expect(tag(xml,'a_env1_'+p).temposync,p).toBeUndefined();
  expect(await context(page,'Scene A LFO 1 Attack')).toContain('Enable Tempo Sync for All Voice LFO 1 Parameters');
  await closeMenus(page);
});

test('scene float parameter options',async({page})=>{
  test.setTimeout(180000);
  await start(page);
  // Pitch: extend range and absolute; unison detune: absolute.
  await toggle(page,'Scene A Osc 1 Pitch','Extend Range');await toggle(page,'Scene A Osc 1 Pitch','Absolute');
  await toggle(page,'Scene A Osc 1 Unison Detune','Absolute');
  await toggle(page,'Scene A Osc Drift','Randomize Initial Drift Phase');
  // Filter cutoff reset and portamento options.
  await pick(page,'Scene A Filter 1 Cutoff',[],/^Edit Value: /);await typein(page,'1000');
  await pick(page,'Scene A Filter 1 Cutoff',[],'Reset Filter Cutoff To Keytrack Root');
  for(const option of ['Constant Rate','Glissando','Retrigger at Scale Degrees'])await toggle(page,'Scene A Portamento',option);
  await radioGroup(page,'Scene A Portamento',[],['Logarithmic','Exponential']);
  // Highpass slope and deactivation; LFO deform types; Amp EG release freeze.
  await radioGroup(page,'Scene A Highpass',[],['24 dB/oct','36 dB/oct','48 dB/oct','12 dB/oct','24 dB/oct']);
  await toggle(page,'Scene A Highpass','Enabled');
  await radioGroup(page,'Scene A LFO 1 Deform',[],['Type 2','Type 3']);
  await toggle(page,'Scene A Amp EG Release','Freeze Release at Sustain Level');
  // Noise generator type, and its mode once the filter configuration is Wide.
  await radioGroup(page,'Scene A Noise Color',[],['Tilt Filter']);
  await pick(page,'Scene A Filter Configuration',[],'Serial 1');
  expect((await context(page,'Scene A Noise Color')).filter(l=>/^(Mono|Stereo)/.test(l))).toEqual([]);
  await pick(page,'Scene A Filter Configuration',[],'Wide');
  await radioGroup(page,'Scene A Noise Color',[],['Mono','Stereo','Mono']);
  // Ring modulator combinator modes; the linear-modulation heading is informational.
  const ring='Scene A Ring Modulation 1x2 Volume';
  expect(await context(page,ring)).toEqual(expect.arrayContaining(['Ring Modulation (Checked)','Continuous XOR','4 Gradients','9 Gradients']));
  expect(await allTitles(page)).toContain('Scale-Invariant Linear Modulation:');
  expect(await context(page,ring,'4 Gradients')).toEqual(['Mode 1','Mode 2','Mode 3','Mode 4','Mode 5','Mode 6']);
  expect(await context(page,ring,'9 Gradients')).toEqual(['Mode 1','Mode 2','Mode 3','Mode 4','Mode 5']);
  await pick(page,ring,['9 Gradients'],'Mode 2');
  expect(await context(page,ring,'9 Gradients')).toContain('Mode 2 (Checked)');
  await radioGroup(page,ring,[],['Continuous XOR']);
  // Scene volume: mute and hard clip; global volume: hard clip.
  await toggle(page,'Scene A Volume','Mute Scene A');
  await radioGroup(page,'Scene A Volume',[],['Scene A Hard Clip Disabled','Scene A Hard Clip at 0 dBFS']);
  await radioGroup(page,'Global Volume',[],['Global Hard Clip Disabled','Global Hard Clip at 0 dBFS']);
  const xml=await save(page);
  expect(tag(xml,'a_osc1_pitch')).toMatchObject({extend_range:'1',absolute:'1'});
  expect(tag(xml,'a_osc1_param5').absolute).toBe('1');
  expect(Number(tag(xml,'a_filter1_cutoff').value)).toBeCloseTo(-9,3);
  expect(tag(xml,'a_portamento')).toMatchObject({porta_const_rate:'1',porta_gliss:'1',porta_retrigger:'1',porta_curve:'1'});
  expect(tag(xml,'a_lowcut')).toMatchObject({deform_type:'1',deactivated:'1'});
  expect(tag(xml,'a_lfo0_deform').deform_type).toBe('2');
  expect(tag(xml,'a_env1_release').deform_type).toBe('1');
  expect(tag(xml,'a_volume').deactivated).toBe('1');
  expect(Number(tag(xml,'a_noisecol').deform_type)&2).toBe(2);
  expect(tag(xml,'a_level_ring12').deform_type).not.toBe('0');
  expect(tag(xml,'hardclipmodes')).toMatchObject({global:'2',sc0:'2'}); // 1 is +18 dBFS, 2 is 0 dBFS
  // Apply SCL/KBM Tuning to Filter Cutoff appears when tuning applies after modulation.
  expect((await context(page,'Scene A Filter 1 Cutoff')).filter(l=>/SCL\/KBM/.test(l))).toEqual([]);
  await closeMenus(page);
  await page.getByRole('button',{name:'Main Menu',exact:true}).dispatchEvent('click');
  await (await item(page,'Tuning')).dispatchEvent('click');await (await item(page,'Apply Tuning After Modulation')).dispatchEvent('click');
  await toggle(page,'Scene A Filter 1 Cutoff','Apply SCL/KBM Tuning to Filter Cutoff');
});

test('oscillator and effect specific parameter options',async({page})=>{
  test.setTimeout(240000);
  await start(page);
  const osc=name=>'Scene A Osc 1 '+name;
  await setOsc(page,['Wavetable'],'Morph');
  await toggle(page,osc('Morph'),'Legacy Mode');await toggle(page,osc('Morph'),'Continuous Morph');
  await setOsc(page,['FM2'],'M1 Ratio');
  await radioGroup(page,osc('Feedback'),[],['Vintage FM','Surge']);
  // FM3 ratios switch to absolute frequencies, renaming the control.
  await setOsc(page,['FM3'],'M1 Ratio');
  await pick(page,osc('M1 Ratio'),[],'Absolute');
  await expect(node(page,osc('M1 Frequency'))).toBeAttached();
  expect(await checked(page,osc('M1 Frequency'),[],'Absolute')).toBe(true);
  await pick(page,osc('M1 Frequency'),[],'Absolute');await expect(node(page,osc('M1 Ratio'))).toBeAttached();
  await setOsc(page,['String'],'Stiffness');
  await radioGroup(page,osc('Exciter Level'),[],['2x','1x']);
  await radioGroup(page,osc('Exciter Level'),[],['Linear','Sinc','Zero Order Hold']);
  await radioGroup(page,osc('Stiffness'),[],['Keytracked','Keytracked and Pitch Compensated','Static']);
  await setOsc(page,['Alias'],'Mask');
  await toggle(page,osc('Mask'),'Ramp Not Masked Above Threshold');
  await setOsc(page,['Twist'],'LPG Decay');
  // Panning mode renames the mix control.
  await pick(page,osc('Sync Mix'),[],'Pan Main and Auxiliary Signals');
  expect(await checked(page,osc('Main<>Sync Pan'),[],'Pan Main and Auxiliary Signals')).toBe(true);
  await pick(page,osc('Main<>Sync Pan'),[],'Pan Main and Auxiliary Signals');await expect(node(page,osc('Sync Mix'))).toBeAttached();
  // The LPG is off by default; its decay control's Enabled item switches it.
  await toggle(page,osc('LPG Decay'),'Enabled');
  // Modern last: a checked type with presets opens its preset submenu when the menu opens.
  await setOsc(page,['Modern','Sawtooth'],'Sawtooth');
  // The waveform control is named after its current waveform.
  const multi=page.locator('#juce-accessibility').getByRole('slider',{name:/^Scene A Osc 1 (Triangle|Sine|Square)$/});
  await radioGroup(page,multi,[],['Sine','Square','Triangle']);
  await expect(node(page,osc('Triangle'))).toBeAttached();
  for(const option of ['Enabled','Two Octaves Down','Disable Hardsync'])await toggle(page,multi,option);
  // Effects.
  await setFx(page,'A Insert FX 1','Tape');
  await radioGroup(page,'FX A1 Drive - Hysteresis',[],['Medium','High','Very High','Normal']);
  await toggle(page,'FX A1 Saturation - Hysteresis','Enabled');
  await setFx(page,'A Insert FX 2','Delay');
  await radioGroup(page,'FX A2 Feedback - Feedback/EQ',[],['Disabled (DANGER!)','Soft Clip (cubic)','Soft Clip (tanh)','Hard Clip at 0 dBFS','Hard Clip at +18 dBFS']);
  await toggle(page,'FX A2 Right - Delay Time','Link to Left Channel');
  await toggle(page,'FX A2 Feedback - Feedback/EQ','Extend Range');
  await setFx(page,'A Insert FX 3','Bonsai');
  await radioGroup(page,'FX A3 Amount - Bass Boost',[],['Mono','Stereo']);
  await setFx(page,'A Insert FX 4','Resonator');
  await toggle(page,'FX A4 Resonance 1 - Band 1','Modulation Extends into Self-oscillation');
  await setFx(page,'B Insert FX 1','Combulator');
  // Absolute offsets become frequencies, renaming the control.
  await pick(page,'FX B1 Offset 2 - Combs',[],'Absolute');
  expect(await checked(page,'FX B1 Frequency 2 - Combs',[],'Absolute')).toBe(true);
  await pick(page,'FX B1 Frequency 2 - Combs',[],'Absolute');await expect(node(page,'FX B1 Offset 2 - Combs')).toBeAttached();
  expect(await context(page,'FX B1 Center - Combs')).toContain('Reset Filter Cutoff To Keytrack Root');
  await pick(page,'FX B1 Center - Combs',[],'Reset Filter Cutoff To Keytrack Root');
});

test('Add Modulation from submenus route every source group',async({page})=>{
  test.setTimeout(180000);
  await start(page);
  const target='Scene A Filter 1 Cutoff';
  expect(await context(page,target,'Add Modulation from')).toEqual(['Macros','Voice LFOs','Scene LFOs','Envelopes','MIDI','Internal']);
  expect(await context(page,target,'Add Modulation from','Macros')).toEqual(['Macro 1','Macro 2','Macro 3','Macro 4','Macro 5','Macro 6','Macro 7','Macro 8']);
  expect(await context(page,target,'Add Modulation from','Voice LFOs','Voice LFO 2')).toEqual(['Voice LFO 2','Voice LFO 2 (Raw Waveform)','Voice LFO 2 (EG Only)']);
  expect(await context(page,target,'Add Modulation from','Scene LFOs')).toEqual(['Scene LFO 1','Scene LFO 2','Scene LFO 3','Scene LFO 4','Scene LFO 5','Scene LFO 6']);
  expect(await context(page,target,'Add Modulation from','Envelopes')).toEqual(['Filter EG','Amp EG']);
  expect(await context(page,target,'Add Modulation from','MIDI')).toEqual(expect.arrayContaining(['Velocity','Release Velocity','Keytrack','Channel Aftertouch','Polyphonic Aftertouch','Pitch Bend','Modwheel','Breath','Expression','Sustain Pedal','Timbre']));
  expect(await context(page,target,'Add Modulation from','Internal')).toEqual(expect.arrayContaining(['Random Bipolar','Random Unipolar','Alternate Bipolar','Alternate Unipolar']));
  expect(await context(page,target,'Add Modulation from','Internal','Random Bipolar')).toEqual(['Random Bipolar (Uniform)','Random Bipolar (Normal)']);
  const sources=[
    [['Macros'],'Macro 3'],[['Voice LFOs','Voice LFO 2'],'Voice LFO 2 (EG Only)'],[['Scene LFOs','Scene LFO 1'],'Scene LFO 1'],
    [['Envelopes'],'Filter EG'],[['MIDI'],'Modwheel'],[['Internal','Random Bipolar'],'Random Bipolar (Normal)'],[['Internal'],'Alternate Unipolar']];
  for(const [path,label] of sources){await pick(page,target,['Add Modulation from',...path],label);await typein(page,'10');}
  const xml=await save(page);expect(routes(xml,'a_filter1_cutoff').length).toBe(sources.length);
  // Sources already routed to this parameter are not offered again; indexed sources remain.
  expect(await context(page,target,'Add Modulation from','Macros')).not.toContain('Macro 3');
  expect(await context(page,target,'Add Modulation from','Envelopes')).toEqual(['Amp EG']);
  await closeMenus(page);
});

test('CPU usage display, debug-only undo history, host and OSC entries',async({page})=>{
  await start(page);
  const vu=(await controls(page)).find(c=>c.id==='controls.vu_meter');expect(vu).toBeTruthy();
  const [x,y,w,h]=vu.bounds;
  const meter=async()=>{
    await closeMenus(page);await page.mouse.click(x+w/2,y+h/2,{button:'right'});await expect(page.getByRole('menu')).toHaveCount(1);return items(page);
  };
  const before=(await meter()).includes('Show CPU Usage (Checked)');
  await (await item(page,'Show CPU Usage')).dispatchEvent('click');await expect(page.getByRole('menu')).toHaveCount(0);
  expect((await meter()).includes('Show CPU Usage (Checked)')).toBe(!before);
  await (await item(page,'Show CPU Usage')).dispatchEvent('click');await expect(page.getByRole('menu')).toHaveCount(0);
  // Undo/redo history entries exist only in DEBUG builds; release builds show the help header alone.
  expect(await context(page,'Undo')).toEqual(['Action History (open manual)']);
  expect(await context(page,'Redo')).toEqual(['Action History (open manual)']);
  // Parameter menus have no host items (no plugin host) and no OSC address (no OSC input).
  const listed=await context(page,'Global Volume');
  expect(listed.filter(l=>/^OSC: /.test(l))).toEqual([]);
  expect(listed).toEqual(['Global Volume (open manual)','Edit Value: -2.03 dB','Add Modulation from','Assign to MIDI CC','MIDI Learn...','Global Hard Clip Disabled','Global Hard Clip at 0 dBFS','Global Hard Clip at +18 dBFS (Checked)']);
  await closeMenus(page);
});

test('modulator output menu from the button hamburger',async({page})=>{
  await start(page);
  const button=await node(page,'LFO 1').boundingBox();
  const hamburger=async()=>{
    await closeMenus(page);
    await expect(async()=>{
      await page.mouse.click(button.x+button.width*0.07,button.y+button.height/2);
      await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});
    }).toPass();
    return items(page);
  };
  // The left edge of a multi-output modulator lists its outputs under the modulator's name.
  expect(await hamburger()).toEqual(['Voice LFO 1 (open manual)','Voice LFO 1 (Checked)','Voice LFO 1 (Raw Waveform)','Voice LFO 1 (EG Only)','Amplitude Parameter Applies to Raw and EG Outputs']);
  await (await item(page,'Voice LFO 1 (Raw Waveform)')).dispatchEvent('click');await expect(page.getByRole('menu')).toHaveCount(0);
  expect(await hamburger()).toContain('Voice LFO 1 (Raw Waveform) (Checked)');
  await (await item(page,'Voice LFO 1')).dispatchEvent('click');await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(node(page,'LFO 1')).toBeAttached();
  const amplitude=async()=>tag((await save(page)).match(/<lfo scene="0" i="0"[^>]*>/)[0],'lfo').extraAmplitude;
  const before=await amplitude();
  await hamburger();await (await item(page,'Amplitude Parameter Applies to Raw and EG Outputs')).dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(await amplitude()).not.toBe(before);
  expect((await hamburger()).includes('Amplitude Parameter Applies to Raw and EG Outputs (Checked)')).toBe(before==='0');
  await closeMenus(page);
});
