import {test,expect} from './fixtures.js';
import {start,menuItems,closeMenus} from './helpers/ui.js';
test('desktop-only OSC, folder and shell actions are absent from browser menus',async({page})=>{
  await start(page);
  const main=await menuItems(page,'Main Menu');
  expect(main).not.toContain('OSC Settings');expect(main).not.toContain('Open Sound Control');
  const data=await menuItems(page,'Main Menu','Data Folders');
  expect(data).toEqual(expect.arrayContaining(['Set Custom User Data Folder...','Rescan All Data Folders']));
  expect(data.filter(item=>/^Open .*Folder/.test(item))).toEqual([]);
  const skins=await menuItems(page,'Main Menu','Skins');
  expect(skins).toContain('Install a New Skin...');expect(skins).not.toContain('Open Current Skin Folder...');
});
test('the developer menu keeps the portable skin installer instead of revealing folders',async({page})=>{
  await start(page);
  // A right click on the main menu button opens it with the developer submenu.
  const box=await page.getByRole('button',{name:'Main Menu',exact:true}).boundingBox();
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2,{button:'right'});
  await expect(page.getByRole('menuitem',{name:'Developer Options',exact:true})).toBeAttached();
  await closeMenus(page);
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2,{button:'right'});
  await page.getByRole('menuitem',{name:'Skins',exact:true}).dispatchEvent('click');
  const names=await page.getByRole('menu').last().locator('[role^="menuitem"]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')));
  expect(names).toContain('Install a New Skin...');expect(names).not.toContain('Open Current Skin Folder...');
  await closeMenus(page);
});
