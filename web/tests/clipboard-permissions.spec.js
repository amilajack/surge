import {test,expect} from './fixtures.js';
// Real Chrome clipboard (no navigator.clipboard mock): permission grants and denials.
const editorText=page=>page.evaluate(()=>Module.ccall('surge_check_editor_text','string',['number'],[0]));
async function open(page){
  await page.goto('/surge-juce-browser-check.html');
  await expect(page.locator('canvas')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>Module._surge_check_timer_callbacks())).toBeGreaterThan(2);
  await page.mouse.click(120,280);await page.keyboard.press('Control+a');
}
test('granted clipboard permissions copy and paste through the system clipboard',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await open(page);
  await page.evaluate(()=>navigator.clipboard.writeText('System clipboard 日本語 ✓'));
  await page.keyboard.press('Control+v');
  await expect.poll(()=>editorText(page)).toBe('System clipboard 日本語 ✓');
  await page.keyboard.press('Control+a');await page.keyboard.press('Control+c');
  await page.evaluate(()=>navigator.clipboard.writeText('overwritten'));
  await page.keyboard.press('Control+a');await page.keyboard.press('Control+c');
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe('System clipboard 日本語 ✓');
  expect(await page.evaluate(()=>document.getElementById('clipboard-status')?.textContent||'')).toBe('');
});
test('a denied clipboard read reports the failure and keeps the editor text',async({page,context})=>{
  await context.grantPermissions(['clipboard-write']);
  await open(page);const before=await editorText(page);
  // Chrome denies reads without clipboard-read permission in automation.
  await page.keyboard.press('Control+v');
  await expect(page.locator('#clipboard-status')).toContainText('Unable to paste');
  expect(await editorText(page)).toBe(before);
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.evaluate(()=>navigator.clipboard.writeText('after grant'));
  await page.keyboard.press('Control+v');
  await expect.poll(()=>editorText(page)).toBe('after grant');
});
