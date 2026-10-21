import {test,expect} from './fixtures.js';
import {renderEngineFixture} from './helpers/engine-fixture.js';
import {parityModes,parityFixture} from './helpers/parity-cases.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));
const harness=path.join(root,'build-reference/src/surge-web/surge-engine-reference');
const fixture=parityFixture;
for(const mode of parityModes)for(const rate of [44100,48000]) {
  const convolution=!!mode.convolution;
  const parameterArguments=[...(mode.parameter?[mode.parameter]:[]),...(mode.parameters||[])].flatMap(edit=>['--effect-parameter',String(edit.index),String(edit.value)]);
  test(`native/Wasm FM2 with ${mode.name} rendering at ${rate} Hz with variable buffer sizes`,async({page})=>{
    test.skip(!fs.existsSync(harness),'Build the native reference harness before running parity tests.');
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'surge-parity-'));
    try {
      const capture=path.join(temporary,'reference.f32');
      execFileSync(harness,[...(mode.audioInput?['--audio-input']:[]),...(convolution?['--convolution']:mode.type!==undefined?['--effect-type',String(mode.type)]:[]),...parameterArguments,path.join(root,'resources/data'),fixture,String(rate),capture]);
      const reference=fs.readFileSync(capture);
      if(mode.audioInput){
        const silentInputCapture=path.join(temporary,'no-input.f32');
        execFileSync(harness,['--effect-type',String(mode.type),...parameterArguments,path.join(root,'resources/data'),fixture,String(rate),silentInputCapture]);
        const baseline=fs.readFileSync(silentInputCapture);
        let delta=0,energy=0;
        for(let i=0;i<reference.length;i+=4){
          const x=reference.readFloatLE(i),y=baseline.readFloatLE(i);
          delta+=(x-y)**2;energy+=x*x;
        }
        expect(Math.sqrt(delta/energy),'External input must contribute to the rendered output').toBeGreaterThan(1e-3);
      }
      if(mode.type!==undefined){
        const dryCapture=path.join(temporary,'dry.f32');
        execFileSync(harness,[path.join(root,'resources/data'),fixture,String(rate),dryCapture]);
        const dry=fs.readFileSync(dryCapture);
        let delta=0,energy=0;
        for(let i=0;i<reference.length;i+=4){
          const x=reference.readFloatLE(i),y=dry.readFloatLE(i);
          delta+=(x-y)**2;energy+=y*y;
        }
        expect(Math.sqrt(delta/energy),'Effect fixture must change the dry signal').toBeGreaterThan(1e-3);
      }
      if(mode.parameter && !mode.parameter.isDefault){
        const defaultCapture=path.join(temporary,'default-effect.f32');
        execFileSync(harness,[...(mode.audioInput?['--audio-input']:[]),'--effect-type',String(mode.type),path.join(root,'resources/data'),fixture,String(rate),defaultCapture]);
        const baseline=fs.readFileSync(defaultCapture);
        let delta=0,energy=0;
        for(let i=0;i<reference.length;i+=4){
          const x=reference.readFloatLE(i),y=baseline.readFloatLE(i);
          delta+=(x-y)**2;energy+=y*y;
        }
        expect(Math.sqrt(delta/energy),'Selected mode must change the default effect output').toBeGreaterThan(1e-3);
      }
      if(mode.parameters?.length){
        const selectedDefault=path.join(temporary,'selected-default.f32');
        execFileSync(harness,['--effect-type',String(mode.type),'--effect-parameter',String(mode.parameter.index),String(mode.parameter.value),path.join(root,'resources/data'),fixture,String(rate),selectedDefault],{timeout:20000});
        const baseline=fs.readFileSync(selectedDefault);
        let delta=0,energy=0;
        for(let i=0;i<reference.length;i+=4){
          const x=reference.readFloatLE(i),y=baseline.readFloatLE(i);
          delta+=(x-y)**2;energy+=y*y;
        }
        expect(Math.sqrt(delta/energy),'Edited sub-effect parameters must change its selected defaults').toBeGreaterThan(1e-3);
      }
      const bytes=[...fs.readFileSync(fixture)];
      await page.goto('/');
      const actual=await page.evaluate(renderEngineFixture,{rate,bytes,convolution,effectType:mode.type,effectParameter:mode.parameter,effectParameters:mode.parameters,audioInput:mode.audioInput});
      expect(actual.length).toBe(reference.length/4);
      let signal=0,error=0;
      for(let i=0;i<actual.length;++i){
        const expected=reference.readFloatLE(i*4);
        if(!Number.isFinite(actual[i]))throw Error(`Non-finite sample ${i}`);
        signal+=expected*expected;error+=(actual[i]-expected)**2;
      }
      if(mode.retiredSilence){
        expect(signal,'The original retired Airwindows placeholder outputs silence').toBe(0);
        expect(error).toBe(0);
      }else{
        expect(signal).toBeGreaterThan(1);
        expect(Math.sqrt(error/signal)).toBeLessThan(1e-5);
      }
    } finally {fs.rmSync(temporary,{recursive:true,force:true});}
  });
}
test('engine parameter metadata and FXP serialization preserve an edit',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {default:create}=await import('/surge-web.js');
    const m=await create();m.FS.mkdirTree('/factory');m.FS.mkdirTree('/user');
    const e=m.ccall('surge_create','number',['number','string'],[48000,'/factory']);
    if(!e)throw Error(m.ccall('surge_error','string',[],[]));
    try {
      const count=m._surge_parameter_count(e);
      const parameters=Array.from({length:count},(_,id)=>JSON.parse(m.ccall('surge_parameter_info','string',['number','number'],[e,id])));
      const volume=parameters.find(p=>p.name==='Global Volume');
      if(!volume)throw Error('Missing native parameter metadata');
      if(!m._surge_set_parameter(e,volume.id,0.5))throw Error('Edit failed');
      if(!m.ccall('surge_save_patch','number',['number','string'],[e,'/roundtrip.fxp']))throw Error(m.ccall('surge_error','string',[],[]));
      m._surge_set_parameter(e,volume.id,0.2);
      if(!m.ccall('surge_load_patch','number',['number','string'],[e,'/roundtrip.fxp']))throw Error(m.ccall('surge_error','string',[],[]));
      return {count,value:JSON.parse(m.ccall('surge_parameter_info','string',['number','number'],[e,volume.id])).value,size:m.FS.stat('/roundtrip.fxp').size};
    } finally {m._surge_destroy(e);}
  });
  expect(result.count).toBeGreaterThan(100);
  expect(result.size).toBeGreaterThan(100);
  expect(result.value).toBeCloseTo(0.5,5);
});
