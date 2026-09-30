import {test,expect} from './fixtures.js';
import {readFileSync} from 'node:fs';
const patch=[...readFileSync(new URL('../../resources/data/patches_factory/Templates/Init Saw.fxp',import.meta.url))];
test('development engine rejects control access while audio owns it and returns ownership on stop',async({page})=>{
  await page.goto('/surge-xt-browser.html');await page.mouse.click(5,5);
  const result=await page.evaluate(async bytes=>{
    const {default:create}=await import('/surge-web.js');const m=await create();
    m.FS.mkdirTree('/factory');m.FS.writeFile('/patch.fxp',new Uint8Array(bytes));
    const engine=m.ccall('surge_create','number',['number','string'],[48000,'/factory']);
    const load=()=>m.ccall('surge_load_patch','number',['number','string'],[engine,'/patch.fxp']);
    const r={loaded:load(),count:m._surge_parameter_count(engine)};
    const context=m._surge_create_audio_context(48000);await m.emscriptenGetAudioObject(context).resume();
    r.started=m._surge_start_audio(context,engine);r.startedTwice=m._surge_start_audio(context,engine);
    const wait=async value=>{for(let i=0;i<400&&m._surge_audio_state()!==value;++i)await new Promise(f=>setTimeout(f,10));return m._surge_audio_state();};
    r.ready=await wait(2);r.attached=m._surge_audio_attached(engine);
    r.rejected={load:load(),parameter:m._surge_set_parameter(engine,0,.5),count:m._surge_parameter_count(engine),
      effect:m._surge_set_effect_type(engine,0,1),destroy:m._surge_destroy(engine),error:m.ccall('surge_error','string',[],[])};
    r.queued={note:m._surge_midi(engine,0x90,60,100),transport:m._surge_set_transport(engine,90,0)};
    await new Promise(f=>setTimeout(f,200));
    r.stop=m._surge_stop_audio();r.stopped=await wait(4);r.detached=!m._surge_audio_attached(engine);
    r.after={parameter:m._surge_set_parameter(engine,0,.5),count:m._surge_parameter_count(engine),restart:m._surge_start_audio(context,engine),
      attachedAfterRestart:m._surge_audio_attached(engine),destroy:m._surge_destroy(engine)};
    return r;
  },patch);
  expect(result).toMatchObject({loaded:1,started:1,startedTwice:0,ready:2,attached:1,
    rejected:{load:0,parameter:0,count:0,effect:0,destroy:0,error:'Engine is owned by audio'},
    queued:{note:1,transport:1},stop:1,stopped:4,detached:true,
    after:{parameter:1,restart:0,attachedAfterRestart:0,destroy:1}});
  expect(result.after.count).toBe(result.count);
});
