import {test,expect} from './fixtures.js';
import {start,factoryPatch,savePatch} from './helpers/ui.js';
// Context menus of the FX grid, LFO and oscillator displays, MSEG settings and the
// oscilloscope (SurgeGUIEditor.cpp, LFOAndStepDisplay.cpp, OscillatorWaveformDisplay.cpp,
// MSEGEditor.cpp, Oscilloscope.cpp), opened on their canvas areas.
const css=text=>text.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
const items=page=>page.getByRole('menu').last().locator('[role^=menuitem]').evaluateAll(n=>n.map(x=>x.getAttribute('aria-label')).filter((l,i,a)=>l!==a[i-1]));
const allTitles=page=>page.evaluate(()=>JSON.parse(Module.ccall('surge_browser_open_menu_texts','string',[],[])));
async function closeMenus(page){
  if(!await page.getByRole('menu').count())return;
  await page.waitForTimeout(300);
  for(let i=0;i<8&&await page.getByRole('menu').count();++i){await page.keyboard.press('Escape');await page.waitForTimeout(150);}
  await expect(page.getByRole('menu')).toHaveCount(0);
}
// Right-clicks at a point (or a locator's centre) and follows `path`.
async function context(page,at,...path){
  await closeMenus(page);
  await expect(async()=>{
    const [x,y]=Array.isArray(at)?at:await at.boundingBox().then(b=>[b.x+b.width/2,b.y+b.height/2]);
    await page.mouse.click(x,y,{button:'right'});
    await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});
  }).toPass();
  await page.waitForTimeout(300);
  for(const name of path){
    const before=JSON.stringify(await items(page));
    const item=page.getByRole('menu').last().locator(`[aria-label="${css(name)}"],[aria-label="${css(name)} (Checked)"]`).first();
    await expect(item,name).toBeAttached();await item.dispatchEvent('click');
    await expect.poll(async()=>JSON.stringify(await items(page)),name).not.toBe(before);
  }
  return items(page);
}
async function pick(page,at,path,label){
  await context(page,at,...path);
  const item=page.getByRole('menu').last().locator(`[aria-label="${css(label)}"],[aria-label="${css(label)} (Checked)"]`).first();
  await expect(item,label).toBeAttached();await item.dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);await page.waitForTimeout(300);
}
async function radioGroup(page,at,options){
  for(const option of options){
    await pick(page,at,[],option);
    const listed=await context(page,at);
    expect(listed.filter(l=>options.includes(l.replace(/ \(Checked\)$/,''))&&l.endsWith(' (Checked)')),option).toEqual([option+' (Checked)']);
  }
  await closeMenus(page);
}
const tag=(xml,name)=>{
  const m=xml.match(new RegExp(`<${name}((?:\\s+[\\w]+="[^"]*")*)\\s*/?>`));
  return m&&Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(([,k,v])=>[k,v]));
};
let saves=0;
const save=page=>savePatch(page,`Display ${Date.now()%100000}-${++saves}`);
const node=(page,name)=>page.locator(`#juce-accessibility [aria-label="${css(name)}"]`).first();

test('FX grid scene labels set each scene hard clip mode',async({page})=>{
  await start(page);
  const grid=await page.getByRole('group',{name:'FX Slots',exact:true}).boundingBox();
  const row=async name=>{const b=await page.getByRole('radio',{name:new RegExp('^'+name+':')}).boundingBox();return [grid.x+4,b.y+b.height/2];};
  const a=await row('A Insert FX 1'),b=await row('B Insert FX 1');
  expect(await context(page,a)).toEqual(['FX Unit Selector (open manual)','Scene A Hard Clip Disabled','Scene A Hard Clip at 0 dBFS','Scene A Hard Clip at +18 dBFS (Checked)']);
  await radioGroup(page,a,['Scene A Hard Clip Disabled','Scene A Hard Clip at 0 dBFS']);
  await radioGroup(page,b,['Scene B Hard Clip at 0 dBFS','Scene B Hard Clip Disabled','Scene B Hard Clip at +18 dBFS']);
  await pick(page,b,[],'Scene B Hard Clip Disabled');
  // HardClipMode: 1 is +18 dBFS, 2 is 0 dBFS, 3 is disabled (scenes only).
  expect(tag(await save(page),'hardclipmodes')).toMatchObject({sc0:'2',sc1:'3'});
});

test('LFO display menus open editors, set MSEG looping and edit steps',async({page})=>{
  test.setTimeout(120000);
  await start(page);
  const display=[400,530];
  // MSEG: open or close the editor and choose the loop mode.
  await page.getByRole('radio',{name:'MSEG',exact:true}).dispatchEvent('click');await page.waitForTimeout(400);
  expect(await context(page,display)).toEqual(['MSEG Editor (open manual)','Open MSEG Editor...','No Looping','Loop Always','Loop Until Release (Checked)']);
  await radioGroup(page,display,['No Looping','Loop Always','Loop Until Release']);
  await pick(page,display,[],'Loop Always');
  // LoopMode: 1 no looping, 2 loop always, 3 loop until release.
  expect(tag(await save(page),'mseg').loopMode).toBe('2');
  await pick(page,display,[],'Open MSEG Editor...');
  await expect(page.getByRole('group',{name:'Voice MSEG 1 Editor',exact:true})).toBeAttached();
  // With the editor open, loop changes reopen it and the entry offers to close it.
  await pick(page,display,[],'No Looping');
  await expect(page.getByRole('group',{name:'Voice MSEG 1 Editor',exact:true})).toBeAttached();
  await expect(page.getByRole('group',{name:'Loop Mode',exact:true}).getByRole('radio',{name:'Off',exact:true})).toBeChecked();
  await pick(page,display,[],'Close MSEG Editor...');
  await expect(page.getByRole('group',{name:'Voice MSEG 1 Editor',exact:true})).toHaveCount(0);
  // Formula: the entry names the formula editor.
  await page.getByRole('radio',{name:'Formula',exact:true}).dispatchEvent('click');await page.waitForTimeout(400);
  expect(await context(page,display)).toEqual(['Formula Editor (open manual)','Open Formula Editor...']);
  await pick(page,display,[],'Open Formula Editor...');
  await expect(page.getByRole('group',{name:'Voice Formula 1 Editor',exact:true})).toBeAttached();
  await pick(page,display,[],'Close Formula Editor...');
  await expect(page.getByRole('group',{name:'Voice Formula 1 Editor',exact:true})).toHaveCount(0);
  // Step sequencer: a step's menu edits its value.
  await page.getByRole('radio',{name:'Step Sequencer',exact:true}).dispatchEvent('click');await page.waitForTimeout(400);
  const step=page.locator('#juce-accessibility [role=slider][aria-label="Step Value 1"]').first();
  const listed=await context(page,step);
  const entry=listed.find(l=>/^Edit Step 1 Value: /.test(l));expect(entry,JSON.stringify(listed)).toBeTruthy();
  await pick(page,step,[],entry);
  const field=page.getByRole('textbox',{name:'New Value',exact:true});await field.fill('37.5');await field.press('Enter');await expect(field).toHaveCount(0);
  expect(await context(page,step)).toContain('Edit Step 1 Value: 37.50 %');
  await closeMenus(page);
  // Steps are saved as s0...s15 on the first LFO's <sequence> element.
  expect(Number(tag(await save(page),'sequence').s0)).toBeCloseTo(0.375,4);
});

test('oscillator display menu switches views, playback modes and frame length',async({page})=>{
  test.setTimeout(120000);
  await start(page,factoryPatch('Templates/Init Wavetable'));
  const display=[75,130];
  const listed=await context(page,display);
  expect(listed).toEqual(expect.arrayContaining(['Switch to 3D Display','Load Wavetable from File...','Export Wavetable','Rename Wavetable...','Wavetable Script Editor...','PLAYBACK','Play as Wavetable (Checked)','Play as Oneshot Sample','Play as Looped Sample','INFO','Frame Length: 2048 samples']));
  // The INFO section reports the frame count.
  expect(listed).toContain('Number of Frames: 16');
  await pick(page,display,[],'Switch to 3D Display');
  expect(await context(page,display)).toContain('Switch to 2D Display');
  await pick(page,display,[],'Switch to 2D Display');
  expect(await context(page,display)).toContain('Switch to 3D Display');
  await radioGroup(page,display,['Play as Oneshot Sample','Play as Looped Sample','Play as Wavetable']);
  // Frame length resamples the table.
  const sizes=await context(page,display,'Frame Length: 2048 samples');
  expect(sizes).toEqual(expect.arrayContaining(['1024','2048 (Checked)','4096']));
  await pick(page,display,['Frame Length: 2048 samples'],'1024');
  await expect.poll(()=>page.evaluate(()=>Module._surge_browser_wt_size(0))).toBe(1024);
  expect(await context(page,display)).toContain('Frame Length: 1024 samples');
  await closeMenus(page);
  // The wavetable button lists categories; choosing a table from another category loads it.
  const button=page.getByRole('button',{name:/^Wavetable: /});
  const wtMenu=async(...path)=>{
    await closeMenus(page);
    await expect(async()=>{await button.dispatchEvent('click');await expect(page.getByRole('menu')).toHaveCount(1,{timeout:1000});}).toPass();
    await page.waitForTimeout(300);
    for(const name of path){
      const before=JSON.stringify(await items(page));
      await page.getByRole('menu').last().locator(`[aria-label="${css(name)}"],[aria-label="${css(name)} (Checked)"]`).first().dispatchEvent('click');
      await expect.poll(async()=>JSON.stringify(await items(page)),name).not.toBe(before);
    }
    return items(page);
  };
  // After resampling, the table no longer matches a factory entry, so no category is ticked.
  expect((await wtMenu()).map(l=>l.replace(/ \(Checked\)$/,''))).toEqual(expect.arrayContaining(['Basic','Generated','Scripted','Waldorf']));
  const generated=await wtMenu('Generated');
  await page.getByRole('menu').last().locator(`[aria-label="${css(generated[0])}"]`).first().dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>Module.ccall('surge_browser_wt_name','string',['number'],[0]))).toBe(generated[0]);
  expect(await wtMenu()).toContain('Generated (Checked)');
  // Scripted tables are listed with the original script icon and load the same way.
  const scripted=await wtMenu('Scripted');expect(scripted.length).toBeGreaterThan(0);
  await closeMenus(page);
});

test('MSEG snap grid menus and value entry',async({page})=>{
  await start(page);
  await page.getByRole('radio',{name:'MSEG',exact:true}).dispatchEvent('click');await page.waitForTimeout(400);
  await page.getByRole('button',{name:'Show MSEG Editor',exact:true}).dispatchEvent('click');
  const settings=page.getByRole('group',{name:'MSEG Settings',exact:true});await expect(settings).toBeAttached();
  const horizontal=settings.getByRole('slider',{name:'Horizontal Snap Grid',exact:true});
  expect(await context(page,horizontal)).toEqual(['MSEG Horizontal Snap Grid (open manual)','1','2','3','4','5','6','7','8 (Checked)','9','10','12','16','24','32','Edit Value: 8']);
  await pick(page,horizontal,[],'12');
  expect(await context(page,horizontal)).toContain('12 (Checked)');
  await pick(page,horizontal,[],'Edit Value: 12');
  const field=page.getByRole('textbox',{name:'New Value',exact:true});await field.fill('5');await field.press('Enter');await expect(field).toHaveCount(0);
  expect(await context(page,horizontal)).toContain('5 (Checked)');
  const vertical=settings.getByRole('slider',{name:'Vertical Snap Grid',exact:true});
  await pick(page,vertical,[],'16');
  expect(await context(page,vertical)).toContain('Edit Value: 16');
  await closeMenus(page);
});

test('oscilloscope mode switch menu',async({page})=>{
  await start(page);
  await page.locator('canvas').first().focus();await page.keyboard.press('Alt+o');
  const scope=page.getByRole('group',{name:'Oscilloscope',exact:true}).first();await expect(scope).toBeAttached();await page.waitForTimeout(400);
  const mode=[(await scope.boundingBox()).x,0];
  const b=await scope.locator('[role=group]').evaluateAll(n=>n.map(x=>x.getBoundingClientRect()).filter(r=>r.width>100&&r.width<200&&r.height<20).map(r=>[r.x+r.width/2,r.y+r.height/2]));
  expect(b.length).toBeGreaterThan(0);
  expect(await context(page,b[0])).toEqual(['Oscilloscope Mode (open manual)','Waveform (Checked)','Spectrum']);
  await pick(page,b[0],[],'Spectrum');
  expect(await context(page,b[0])).toContain('Spectrum (Checked)');
  await pick(page,b[0],[],'Waveform');
  expect(await context(page,b[0])).toContain('Waveform (Checked)');
  await closeMenus(page);
});

test('MSEG segment menu value entry and split',async({page})=>{
  await start(page);
  await page.getByRole('radio',{name:'MSEG',exact:true}).dispatchEvent('click');await page.waitForTimeout(400);
  await page.getByRole('button',{name:'Show MSEG Editor',exact:true}).dispatchEvent('click');
  const display=page.getByRole('group',{name:'MSEG Display/Editor',exact:true});await expect(display).toBeAttached();
  const segmentMenu=async()=>{await closeMenus(page);await display.focus();await page.keyboard.press('Shift+F10');await expect(page.getByRole('menu')).toHaveCount(1);await page.waitForTimeout(300);return items(page);};
  const mseg=async()=>tag(await save(page),'mseg');
  const segments=Number((await mseg()).activeSegments);
  // Value: opens the type-in for the selected node's value.
  const listed=await segmentMenu();
  const value=listed.find(l=>/^Value: /.test(l));expect(value,JSON.stringify(listed)).toBeTruthy();
  expect(listed.some(l=>/^Duration: /.test(l))).toBe(true);
  await page.getByRole('menu').last().locator(`[aria-label="${css(value)}"]`).dispatchEvent('click');
  const field=page.getByRole('textbox',{name:'New Value',exact:true});await field.fill('0.5');await field.press('Enter');await expect(field).toHaveCount(0);
  expect((await segmentMenu()).find(l=>/^Value: /.test(l))).toMatch(/^Value: 0\.50*$/);
  // Actions > Split divides the selected segment.
  await page.getByRole('menu').last().locator('[aria-label="Actions"]').dispatchEvent('click');
  await expect.poll(()=>items(page)).toContain('Split');
  await page.getByRole('menu').last().locator('[aria-label="Split"]').dispatchEvent('click');
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(Number((await mseg()).activeSegments)).toBe(segments+1);
});
