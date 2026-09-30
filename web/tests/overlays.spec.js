import {test,expect} from './fixtures.js';
import {start,factoryPatch} from './helpers/ui.js';
// Every reachable overlay (SurgeGUIEditor::OverlayTags): it opens, takes JUCE keyboard
// focus, keeps Tab traversal inside its focus container, and closes back to the editor.
const controls=async page=>JSON.parse(await page.evaluate(()=>Module.ccall('surge_browser_skin_controls','string',[],[])));
// The canvas names JUCE's focused component through aria-activedescendant.
const focused=page=>page.evaluate(()=>{
  const canvas=[...document.querySelectorAll('canvas')].find(c=>c.getAttribute('aria-activedescendant'));
  const node=canvas&&document.getElementById(canvas.getAttribute('aria-activedescendant'));
  if(!node)return null;
  const groups=[];for(let n=node;n;n=n.parentElement)if(n.getAttribute?.('role')==='group'&&n.getAttribute('aria-label'))groups.push(n.getAttribute('aria-label'));
  return {name:node.getAttribute('aria-label'),role:node.getAttribute('role'),groups};
});
const canvas=page=>page.locator('canvas').first();
const cases=[
  {tag:'MODULATION_EDITOR',title:'Modulation List',open:async page=>{await canvas(page).focus();await page.keyboard.press('Alt+m');}},
  // The oscilloscope and filter analysis leave focus in the editor (wantsInitialKeyboardFocus is false).
  {tag:'OSCILLOSCOPE',title:'Oscilloscope',initialFocus:false,open:async page=>{await canvas(page).focus();await page.keyboard.press('Alt+o');}},
  {tag:'TUNING_EDITOR',title:/^Tuning Editor/,open:async page=>{await canvas(page).focus();await page.keyboard.press('Alt+t');},
    close:async page=>{await canvas(page).focus();await page.keyboard.press('Alt+t');}},
  {tag:'KEYBINDINGS_EDITOR',title:'Keyboard Shortcut Editor',open:async page=>{await canvas(page).focus();await page.keyboard.press('Alt+b');},
    close:async(page,group)=>group.getByRole('button',{name:'OK',exact:true}).dispatchEvent('click')},
  // Code editors take Tab as text (it would edit the script); the MSEG canvas consumes it for node editing.
  {tag:'WTS_EDITOR',title:'Osc 1 Wavetable Script Editor',patch:'Templates/Init Wavetable',tab:false,open:async page=>{await canvas(page).focus();await page.keyboard.press('Alt+w');}},
  {tag:'MSEG_EDITOR',title:'Voice MSEG 1 Editor',tabMoves:false,open:async page=>{await page.getByRole('radio',{name:'MSEG',exact:true}).dispatchEvent('click');await canvas(page).focus();await page.keyboard.press('Alt+e');}},
  {tag:'FORMULA_EDITOR',title:'Voice Formula 1 Editor',tab:false,open:async page=>{await page.getByRole('radio',{name:'Formula',exact:true}).dispatchEvent('click');await canvas(page).focus();await page.keyboard.press('Alt+e');}},
  {tag:'FILTER_ANALYZER',title:'Filter Analysis',initialFocus:false,control:'filter.filter_preview'},
  {tag:'WAVESHAPER_ANALYZER',title:'Waveshaper Analysis',control:'filter.waveshaper_preview'},
  {tag:'SAVE_PATCH',title:'Save Patch',open:async page=>{await page.getByRole('button',{name:'Save Patch',exact:true}).dispatchEvent('click');},
    close:async(page,group)=>group.getByRole('button',{name:'Cancel',exact:true}).dispatchEvent('click')},
];
for(const c of cases)test(`${c.tag} overlay takes focus, contains Tab traversal and closes`,async({page})=>{
  await start(page,c.patch&&factoryPatch(c.patch));
  if(c.control){
    const control=(await controls(page)).find(x=>x.id===c.control);const [x,y,w,h]=control.bounds;
    await page.mouse.click(x+w/2,y+h/2);
  }else await c.open(page);
  const group=page.getByRole('group',{name:c.title,exact:typeof c.title==='string'}).first();
  await expect(group).toBeAttached();
  const title=await group.getAttribute('aria-label');
  if(c.initialFocus===false){
    // Focus stays with the editor, as on desktop.
    await page.waitForTimeout(400);
    expect((await focused(page))?.groups??[]).not.toContain(title);
  }else{
    // Focus moves into the overlay.
    await expect.poll(async()=>(await focused(page))?.groups.includes(title),'initial focus').toBe(true);
    // Tab and Shift+Tab stay inside the overlay's focus container.
    const seen=new Set();
    for(const key of c.tab===false?[]:['Tab','Tab','Tab','Tab','Shift+Tab','Shift+Tab']){
      await page.keyboard.press(key);await page.waitForTimeout(150);
      const now=await focused(page);
      expect(now?.groups,`${key} from ${[...seen].at(-1)}`).toContain(title);
      seen.add(now.name);
    }
    if(c.tab!==false&&c.tabMoves!==false)expect(seen.size,'Tab moved between controls').toBeGreaterThan(1);
  }
  // Closing returns focus to the editor.
  if(c.close)await c.close(page,group);
  else await group.getByRole('button',{name:'close',exact:true}).dispatchEvent('click');
  await expect(page.getByRole('group',{name:c.title,exact:typeof c.title==='string'})).toHaveCount(0);
  await expect.poll(async()=>{const f=await focused(page);return c.initialFocus===false?!f?.groups.includes(title):!!f&&!f.groups.includes(title);},'focus after close').toBe(true);
});

test('overlays without a route in the original stay unreachable',async({page})=>{
  await start(page);
  // PATCH_BROWSER is only opened by PatchSelector::openPatchBrowser, which nothing calls, and its
  // shortcut is compiled out (INCLUDE_PATCH_BROWSER); ACTION_HISTORY creates no overlay (a TODO upstream).
  await canvas(page).focus();await page.keyboard.press('Alt+b');
  const editor=page.getByRole('group',{name:'Keyboard Shortcut Editor',exact:true}).first();await expect(editor).toBeAttached();
  const rows=new Set();await page.mouse.move(450,300);
  for(let i=0;i<10;i++){
    for(const name of await editor.getByRole('listitem').evaluateAll(n=>n.map(x=>x.getAttribute('aria-label'))))rows.add(name);
    await page.mouse.wheel(0,300);await page.waitForTimeout(200);
  }
  expect([...rows].filter(n=>/patch (browser|database)|action history/i.test(n))).toEqual([]);
  await editor.getByRole('button',{name:'OK',exact:true}).dispatchEvent('click');
  expect(await page.getByRole('group',{name:/Patch Database|Action History/}).count()).toBe(0);
});

test('an overlay tears out into its own window and closes from there',async({page})=>{
  await start(page);
  await canvas(page).focus();await page.keyboard.press('Alt+m');
  const list=page.getByRole('group',{name:'Modulation List',exact:true}).first();await expect(list).toBeAttached();
  const canvases=()=>page.locator('canvas').count();
  const before=await canvases();
  await list.getByRole('button',{name:'maximize',exact:true}).dispatchEvent('click');
  // The torn-out overlay gets its own window (a separate canvas peer) with the same controls.
  await expect.poll(canvases).toBe(before+1);
  await expect(list.getByRole('button',{name:'Add Modulation Source',exact:true})).toBeAttached();
  await list.getByRole('button',{name:'close',exact:true}).first().dispatchEvent('click');
  await expect(page.getByRole('group',{name:'Modulation List',exact:true})).toHaveCount(0);
  await expect.poll(canvases).toBe(before);
});
