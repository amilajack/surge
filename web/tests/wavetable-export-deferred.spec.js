import {test,expect} from './fixtures.js';
// A deliberately slow script, so each export is still generating when checked.
const slow=`function init(wt) wt.name = "Slow Export" return wt end
function generate(wt)
  local spin = 0
  for k = 1, 4000000 do spin = spin + k % 3 end
  local result = {}
  for i = 1, wt.sample_count do result[i] = 0.5 end
  return result
end`;
async function open(page){
  await page.goto('/surge-xt-browser.html');
  await expect.poll(()=>page.evaluate(()=>globalThis.Module?.ccall('surge_browser_patch_name','string',[],[]))).toBe('Init Saw');
  await page.evaluate(()=>Module.ccall('surge_browser_request_patch','number',['string'],['/factory/patches_factory/Templates/Init Wavetable.fxp']));
  await expect.poll(()=>page.evaluate(()=>Module.ccall('surge_browser_patch_name','string',[],[]))).toBe('Init Wavetable');
  await page.locator('canvas').first().focus();await page.keyboard.press('Alt+w');
  const editor=page.getByRole('textbox',{name:'Wavetable Code',exact:true});
  await editor.fill(slow);await page.getByRole('button',{name:'Generate',exact:true}).dispatchEvent('click');
  await expect.poll(()=>page.evaluate(()=>Module.ccall('surge_browser_wt_name','string',['number'],[0])),{timeout:60000}).toBe('Slow Export');
  await page.evaluate(()=>{
    globalThis.exported=null;
    window.showSaveFilePicker=async()=>({name:'slow.wt',createWritable:async()=>({
      write:async bytes=>{exported=Array.from(bytes);},close:async()=>{},abort:async()=>{}})});
  });
}
async function exportTable(page){
  await page.getByRole('button',{name:'Wavetable Script Menu',exact:true}).dispatchEvent('click');
  await page.getByRole('menuitem',{name:/export as \.wt/i}).dispatchEvent('click');
  await expect(page.locator('#file-status')).toHaveText('Preparing export…');
}
test('script export generates off the main thread and then writes the file',async({page})=>{
  test.setTimeout(120000);
  await open(page);await exportTable(page);
  // The page keeps responding while the worker generates the table.
  const started=Date.now();await page.evaluate(()=>1);expect(Date.now()-started).toBeLessThan(1000);
  await expect.poll(()=>page.evaluate(()=>exported?.length||0),{timeout:60000}).toBeGreaterThan(12);
  const bytes=Buffer.from(await page.evaluate(()=>exported));
  expect(bytes.subarray(0,4).toString()).toBe('vawt');expect(bytes.readFloatLE(12)).toBe(0.5);
  await expect(page.locator('#file-status')).toHaveText('');
  await expect(page.getByRole('button',{name:'Cancel export',exact:true})).toHaveCount(0);
});
test('canceling a pending script export writes nothing',async({page})=>{
  test.setTimeout(120000);
  await open(page);await exportTable(page);
  await page.getByRole('button',{name:'Cancel export',exact:true}).click();
  await expect(page.locator('#file-status')).toHaveText('Export canceled. No file was written.');
  // Let the worker finish; its late completion must not reach the destination.
  await page.waitForTimeout(8000);
  expect(await page.evaluate(()=>exported)).toBeNull();
});
test('closing the script editor does not abandon a pending export',async({page})=>{
  test.setTimeout(120000);
  await open(page);await exportTable(page);
  await page.getByRole('group',{name:'Osc 1 Wavetable Script Editor',exact:true}).getByRole('button',{name:'close',exact:true}).dispatchEvent('click');
  await expect(page.getByRole('textbox',{name:'Wavetable Code',exact:true})).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>exported?.length||0),{timeout:60000}).toBeGreaterThan(12);
});
