import {test,expect} from './fixtures.js';
// Every heap request made inside an audio callback is either served by the
// real-time pool or counted as a system-heap call. The engine must make none.
const counters=page=>page.evaluate(()=>({heap:Module._surge_browser_audio_allocations(),heapReleases:Module._surge_browser_audio_releases(),
  pool:Module._surge_browser_audio_pool_allocations(),poolReleases:Module._surge_browser_audio_pool_releases()}));
const reset=page=>page.evaluate(()=>Module._surge_browser_audio_allocations_reset());
const midi=(page,events)=>page.evaluate(events=>{for(const e of events)Module._surge_browser_midi(...e,0);},events);
const chord=(notes,on=true)=>notes.map(n=>on?[0x90,n,100]:[0x80,n,0]);
async function load(page,path){
  await page.evaluate(path=>Module.ccall('surge_browser_request_patch','number',['string'],[path]),`/factory/patches_factory/${path}.fxp`);
  await expect.poll(()=>page.evaluate(()=>Module.ccall('surge_browser_patch_name','string',[],[])),{timeout:20000}).toBe(path.split('/').pop());
}
test('audio callbacks make no system heap calls across performance and patch workflows',async({page})=>{
  test.setTimeout(180000);
  await page.goto('/surge-xt-browser.html');
  await expect(page.locator('canvas').first()).toBeVisible({timeout:60000});
  await page.getByRole('button',{name:'Enable audio',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>Module._surge_browser_audio_status()),{timeout:15000}).toBe(2);
  const blocks=()=>page.evaluate(()=>Module._surge_browser_audio_blocks());
  const settle=async()=>{const start=await blocks();await expect.poll(blocks).toBeGreaterThan(start+60);};
  await reset(page);
  const checks=[];
  const check=async(name,action)=>{await action();await settle();checks.push([name,await counters(page)]);};
  await check('idle',async()=>{});
  await check('notes',()=>midi(page,chord([48,52,55,60,64,67,71,74])));
  await check('controllers',()=>midi(page,[...Array.from({length:16},(_,i)=>[0xb0,1,i*8]),[0xe0,0,90],[0xd0,70,0]]));
  await check('release',()=>midi(page,chord([48,52,55,60,64,67,71,74],false)));
  await check('voice stealing',()=>midi(page,chord(Array.from({length:90},(_,i)=>20+i))));
  await check('panic',()=>page.evaluate(()=>Module._surge_browser_panic()));
  await check('parameter edits',async()=>{const slider=page.getByRole('slider').first();await slider.focus();for(let i=0;i<12;++i)await page.keyboard.press('ArrowUp');});
  for(const patch of ['Templates/Init FM2','Tutorials/Formula Modulator/01 A Simple Formula',
    'Tutorials/Formula Modulator/10 Example - Both Time And Space','Tutorials/Formula Modulator/07 The Prelude','Vocoder/Solo','Templates/Audio In Mono Osc 1']){
    await check(`live load ${patch}`,()=>load(page,patch));
    await check(`play ${patch}`,()=>midi(page,chord([48,55,60,64,67])));
    await check(`hold ${patch}`,async()=>{});
    await check(`release ${patch}`,()=>midi(page,chord([48,55,60,64,67],false)));
  }
  const offenders=checks.filter(([,c])=>c.heap||c.heapReleases);
  expect(offenders).toEqual([]);
  // The pool served the allocating paths (formula first attacks, Twist/String voices)
  // and got its blocks back once those voices ended.
  const total=checks.at(-1)[1];
  expect(total.pool).toBeGreaterThan(0);
  await expect.poll(async()=>(await counters(page)).poolReleases).toBeGreaterThan(0);
  expect(await page.evaluate(()=>Module._surge_browser_audio_pool_used())).toBeLessThan(64<<20);
});
