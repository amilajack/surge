import {test,expect} from './fixtures.js';
import {start,mainMenu,factoryPatch,patchName,enableAudio} from './helpers/ui.js';
// Original JUCE keyboard actions through their default (or shortcut-editor) bindings.
const canvas=page=>page.locator('canvas').first();
async function press(page,key){await canvas(page).focus();await page.keyboard.press(key);}
const group=(page,name)=>page.getByRole('group',{name,exact:typeof name==='string'}).first();
async function recordKeys(page){
  await page.addInitScript(()=>{globalThis.keyEvents=[];document.addEventListener('keydown',e=>
    setTimeout(()=>keyEvents.push({key:e.key,prevented:e.defaultPrevented})));});
}
async function bind(page,row,chord){
  await press(page,'Alt+b');
  const overlay=group(page,'Keyboard Shortcut Editor');await expect(overlay).toBeAttached();
  const item=overlay.getByRole('listitem',{name:row,exact:true});
  await page.mouse.move(450,300);
  for(let i=0;i<6&&!(await item.count());++i)await page.mouse.wheel(0,400);
  await item.getByRole('button',{name:'Learn '+row,exact:true}).dispatchEvent('click');
  await canvas(page).focus();await page.keyboard.press(chord);
  await overlay.getByRole('button',{name:'OK',exact:true}).dispatchEvent('click');
  await expect(overlay).toHaveCount(0);
}

test('undo and redo shortcuts reverse and reapply an edit',async({page})=>{
  await start(page);
  const volume=page.getByRole('slider',{name:'Global Volume',exact:true});
  const value=()=>volume.getAttribute('aria-valuenow');
  // Wait for the loaded Init Saw volume (-2.03 dB), not the startup default.
  await expect.poll(value).not.toBe('1');const before=await value();
  // Edit through the slider's own key handling, as a desktop keyboard user does;
  // JUCE keeps focus on the slider while the canvas holds DOM focus.
  await volume.focus();await canvas(page).focus();await page.keyboard.press('End');
  await expect.poll(value).not.toBe(before);const edited=await value();
  await press(page,'Control+z');await expect.poll(value).toBe(before);
  await press(page,'Control+y');await expect.poll(value).toBe(edited);
});

test('save shortcut opens the original dialog instead of the browser save',async({page})=>{
  await recordKeys(page);await start(page);
  await press(page,'Control+s');
  await expect(page.getByRole('textbox',{name:'patch name',exact:true})).toBeAttached();
  await expect.poll(()=>page.evaluate(()=>keyEvents.find(e=>e.key==='s'))).toMatchObject({prevented:true});
  await page.getByRole('button',{name:'Cancel',exact:true}).dispatchEvent('click');
});

test('patch and category jog shortcuts step through the factory library',async({page})=>{
  await start(page);
  await press(page,'Control+ArrowRight');await expect.poll(()=>patchName(page)).not.toBe('Init Saw');
  await press(page,'Control+ArrowLeft');await expect.poll(()=>patchName(page)).toBe('Init Saw');
  await press(page,'Shift+ArrowRight');await expect.poll(()=>patchName(page)).not.toBe('Init Saw');
  const first=await patchName(page);
  await press(page,'Shift+ArrowRight');await expect.poll(()=>patchName(page)).not.toBe(first);
  await press(page,'Shift+ArrowLeft');await expect.poll(()=>patchName(page)).toBe(first);
});

test('unbound patch and zoom actions work once bound in the shortcut editor',async({page})=>{
  await start(page,factoryPatch('Templates/Init FM2'));
  await bind(page,'Initialize Patch','Alt+Shift+i');
  await press(page,'Alt+Shift+i');await expect.poll(()=>patchName(page)).toBe('Init Saw');
  await bind(page,'Random Patch','Alt+Shift+r');
  await press(page,'Alt+Shift+r');await expect.poll(()=>patchName(page)).not.toBe('Init Saw');
  await press(page,'Control+z');await expect.poll(()=>patchName(page)).toBe('Init Saw');
  // Fullscreen is disabled in the original handler as well: the key is consumed without effect.
  const width=(await canvas(page).boundingBox()).width;
  await bind(page,'Zoom: Toggle Fullscreen','Alt+Shift+z');
  await press(page,'Alt+Shift+z');await page.waitForTimeout(300);
  expect((await canvas(page).boundingBox()).width).toBe(width);
  expect(await page.evaluate(()=>document.fullscreenElement)).toBeNull();
});

test('overlay shortcuts toggle the original editors',async({page})=>{
  await start(page,factoryPatch('Templates/Init Wavetable'));
  for(const [key,locator] of [['Alt+m',group(page,'Modulation List')],['Alt+o',group(page,'Oscilloscope')],
      ['Alt+t',page.getByRole('table',{name:'Tuning Table',exact:true})],['Alt+w',page.getByRole('textbox',{name:'Wavetable Code',exact:true})],
      ['F12',group(page,/^About Surge XT/)],['Alt+l',group(page,/^About Surge XT/)]]){
    await press(page,key);await expect(locator,key).toBeAttached();
    if(key==='Alt+w'){
      // The script editor takes JUCE focus. Its code editor then receives Option
      // characters (Option+W types ∑ on macOS, as in the desktop app), so close it.
      await group(page,'Osc 1 Wavetable Script Editor').getByRole('button',{name:'close',exact:true}).dispatchEvent('click');
    }else await press(page,key);
    await expect(locator,key).toHaveCount(0);
  }
  for(const [shape,editor] of [['MSEG','Voice MSEG 1 Editor'],['Formula','Voice Formula 1 Editor']]){
    await page.getByRole('radio',{name:shape,exact:true}).dispatchEvent('click');
    await press(page,'Alt+e');await expect(group(page,editor)).toBeAttached();
    // The formula editor's code editor also takes Option keys (Option+E is a dead key).
    if(shape==='Formula')await group(page,editor).getByRole('button',{name:'close',exact:true}).dispatchEvent('click');
    else await press(page,'Alt+e');
    await expect(group(page,editor)).toHaveCount(0);
  }
});

test('modulator arm shortcut shows modulation depths on the sliders',async({page})=>{
  await start(page);
  const pitch=page.getByRole('slider',{name:'Scene A Osc 1 Pitch',exact:true});
  await press(page,'Alt+a');await expect(pitch).toHaveAttribute('aria-valuetext',/ mod /);
  await press(page,'Alt+a');await expect(pitch).not.toHaveAttribute('aria-valuetext',/ mod /);
});

test('zoom shortcuts resize the editor in the original steps',async({page})=>{
  await start(page);
  const width=async()=>(await canvas(page).boundingBox()).width;
  const base=await width();
  const ratio=async expected=>expect.poll(async()=>Math.round(await width()/base*100)).toBe(expected);
  await press(page,'NumpadAdd');await ratio(110);
  await press(page,'Minus');await ratio(100);
  await press(page,'Shift+Equal');await ratio(125);
  await press(page,'Shift+NumpadSubtract');await ratio(100);
  // Shift+/ produces '?', so the default Zoom: Default binding never fires on
  // US layouts, as in the original. A learned binding reaches the same action.
  await press(page,'NumpadAdd');await ratio(110);
  await bind(page,'Zoom: Default','Alt+Shift+d');
  await press(page,'Alt+Shift+d');await ratio(100);
});

test('virtual keyboard octave shortcuts transpose played notes',async({page})=>{
  test.setTimeout(90000);
  await start(page,factoryPatch('Templates/Init Sine'));await enableAudio(page);
  await page.evaluate(()=>{
    const {context,node}=SurgeAudioInput.input.graph;node.disconnect();
    const analyser=context.createAnalyser();analyser.fftSize=4096;const silent=context.createGain();silent.gain.value=0;
    node.connect(analyser);analyser.connect(silent);silent.connect(context.destination);globalThis.probe={analyser,context};
  });
  const play=async midi=>{
    await canvas(page).focus();await page.keyboard.down('a');
    const expected=440*2**((midi-69)/12);
    await expect.poll(()=>page.evaluate(expected=>{
      const {analyser,context}=probe,s=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(s);const c=[];
      for(let i=1;i<s.length;i++)if(s[i-1]<=0&&s[i]>0)c.push(i-1-s[i-1]/(s[i]-s[i-1]));
      return c.length>4?Math.abs(context.sampleRate*(c.length-1)/(c.at(-1)-c[0])/expected-1):1;
    },expected)).toBeLessThan(0.002);
    await page.keyboard.up('a');await expect.poll(()=>page.evaluate(()=>Module._surge_browser_active_voices())).toBe(0);
  };
  await press(page,'Alt+k');await play(60);
  await press(page,'c');await play(72);
  await press(page,'x');await press(page,'x');await play(48);
});

test('refresh skin, manual and announcement shortcuts',async({page})=>{
  await recordKeys(page);
  await page.addInitScript(()=>{globalThis.opened=[];window.open=url=>{opened.push(String(url));return null;};});
  await start(page);
  await page.evaluate(()=>{globalThis.sameDocument=true;});
  await press(page,'F5');
  await expect.poll(()=>page.evaluate(()=>keyEvents.find(e=>e.key==='F5'))).toMatchObject({prevented:true});
  await page.waitForTimeout(500);expect(await page.evaluate(()=>globalThis.sameDocument)).toBe(true);
  await expect(page.getByRole('button',{name:'Main Menu',exact:true})).toBeAttached();
  await press(page,'F1');
  await expect.poll(()=>page.evaluate(()=>opened)).toEqual([expect.stringMatching(/^https:\/\/surge-synthesizer\.github\.io\/manual-xt\//)]);
  await mainMenu(page,'Accessibility','Send Additional Accessibility Announcements');
  await press(page,'Alt+0');
  await expect.poll(()=>page.evaluate(()=>[...document.querySelectorAll('[aria-live]')].map(n=>n.textContent).join(' ')))
    .toContain("Patch 'Init Saw'. Scene A.");
});

test('the shortcut editor lists every bindable action and no patch browser action',async({page})=>{
  await start(page);await press(page,'Alt+b');
  const overlay=group(page,'Keyboard Shortcut Editor');await expect(overlay).toBeAttached();
  const rows=new Set();await page.mouse.move(450,300);
  for(let i=0;i<10;i++){
    for(const name of await overlay.getByRole('listitem').evaluateAll(n=>n.map(x=>x.getAttribute('aria-label'))))rows.add(name);
    await page.mouse.wheel(0,300);await page.waitForTimeout(300);
  }
  // TOGGLE_PATCH_BRWOSER has no name, binding or handler in the original.
  expect(rows.size).toBe(40);
  expect([...rows].filter(name=>/patch browser|patch database/i.test(name))).toEqual([]);
  for(const name of ['Initialize Patch','Random Patch','Zoom: Toggle Fullscreen','Refresh Skin','Toggle Layout Grid','Open Manual',
    'About Surge XT','Announce Editor State with Accessible API','Move Focus to Next Control Group','Move Focus to Previous Control Group'])
    expect(rows.has(name),name).toBe(true);
});
