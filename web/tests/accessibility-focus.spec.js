import {test,expect} from './fixtures.js';
const active=page=>page.evaluate(()=>{
  const id=document.querySelector('canvas').getAttribute('aria-activedescendant'),node=id&&document.getElementById(id);
  return node?{role:node.getAttribute('role'),name:node.getAttribute('aria-label')}:null;
});
async function start(page){
  await page.goto('/surge-xt-browser.html');
  await expect.poll(()=>page.evaluate(()=>globalThis.Module?._surge_browser_scene?.())).toBe(0);
  return page.locator('canvas').first();
}
test('control-group shortcuts move JUCE focus and the canvas points assistive technology at it',async({page})=>{
  const canvas=await start(page);const visited=[];
  for(let i=0;i<4;i++){
    await canvas.focus();await page.keyboard.press('Alt+.');
    await expect.poll(()=>active(page)).not.toEqual(visited.at(-1)??null);
    visited.push(await active(page));
  }
  expect(new Set(visited.map(v=>v.name)).size).toBe(4);
  await canvas.focus();await page.keyboard.press('Alt+,');
  await expect.poll(()=>active(page)).toEqual(visited[2]);
  // Keyboard input stays on the canvas; only the active descendant moves.
  await expect(canvas).toBeFocused();
});
test('JUCE tables expose their size and each row position to assistive technology',async({page})=>{
  const canvas=await start(page);
  await canvas.focus();await page.keyboard.press('Alt+t');
  const table=page.getByRole('table',{name:'Tuning Table',exact:true});
  await expect(table).toHaveAttribute('aria-rowcount','128');
  const rows=await page.locator('#juce-accessibility [role=row][aria-rowindex]').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('aria-label'),Number(n.getAttribute('aria-rowindex'))]));
  expect(rows.length).toBeGreaterThan(4);
  // JUCE numbers rows from one in their names, matching ARIA's one-based index.
  for(const [name,index] of rows)expect(name).toBe(`Row ${index}`);
});
