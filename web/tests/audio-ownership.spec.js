import {test,expect} from './fixtures.js';
const control=page=>page.evaluate(()=>JSON.parse(Module.ccall('surge_browser_control_state','string',[],[])));
const status=page=>page.evaluate(()=>Module._surge_browser_audio_status());
const blocks=page=>page.evaluate(()=>Module._surge_browser_audio_blocks());
const patchName=page=>page.evaluate(()=>Module.ccall('surge_browser_patch_name','string',[],[]));
const request=(page,name)=>page.evaluate(path=>Module.ccall('surge_browser_request_patch','number',['string'],[path]),
  `/factory/patches_factory/Templates/${name}.fxp`);
test('suspension hands the engine to control work only after the audio callback releases it',async({page})=>{
  test.setTimeout(90000);
  await page.goto('/surge-xt-browser.html');
  await expect(page.locator('canvas').first()).toBeVisible({timeout:60000});
  await page.getByRole('button',{name:'Enable audio',exact:true}).click();
  await expect.poll(()=>status(page),{timeout:15000}).toBe(2);
  await expect.poll(()=>blocks(page)).toBeGreaterThan(10);
  expect(await control(page)).toMatchObject({audioActive:1,audioReleasing:0});
  // Offline rendering can never overlap a created context.
  expect(await page.evaluate(()=>Module._surge_browser_offline_begin(48000))).toBe(0);

  await page.evaluate(()=>SurgeAudioInput.input.graph.context.suspend());
  await expect.poll(()=>status(page)).toBe(4);
  await expect.poll(()=>control(page)).toMatchObject({audioActive:0,audioReleasing:1,engineGate:0});
  const suspended=await blocks(page);
  // Control work now owns the engine and loads synchronously without a callback.
  expect(await request(page,'Init FM2')).toBe(1);
  await expect.poll(()=>patchName(page),{timeout:15000}).toBe('Init FM2');
  expect(await blocks(page)).toBe(suspended);
  expect(await control(page)).toMatchObject({audioActive:0,halted:0,engineGate:0});

  await page.getByRole('button',{name:'Enable audio',exact:true}).click();
  await expect.poll(()=>status(page)).toBe(2);
  await expect.poll(()=>blocks(page)).toBeGreaterThan(suspended+10);
  expect(await control(page)).toMatchObject({audioActive:1,audioReleasing:0});
  // A running context loads through the audio fade and background loader.
  expect(await request(page,'Init Sine')).toBe(1);
  await expect.poll(()=>patchName(page),{timeout:15000}).toBe('Init Sine');
  expect(await page.evaluate(()=>Module._surge_browser_midi(0x90,60,100,0))).toBe(1);
});
