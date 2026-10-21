// SPDX-License-Identifier: GPL-3.0-or-later
// The native/Wasm parity fixtures (FM2 with every effect family, edited effect
// parameters, Ensemble stages, external input and Airwindows sub-effects), shared
// by the browser engine (parity.spec.js) and the WCLAP (wclap-parity.spec.js).
import {airwindowsInventory,airwindowsFixture,airwindowsActiveParameters,summarizeAirwindows} from '../../scripts/airwindows-inventory.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
export const parityFixture=path.join(root,'resources/data/patches_factory/Templates/Init FM2.fxp');
const configuration=fs.readFileSync(path.join(root,'resources/surge-shared/configuration.xml'),'utf8').match(/<fx>([\s\S]*?)<\/fx>/)[1];
const types=new Map([...configuration.matchAll(/<type i="(\d+)" name="([^"]+)"/g)].map(([,id,name])=>[name,Number(id)]));
const coverage=JSON.parse(fs.readFileSync(path.join(root,'web/parity/effects.json'),'utf8'));
if(JSON.stringify([...types.keys()].sort())!==JSON.stringify(Object.keys(coverage.effects).sort()))
  throw Error('Review the changed effect-family parity inventory');
for(const [name,entry] of Object.entries(coverage.effects)){
  if(types.get(name)!==entry.type)throw Error('Effect type changed: '+name);
  if(!['default','convolution','parameters','input','airwindows','pending'].includes(entry.fixture) || (entry.fixture==='pending' && !entry.reason) ||
    (entry.fixture==='parameters' && !entry.parameterFixtures?.length))
    throw Error('Missing effect fixture or pending reason: '+name);
}
const effects=Object.entries(coverage.effects).filter(([,entry])=>entry.fixture==='default').map(([name,entry])=>{
  return {name,type:entry.type};
});
const inputModes=Object.entries(coverage.effects).filter(([,entry])=>entry.fixture==='input').map(([name,entry])=>({name:`${name} stereo input`,type:entry.type,audioInput:true}));
const airwindowsCoverage=JSON.parse(fs.readFileSync(path.join(root,'web/parity/airwindows.json'),'utf8'));
const airwindowsRegistry=airwindowsInventory();
if(airwindowsCoverage.effectOnly || !airwindowsCoverage.complete || !airwindowsCoverage.fullInventory ||
  airwindowsCoverage.cases.length!==airwindowsRegistry.length*2 ||
  JSON.stringify(airwindowsRegistry)!==JSON.stringify(airwindowsCoverage.inventory) ||
  JSON.stringify(summarizeAirwindows(airwindowsCoverage))!==JSON.stringify(airwindowsCoverage.coverage))
  throw Error('Review the changed Airwindows sub-effect inventory');
const airwindowsModes=airwindowsRegistry.flatMap(entry=>{
  const cases=airwindowsCoverage.cases.filter(item=>item.streamingId===entry.id);
  if(cases.length!==2 || ![44100,48000].every(rate=>cases.some(item=>item.rate===rate)))
    throw Error('Missing Airwindows survey rate: '+entry.name);
  const parameters=airwindowsCoverage.activeParameters?airwindowsActiveParameters(entry):[];
  if(cases.some(item=>JSON.stringify(item.parameters||[])!==JSON.stringify(parameters) ||
    JSON.stringify(item.parameter)!==JSON.stringify(airwindowsFixture(entry,airwindowsRegistry))))
    throw Error('Review changed Airwindows parameter fixture: '+entry.name);
  if(![...airwindowsCoverage.coverage.activeFixtures,...airwindowsCoverage.coverage.retiredSilence].includes(entry.name))return [];
  return [{name:`Airwindows ${entry.name}`,type:types.get('Airwindows'),parameter:airwindowsFixture(entry,airwindowsRegistry),parameters,retiredSilence:entry.noOp}];
});
function enumMembersFromHeader(header,name){
  const declaration=header.match(new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\}`));
  if(!declaration)throw Error('Missing fixture parameter enum: '+name);
  const members=declaration[1].replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'').split(',').map(value=>value.trim()).filter(Boolean);
  // These parameter enums are sequential from zero. Fail if their layout changes.
  if(members.some((member,index)=>!/^\w+(?:\s*=\s*0)?$/.test(member) || (index>0 && member.includes('='))))
    throw Error('Review fixture parameter enum layout: '+name);
  return members.map(member=>member.split(/\s*=/)[0]);
}
const parameterModes=Object.entries(coverage.effects).flatMap(([name,entry])=>(entry.parameterFixtures || []).map(fixture=>{
  const header=fs.readFileSync(path.join(root,'src/common/dsp/effects',fixture.header),'utf8');
  const index=enumMembersFromHeader(header,fixture.enum).indexOf(fixture.member);
  let value=fixture.value;
  if(fixture.discreteEnum){
    const choices=enumMembersFromHeader(header,fixture.discreteEnum);
    const choice=choices.indexOf(fixture.discreteMember);
    if(choice<0 || choices.length<2)throw Error('Invalid discrete fixture: '+name);
    value=choice/(choices.length-1);
  }
  if(index<0 || !Number.isFinite(value) || value<0 || value>1)
    throw Error('Invalid parameter fixture: '+name);
  return {name:`${name} ${fixture.discreteMember || fixture.member}`,type:entry.type,audioInput:!!fixture.audioInput,parameter:{index,value}};
}));
const ensembleHeader=fs.readFileSync(path.join(root,'src/common/dsp/effects/BBDEnsembleEffect.h'),'utf8');
const enumMembers=name=>[...ensembleHeader.match(new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\}`))[1].matchAll(/^\s*(ens_\w+)/gm)].map(match=>match[1]);
const ensembleParameter=enumMembers('ens_params').indexOf('ens_delay_type');
const ensembleStages=enumMembers('EnsembleStages');
const ensembleDefaults=fs.readFileSync(path.join(root,'src/common/dsp/effects/BBDEnsembleEffect.cpp'),'utf8');
const ensembleDefaultStage=Number(ensembleDefaults.match(/ens_delay_type\]\.val\.i = (\d+);/)[1]);
if(ensembleParameter<0 || ensembleStages.length!==7)throw Error('Review Ensemble fixture metadata');
const ensembleModes=ensembleStages.map((name,index)=>({name:`Ensemble ${name}`,type:types.get('Ensemble'),
  parameter:{index:ensembleParameter,value:index/(ensembleStages.length-1),isDefault:index===ensembleDefaultStage}}));
export const parityModes=[{name:'dry'},{name:'stereo convolution',convolution:true},...effects,...ensembleModes,...parameterModes,...inputModes,...airwindowsModes];
// Native harness arguments for a mode, before DATA_DIR PATCH RATE OUTPUT.
export function harnessArguments(mode,extra=[]){
  const parameterArguments=[...(mode.parameter?[mode.parameter]:[]),...(mode.parameters||[])].flatMap(edit=>['--effect-parameter',String(edit.index),String(edit.value)]);
  return [...(mode.audioInput?['--audio-input']:[]),...(mode.convolution?['--convolution']:mode.type!==undefined?['--effect-type',String(mode.type)]:[]),...extra,...parameterArguments];
}
