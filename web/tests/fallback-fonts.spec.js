import {test,expect} from './fixtures.js';
import {readFileSync} from 'node:fs';
const patch=[...readFileSync(new URL('../../resources/data/patches_factory/Templates/Init Sine.fxp',import.meta.url))];
const name='日本語 한국어 😀';
async function open(page,requests){
  page.on('request',request=>{if(request.url().includes('/fonts-fallback/'))requests.push(request.url());});
  await page.goto('/surge-xt-browser.html');
  await expect.poll(()=>page.evaluate(()=>globalThis.Module?.ccall('surge_browser_patch_name','string',[],[]))).toBe('Init Saw');
}
async function dropNamed(page){
  await page.evaluate(([bytes,name])=>{
    const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],name+'.fxp'));
    document.querySelector('canvas').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,clientX:100,clientY:100,bubbles:true,cancelable:true}));
  },[patch,name]);
  await expect.poll(()=>page.evaluate(()=>Module.ccall('surge_browser_patch_name','string',[],[]))).toBe(name);
}
// The patch name is drawn in the patch browser strip at the top centre of the canvas.
const nameArea=page=>page.locator('canvas').first().screenshot({clip:{x:250,y:14,width:320,height:24}});
test('text in the bundled fonts never fetches the fallback fonts',async({page})=>{
  const requests=[];await open(page,requests);
  await page.waitForTimeout(1000);
  expect(requests).toEqual([]);
});
test('CJK and emoji text fetches the fallback fonts once and renders glyphs instead of boxes',async({page,browser})=>{
  test.setTimeout(90000);
  const requests=[];await open(page,requests);
  const missing=text=>page.evaluate(text=>Module.ccall('surge_browser_missing_glyphs','number',['string'],[text]),text);
  expect(await missing('Plain Latin text')).toBe(0);
  await dropNamed(page);
  await expect.poll(()=>page.evaluate(()=>Module.FS.analyzePath('/fonts/fallback').exists&&Module.FS.readdir('/fonts/fallback').length)).toBe(5);
  expect(requests.length).toBe(3);
  // Every Japanese, Korean and emoji glyph now resolves through a fallback face.
  await expect.poll(()=>missing(name)).toBe(0);
  await page.waitForTimeout(500);const withFonts=await nameArea(page);
  // Without the fallback fonts the same text renders as missing-glyph boxes.
  const blocked=await browser.newPage({viewport:{width:1100,height:750}});
  await blocked.route('**/fonts-fallback/**',route=>route.fulfill({status:404,body:''}));
  const none=[];await open(blocked,none);await dropNamed(blocked);
  await expect(blocked.locator('#file-status')).toContainText('Fallback fonts unavailable');
  await blocked.waitForTimeout(500);const boxes=await nameArea(blocked);
  expect(withFonts.equals(boxes)).toBe(false);
  await blocked.close();
});
