import {test,expect} from './fixtures.js';
import {start,menuItems,savePatch,patchParameters,closeMenus,mainMenu} from './helpers/ui.js';
test('shared UI helpers drive menus and read saved patch state',async({page})=>{
  await start(page);
  const items=await menuItems(page,'Main Menu');
  expect(items).toEqual(expect.arrayContaining(['Zoom','Tuning']));
  await mainMenu(page,'Zoom');await closeMenus(page);
  const parameters=patchParameters(await savePatch(page,'Helper Check'));
  expect(parameters.a_osc1_type).toMatchObject({type:expect.any(String),value:expect.any(String)});
});
