import {test,expect} from './fixtures.js';
import {readFileSync} from 'node:fs';
import {start,reloadPersisted,prompt} from './helpers/ui.js';
// The original settings menu (SurgeGUIEditorMenuStructures.cpp), item by item.
async function closeMenus(page){for(let i=0;i<8&&await page.getByRole('menu').count();++i){await page.keyboard.press('Escape');await page.waitForTimeout(80);}}
const items=page=>page.getByRole('menu').last().locator('[role^=menuitem]').evaluateAll(n=>n.map(x=>x.getAttribute('aria-label')));
async function open(page,...path){
  await closeMenus(page);
  // Skin reloads rebuild the editor; retry until the rebuilt button opens the menu.
  await expect(async()=>{
    await page.getByRole('button',{name:'Main Menu',exact:true}).dispatchEvent('click',{},{timeout:1000});
    await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});
  }).toPass();
  for(const name of path){
    const before=JSON.stringify(await items(page));
    const item=page.getByRole('menu').last().locator(`[aria-label="${css(name)}"]`).first();
    await expect(item,name).toBeAttached();await item.dispatchEvent('click');
    await expect.poll(async()=>JSON.stringify(await items(page)),name).not.toBe(before);
  }
  return items(page);
}
// Clicks the item, whether or not it is currently checked.
const css=text=>text.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
async function choose(page,path,label){
  await open(page,...path);
  const item=page.getByRole('menu').last().locator(`[aria-label="${css(label)}"],[aria-label="${css(label)} (Checked)"]`).first();
  await expect(item,`${path.join(' > ')} > ${label}`).toBeAttached();
  await item.dispatchEvent('click');
  // Selecting an item closes the menu; pressing Escape too early would dismiss the dialog it opens.
  await expect(page.getByRole('menu')).toHaveCount(0);
}
const isChecked=async(page,path,label)=>(await open(page,...path)).includes(label+' (Checked)');
// Informational items are disabled, so JUCE hides them from assistive technology
// (as on desktop); read the open menus' item titles directly.
const allTitles=page=>page.evaluate(()=>JSON.parse(Module.ccall('surge_browser_open_menu_texts','string',[],[])));
const width=async page=>(await page.locator('canvas').first().boundingBox()).width;

const toggles=[
  [['Value Displays'],'High Precision Value Readouts'],[['Value Displays'],'Modulation Value Readout Shows Bounds'],
  [['Value Displays'],'Show Value Readout on Mouse Hover'],[['Value Displays'],'Show Ghosted LFO Waveform Reference'],
  [['Mouse Behavior'],'Show Cursor While Editing'],[['Mouse Behavior'],'Touchscreen Mode'],
  [['Workflow'],'Remember Tab Positions Per Scene'],[['Workflow'],'Load MSEG Snap State from Patch'],
  [['Workflow'],'Previous/Next Patch Constrained to Current Category'],[['Workflow'],'Retain Patch Search Results After Loading Via Click'],
  [['Workflow'],'Confirm Patch Loading if Unsaved Changes Exist'],[['Workflow'],'Use Keyboard Shortcuts'],
  [['Workflow'],'Never Move Keyboard Focus'],[['Workflow'],'Virtual Keyboard: Click Sets Overall Velocity'],
  [['Accessibility'],'Send Additional Accessibility Announcements'],[['Accessibility'],'Add Sub-Menus for Modulation Menu Items'],
  [['Accessibility'],'Focus Modulator Editor on "Add Modulation From" Actions'],
  [['MIDI Settings'],'Use MIDI Channels 2 and 3 to Play Scenes Individually'],[['MIDI Settings'],'Soft Takeover MIDI Learned Parameters'],
];
test('preference toggles flip, persist across reloads and restore',async({page})=>{
  test.setTimeout(240000);
  await start(page);
  const initial=[];
  for(const [path,label] of toggles){initial.push(await isChecked(page,path,label));await choose(page,path,label);}
  for(const [i,[path,label]] of toggles.entries())expect(await isChecked(page,path,label),label).toBe(!initial[i]);
  await reloadPersisted(page);
  // Restore in reverse: Touchscreen Mode hides Show Cursor While Editing, as on desktop.
  for(const [i,[path,label]] of [...toggles.entries()].reverse()){
    expect(await isChecked(page,path,label),label+' after reload').toBe(!initial[i]);
    await choose(page,path,label);
    expect(await isChecked(page,path,label),label+' restored').toBe(initial[i]);
  }
});

const radios=[
  [['Value Displays','Middle C'],['C3','C4','C5']],[['Mouse Behavior'],['Legacy','Slow','Medium','Exact']],
  [['Workflow','Shift + F10 and Edit Parameter Value Shortcuts'],['Follow Keyboard Focus','Follow Mouse Hover Focus']],
  [['MPE Settings','MPE Pitch Bend Smoothing'],['Legacy','Slow Exponential','Fast Exponential','Fast Linear','No Smoothing']],
  [['MPE Settings','MPE Timbre Value Range'],['Unipolar','Bipolar']],
  [['MIDI Settings','Controller Smoothing'],['Legacy','Slow Exponential','Fast Exponential','Fast Linear','No Smoothing']],
  [['MIDI Settings','Sustain Pedal In Mono Mode'],['Sustain Pedal Holds All Notes (No Note Off Retrigger)','Sustain Pedal Allows Note Off Retrigger']],
  [['MIDI Settings','Default Channel For Menu-Based MIDI Learn'],['Omni',...Array.from({length:16},(_,i)=>'Channel '+(i+1))]],
  [['Tuning'],['Apply Tuning at MIDI Input','Apply Tuning After Modulation']],
];
test('choice groups select each option, persist the choice and restore the default',async({page})=>{
  test.setTimeout(300000);
  await start(page);
  for(const [path,options] of radios){
    const listed=await open(page,...path);
    const current=options.find(o=>listed.includes(o+' (Checked)'));
    expect(current,path.join(' > ')).toBeTruthy();
    for(const option of options){
      await choose(page,path,option);
      const now=await open(page,...path);
      expect(now.filter(l=>l.endsWith(' (Checked)')).filter(l=>options.includes(l.slice(0,-10))),option).toEqual([option+' (Checked)']);
    }
    // Tuning application mode belongs to the synth session, not user preferences.
    if(path[0]!=='Tuning'){
      await reloadPersisted(page);
      expect(await isChecked(page,path,options.at(-1)),path.join(' > ')+' persisted').toBe(true);
    }
    await choose(page,path,current);expect(await isChecked(page,path,current)).toBe(true);
  }
});

test('session toggles flip without becoming preferences',async({page})=>{
  // Transpose Octave by Tuning Period is synth session state; its default is
  // stored separately by "Set Transpose Octave by Tuning Period as Default".
  // Use MIDI Channel for Octave Shift is likewise synth storage state.
  await start(page);
  for(const label of ['Transpose Octave by Tuning Period','Use MIDI Channel for Octave Shift']){
    const before=await isChecked(page,['Tuning'],label);
    await choose(page,['Tuning'],label);
    expect(await isChecked(page,['Tuning'],label),label).toBe(!before);
    await choose(page,['Tuning'],label);
    expect(await isChecked(page,['Tuning'],label),label).toBe(before);
  }
});

test('value display, keyboard and virtual keyboard preferences change the editor',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  const pitch=page.getByRole('slider',{name:'Scene A Osc 1 Pitch',exact:true});
  const root=page.getByRole('slider',{name:'Scene A Keytrack Root Key',exact:true});
  await expect(root).toHaveAttribute('aria-valuetext',/C4/);
  await choose(page,['Value Displays','Middle C'],'C3');await expect(root).toHaveAttribute('aria-valuetext',/C3/);
  await choose(page,['Value Displays','Middle C'],'C4');
  const coarse=await pitch.getAttribute('aria-valuetext');
  await choose(page,['Value Displays'],'High Precision Value Readouts');
  await expect.poll(async()=>(await pitch.getAttribute('aria-valuetext')).length).toBeGreaterThan(coarse.length);
  await choose(page,['Value Displays'],'High Precision Value Readouts');
  // Use Keyboard Shortcuts off disables the original shortcuts.
  await choose(page,['Workflow'],'Use Keyboard Shortcuts');
  await page.locator('canvas').first().focus();await page.keyboard.press('Alt+m');await page.waitForTimeout(500);
  await expect(page.getByRole('group',{name:'Modulation List',exact:true})).toHaveCount(0);
  await choose(page,['Workflow'],'Use Keyboard Shortcuts');
  await page.locator('canvas').first().focus();await page.keyboard.press('Alt+m');
  await expect(page.getByRole('group',{name:'Modulation List',exact:true}).first()).toBeAttached();
  // Virtual Keyboard adds the keyboard below the editor; Oscilloscope and Edit Keyboard Shortcuts open overlays.
  const height=async()=>(await page.locator('canvas').first().boundingBox()).height;
  const before=await height();
  await choose(page,['Workflow'],'Virtual Keyboard');await expect.poll(height).toBeGreaterThan(before);
  await choose(page,['Workflow'],'Virtual Keyboard');await expect.poll(height).toBe(before);
  await page.locator('canvas').first().focus();await page.keyboard.press('Alt+m');
  await expect(page.getByRole('group',{name:'Modulation List',exact:true})).toHaveCount(0);
  await choose(page,['Workflow'],'Oscilloscope...');await expect(page.getByRole('group',{name:'Oscilloscope',exact:true})).toBeAttached();
  await choose(page,['Workflow'],'Edit Keyboard Shortcuts...');await expect(page.getByRole('group',{name:'Keyboard Shortcut Editor',exact:true}).first()).toBeAttached();
  // Enable MPE follows through to the MPE status control.
  await choose(page,['MPE Settings'],'Enable MPE');
  await expect(page.getByRole('checkbox',{name:'MPE',exact:true})).toHaveAttribute('aria-checked','true');
  await choose(page,['MPE Settings'],'Disable MPE');
  await expect(page.getByRole('checkbox',{name:'MPE',exact:true})).toHaveAttribute('aria-checked','false');
  // Set All Recommended Accessibility Options turns on the recommended options.
  await choose(page,['Accessibility'],'Set All Recommended Accessibility Options');
  expect(await isChecked(page,['Accessibility'],'Send Additional Accessibility Announcements')).toBe(true);
});

test('zoom menu sizes, steps, limits and default zoom',async({page})=>{
  test.setTimeout(120000);
  await start(page);const base=await width(page);
  const ratio=expected=>expect.poll(async()=>Math.round(await width(page)/base*100)).toBe(expected);
  for(const [label,expected] of [['Zoom to 125%',125],['Zoom to 150%',150],['Shrink by 25%',125],['Shrink by 10%',115],['Grow by 10%',125],['Grow by 25%',150],['Zoom to 100%',100]]){
    await choose(page,['Zoom'],label);await ratio(expected);
  }
  // Larger fixed sizes apply exactly; the page scrolls around the editor.
  for(const level of [175,200,300,400]){
    await choose(page,['Zoom'],`Zoom to ${level}%`);
    await ratio(level);
    expect((await open(page,'Zoom')).filter(l=>l.endsWith('(Checked)'))).toEqual([`Zoom to ${level}% (Checked)`]);await closeMenus(page);
  }
  await choose(page,['Zoom'],'Zoom to 100%');await ratio(100);
  // Largest and smallest are bounded by the browser viewport and the original minimum.
  await choose(page,['Zoom'],'Zoom to Smallest');await expect.poll(()=>width(page)).toBeLessThan(base);
  await choose(page,['Zoom'],'Zoom to Largest');await expect.poll(()=>width(page)).toBeGreaterThanOrEqual(base);
  await choose(page,['Zoom'],'Zoom to 100%');await ratio(100);
  await choose(page,['Zoom'],'Set Default Zoom Level to...');await prompt(page,'125');
  await reloadPersisted(page);
  await expect.poll(async()=>Math.round(await width(page)/base*100)).toBe(125);
  // Once a default exists, the menu offers to return to it and to replace it.
  await choose(page,['Zoom'],'Zoom to 150%');await ratio(150);
  await choose(page,['Zoom'],'Zoom to Default (125%)');await ratio(125);
  await choose(page,['Zoom'],'Zoom to 150%');await ratio(150);
  await choose(page,['Zoom'],'Set Current Zoom Level (150%) as Default');
  await reloadPersisted(page);await ratio(150);
  // The menu omits Zoom to Default while the editor is already at the default.
  expect((await open(page,'Zoom')).filter(l=>l.startsWith('Zoom to Default'))).toEqual([]);
  await choose(page,['Zoom'],'Zoom to 100%');await ratio(100);
  await choose(page,['Zoom'],'Zoom to Default (150%)');await ratio(150);
  await choose(page,['Zoom'],'Set Default Zoom Level to...');await prompt(page,'100');
});

test('help, community and about entries open their original destinations',async({page})=>{
  await page.addInitScript(()=>{globalThis.opened=[];window.open=url=>{opened.push(String(url));return null;};});
  await start(page);
  const cases=[[[],'Reach the Developers...',/discord|github|surge-synth/i],[[],'Read the Code...',/github\.com\/surge-synthesizer/],
    [[],'Download Additional Content...',/surge-synth/],[[],'Skin Library...',/skin/i],[[],'Surge XT Manual...',/manual-xt/],
    [[],'Surge XT Website...',/surge-synthesizer\.github\.io/],[['Skins'],'Skin Development Guide...',/skin/i]];
  for(const [path,label,url] of cases){
    const count=(await page.evaluate(()=>opened.length));
    await choose(page,path,label);
    await expect.poll(()=>page.evaluate(()=>opened.length),label).toBe(count+1);
    expect(await page.evaluate(()=>opened.at(-1)),label).toMatch(url);
  }
  await choose(page,[],'About Surge XT');
  await expect(page.getByRole('group',{name:/^About Surge XT/}).first()).toBeAttached();
});

test('skins menu switches, reloads and rescans skins',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  const pixels=()=>page.locator('canvas').first().screenshot();
  const classic=await pixels();
  await choose(page,['Skins'],'Surge Dark');
  await expect.poll(async()=>(await pixels()).equals(classic)).toBe(false);
  expect(await isChecked(page,['Skins'],'Surge Dark')).toBe(true);
  await choose(page,['Skins','Tutorials'],'01 Intro to Skins');
  expect(await isChecked(page,['Skins','Tutorials'],'01 Intro to Skins')).toBe(true);
  for(const label of ['Reload Current Skin','Rescan Skins']){
    await choose(page,['Skins'],label);
    await expect(page.getByRole('button',{name:'Main Menu',exact:true})).toBeAttached();
  }
  await choose(page,['Skins'],'Menu Colors Follow OS Light/Dark Mode');
  expect(await isChecked(page,['Skins'],'Menu Colors Follow OS Light/Dark Mode')).toBe(true);
  await choose(page,['Skins'],'Menu Colors Applied from Skin');
  expect(await isChecked(page,['Skins'],'Menu Colors Applied from Skin')).toBe(true);
  await choose(page,['Skins'],'Surge Classic');
  await expect.poll(async()=>{const l=await open(page,'Skins');await closeMenus(page);return l;}).toContain('Surge Classic (Checked)');
  await choose(page,['Skins'],'Show Skin Inspector...');
  // The inspector is an original HTML report, shown in the browser report viewer.
  await expect(page.locator('#surge-report')).toBeVisible();
  await page.getByRole('button',{name:'Close report',exact:true}).click();
});

test('MPE ranges, tuning actions and MIDI mapping actions',async({page})=>{
  test.setTimeout(180000);
  await start(page);
  // MPE pitch bend range prompts.
  await choose(page,['MPE Settings'],'Change MPE Pitch Bend Range (Current: 48 Semitones)');await prompt(page,'24');
  expect(await open(page,'MPE Settings')).toContain('Change MPE Pitch Bend Range (Current: 24 Semitones)');
  await choose(page,['MPE Settings'],'Change Default MPE Pitch Bend Range (Current: 48 Semitones)');await prompt(page,'36');
  expect(await open(page,'MPE Settings')).toContain('Change Default MPE Pitch Bend Range (Current: 36 Semitones)');
  await closeMenus(page);
  // Tuning editor, remap, standard mapping/scale/tuning and the current-tuning labels.
  await choose(page,['Tuning'],'Open Tuning Editor...');await expect(page.getByRole('table',{name:'Tuning Table',exact:true})).toBeAttached();
  expect(await open(page,'Tuning')).toContain('Close Tuning Editor...');await closeMenus(page);
  await choose(page,['Tuning'],'Close Tuning Editor...');await expect(page.getByRole('table',{name:'Tuning Table',exact:true})).toHaveCount(0);
  await choose(page,['Tuning'],'Remap A4 (MIDI Note 69) Directly to...');await prompt(page,'432');
  await expect.poll(async()=>{await open(page,'Tuning');const t=await allTitles(page),i=await items(page);await closeMenus(page);
    return t.includes('Current Keyboard Mapping: Note 69 Retuned 440 to 432')&&i.includes('Set to Standard Mapping (Concert C)');}).toBe(true);
  await page.evaluate(()=>{window.showOpenFilePicker=async()=>[{getFile:async()=>new File(['! t.scl\nFive\n5\n!\n240.0\n480.0\n720.0\n960.0\n2/1\n'],'Five.scl')}];});
  await choose(page,['Tuning'],'Load .scl Tuning...');
  await expect.poll(async()=>{await open(page,'Tuning');const t=await allTitles(page);await closeMenus(page);return t.some(x=>x.startsWith('Current Tuning:'));}).toBe(true);
  await choose(page,['Tuning'],'Set to Standard Mapping (Concert C)');
  expect(await open(page,'Tuning')).not.toContain('Set to Standard Mapping (Concert C)');
  await choose(page,['Tuning'],'Set to Standard Scale (12-TET)');
  expect(await open(page,'Tuning')).not.toContain('Set to Standard Scale (12-TET)');
  await choose(page,['Tuning'],'Set Transpose Octave by Tuning Period as Default');
  await expect(page.getByRole('button',{name:'Main Menu',exact:true})).toBeAttached();
  // MIDI mapping: assign CC 70 to Global Volume, then show, save, clear, load by name and set as default.
  const volume=await page.getByRole('slider',{name:'Global Volume',exact:true}).boundingBox();
  await page.mouse.click(volume.x+volume.width/2,volume.y+volume.height/2,{button:'right'});
  for(const selector of ['[aria-label="Assign to MIDI CC"]','[aria-label="60 ... 79"]','[aria-label^="CC 70 ("]']){
    const item=page.getByRole('menu').last().locator(selector).first();
    await expect(item,selector).toBeAttached();await item.dispatchEvent('click');
  }
  await expect(page.getByRole('menu')).toHaveCount(0);
  const mapping=async()=>{
    await choose(page,['MIDI Settings'],'Show Current MIDI Mapping...');
    const report=page.frameLocator('#surge-report iframe').locator('body');await expect(report).toContainText('MIDI Mapping');
    const text=await report.innerText();await page.getByRole('button',{name:'Close report',exact:true}).click();
    return /Global Volume[\s\S]*?\b70\b|\b70\b[\s\S]*?Global Volume/.test(text);
  };
  await expect.poll(mapping).toBe(true);
  await choose(page,['MIDI Settings'],'Save MIDI Mapping As...');await prompt(page,'Browser Mapping');
  const file=()=>page.evaluate(()=>{const walk=p=>Module.FS.readdir(p).filter(n=>n[0]!=='.').flatMap(n=>{const c=p+'/'+n;return Module.FS.isDir(Module.FS.stat(c).mode)?walk(c):[c];});
    const f=walk('/user').find(p=>p.includes('Browser Mapping'));return f&&Module.FS.readFile(f,{encoding:'utf8'});});
  await expect.poll(file).toMatch(/70/);
  await choose(page,['MIDI Settings'],'Clear Current MIDI Mapping');
  expect(await mapping()).toBe(false);
  await choose(page,['MIDI Settings'],'Browser Mapping');
  await expect.poll(mapping).toBe(true);
  await choose(page,['MIDI Settings'],'Set Current MIDI Mapping as Default');
  await reloadPersisted(page);
  await expect.poll(mapping).toBe(true);
  await choose(page,['MIDI Settings'],'Clear Current MIDI Mapping');
  await choose(page,['MIDI Settings'],'Set Current MIDI Mapping as Default');
});

test('developer options, layout grid and desktop-only entries',async({page})=>{
  test.setTimeout(120000);
  const output=[];page.on('console',message=>output.push(message.text()));
  await start(page);
  // A right click on the main menu button adds the developer options, as on desktop.
  const devMenu=async(...path)=>{
    await closeMenus(page);
    await expect(async()=>{
      const box=await page.getByRole('button',{name:'Main Menu',exact:true}).boundingBox();
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2,{button:'right'});
      await expect(page.getByRole('menu').last().locator('[aria-label="Developer Options"]')).toBeAttached({timeout:1000});
    }).toPass();
    for(const name of path){
      const item=page.getByRole('menu').last().locator(`[aria-label="${css(name)}"]`).first();
      await expect(item,name).toBeAttached();await item.dispatchEvent('click');
    }
    return items(page);
  };
  // Melatonin and UI instrumentation are opt-in desktop build options (off by default);
  // the debug console is Windows-only. None is part of this configuration.
  expect(await devMenu('Developer Options')).toEqual(['Use Focus Debugger','Dump Undo/Redo Stack to stdout']);
  await page.getByRole('menu').last().locator('[aria-label="Use Focus Debugger"]').dispatchEvent('click');
  expect(await devMenu('Developer Options')).toContain('Use Focus Debugger (Checked)');
  await page.getByRole('menu').last().locator('[aria-label="Use Focus Debugger (Checked)"]').dispatchEvent('click');
  expect(await devMenu('Developer Options')).toContain('Use Focus Debugger');
  await page.getByRole('menu').last().locator('[aria-label="Dump Undo/Redo Stack to stdout"]').dispatchEvent('click');
  await expect.poll(()=>output.some(line=>line.includes('-------- UNDO/REDO'))).toBe(true);
  // Layout grid: shows the About screen grid, and the resolution prompt changes it.
  await devMenu('Skins','Show Layout Grid (20 px)');
  const about=page.getByRole('group',{name:/^About Surge XT/}).first();
  await expect(about).toBeAttached();
  // A click anywhere on the About screen closes it, as on desktop.
  const canvas=await page.locator('canvas').first().boundingBox();
  await page.mouse.click(canvas.x+canvas.width/2,canvas.y+canvas.height/2);await expect(about).toHaveCount(0);
  await devMenu('Skins','Change Layout Grid Resolution...');await prompt(page,'30');
  expect(await devMenu('Skins')).toContain('Show Layout Grid (30 px)');
  await page.getByRole('menu').last().locator('[aria-label="Change Layout Grid Resolution..."]').dispatchEvent('click');await prompt(page,'20');
  expect(await devMenu('Skins')).toContain('Show Layout Grid (20 px)');
  await closeMenus(page);
  // Without the developer options, skin categories and the layout grid are absent.
  const skins=await open(page,'Skins');
  expect(skins.filter(l=>/Layout Grid/.test(l))).toEqual([]);
  // MTS-ESP needs another process on the same machine; the browser build omits it.
  const tuning=await open(page,'Tuning');
  expect(tuning.filter(l=>/MTS|Query Tuning at Note On Only/.test(l))).toEqual([]);
  const workflow=await open(page,'Workflow');expect(workflow.filter(l=>/software renderer/i.test(l))).toEqual([]);
  const accessibility=await open(page,'Accessibility');expect(accessibility.filter(l=>/Announce Patch Browser Entries/.test(l))).toEqual([]);
  const zoom=await open(page,'Zoom');expect(zoom.filter(l=>/Fullscreen/.test(l))).toEqual([]);
  await closeMenus(page);
});

test('LFO preset refresh and non-default patch text export',async({page})=>{
  await start(page);
  // A preset written outside the menu appears only after Refresh Presets.
  const source=readFileSync(new URL('../../resources/data/modulator_presets/LFO/Delayed Vibrato.modpreset',import.meta.url),'utf8');
  const lfo=async()=>{
    await closeMenus(page);await page.getByRole('button',{name:'LFO Menu',exact:true}).dispatchEvent('click');
    await expect(page.getByRole('menu')).toHaveCount(1);return items(page);
  };
  await lfo();
  await page.evaluate(text=>{Module.FS.mkdirTree('/user/Modulator Presets/LFO');Module.FS.writeFile('/user/Modulator Presets/LFO/Outside Menu.modpreset',text);},source);
  await closeMenus(page);
  await page.getByRole('button',{name:'LFO Menu',exact:true}).dispatchEvent('click');
  await page.getByRole('menu').last().locator('[aria-label="Refresh Presets"]').dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await lfo();
  const user=page.getByRole('menu').last().locator('[aria-label="LFO"]').last();await user.dispatchEvent('click');
  await expect.poll(()=>items(page)).toContain('Outside Menu');
  await closeMenus(page);
  // Non-default export lists changed parameters only, unlike the full export.
  await choose(page,['Patch Settings'],'Export Patch as Text (All Parameters)');
  const report=page.frameLocator('#surge-report iframe').locator('body');
  await expect(report).toContainText('Osc 1');const all=(await report.innerText()).length;
  await page.getByRole('button',{name:'Close report',exact:true}).click();
  await choose(page,['Patch Settings'],'Export Patch as Text (Non-Default Parameters Only)');
  await expect(report).toContainText('Init Saw');
  const changed=(await report.innerText()).length;
  expect(changed).toBeGreaterThan(0);expect(changed).toBeLessThan(all);
  await page.getByRole('button',{name:'Close report',exact:true}).click();
});

test('embedded patch tuning, user MIDI mappings and the MPE timbre context menu',async({page})=>{
  test.setTimeout(120000);
  const scale=(steps,name)=>`! ${name}.scl\n${name}\n${steps}\n!\n`+Array.from({length:steps},(_,i)=>i===steps-1?'2/1':((i+1)*1200/steps).toFixed(8)).join('\n')+'\n';
  const template=readFileSync(new URL('../../resources/data/patches_factory/Templates/Init Sine.fxp',import.meta.url));
  const size=template.readUInt32LE(64);
  let xml=template.subarray(92,92+size).toString().replace(/\0+$/,'');
  xml=xml.replace('</patch>',`<patchTuning v="${Buffer.from(scale(7,'Embedded Seven')).toString('base64')}"/></patch>`);
  const payload=Buffer.from(xml),header=Buffer.from(template.subarray(0,92)),tail=template.subarray(92+size);
  header.writeUInt32LE(payload.length,64);header.writeUInt32BE(32+payload.length+tail.length,56);header.writeUInt32BE(84+payload.length+tail.length,4);
  const patch=[...Buffer.concat([header,payload,tail])];
  await start(page);
  const tuningTitle=async()=>{await open(page,'Tuning');const t=(await allTitles(page)).find(x=>x.startsWith('Current Tuning:'));await closeMenus(page);return t;};
  await choose(page,['Patch Settings','Tuning on Patch Load'],'Keep Current Tuning');
  await page.evaluate(bytes=>{
    const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],'Embedded Tuning.fxp'));
    document.querySelector('canvas').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,clientX:100,clientY:100,bubbles:true,cancelable:true}));
  },patch);
  await expect.poll(()=>page.evaluate(()=>Module.ccall('surge_browser_patch_name','string',[],[]))).toBe('Embedded Tuning');
  expect(await tuningTitle()).toBeUndefined();
  await choose(page,['Tuning'],'Load Tuning Embedded in Patch');
  await expect.poll(tuningTitle).toBe('Current Tuning: Embedded Seven');
  await choose(page,['Tuning'],'Set to Standard Tuning');
  await expect.poll(tuningTitle).toBeUndefined();
  await choose(page,['Patch Settings','Tuning on Patch Load'],'Override With Embedded Tuning if Available');
  // Saved MIDI mappings are listed under USER MIDI MAPPINGS and load by name.
  await choose(page,['MIDI Settings'],'Save MIDI Mapping As...');await prompt(page,'Menu Mapping');
  await expect.poll(async()=>{const l=await open(page,'MIDI Settings');await closeMenus(page);return l;}).toContain('Menu Mapping');
  await choose(page,['MIDI Settings'],'Menu Mapping');
  await expect(page.getByRole('button',{name:'Main Menu',exact:true})).toBeAttached();
  // With MPE on, the Timbre modulator's context menu offers the value range directly.
  await choose(page,['MPE Settings'],'Enable MPE');
  const timbre=await page.getByRole('group',{name:'MPE Timbre',exact:true}).boundingBox();
  const context=async()=>{
    await closeMenus(page);
    await page.mouse.click(timbre.x+timbre.width/2,timbre.y+timbre.height/2,{button:'right'});
    await expect(page.getByRole('menu')).toHaveCount(1);return items(page);
  };
  expect(await context()).toEqual(expect.arrayContaining(['Unipolar','Bipolar (Checked)']));
  await page.getByRole('menu').last().locator('[aria-label="Unipolar"]').dispatchEvent('click');
  expect(await isChecked(page,['MPE Settings','MPE Timbre Value Range'],'Unipolar')).toBe(true);
  expect(await context()).toContain('Unipolar (Checked)');
  await page.getByRole('menu').last().locator('[aria-label="Bipolar"]').dispatchEvent('click');
  expect(await isChecked(page,['MPE Settings','MPE Timbre Value Range'],'Bipolar')).toBe(true);
  await choose(page,['MPE Settings'],'Disable MPE');
});
