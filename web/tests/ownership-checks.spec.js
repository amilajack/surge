import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const path=relative=>fileURLToPath(new URL(relative,import.meta.url));
test('native control snapshots hand off coherent values without waiting',()=>{
  const output=execFileSync(path('../../build-reference/src/surge-web/surge-control-snapshot-check'),[],{encoding:'utf8',timeout:60000});
  expect(output).toMatch(/Coherent snapshot handoffs: \d+; final generation 1000000/);
});
test('native oscillator configuration publications stay coherent with nonblocking resets',()=>{
  const output=execFileSync(path('../../build-reference/src/surge-web/surge-oscillator-extra-configuration-check'),[],{encoding:'utf8',timeout:60000});
  expect(output).toMatch(/Coherent UI publications and nonblocking type resets: \d+/);
});
test('Wasm wavetable snapshots preserve pending, superseded and adopted export data',()=>{
  const output=execFileSync('node',['surge-wavetable-snapshot-check.cjs'],{cwd:path('../../build-web/checks'),encoding:'utf8',timeout:120000});
  expect(output).toContain('Pending, superseded, worker and adopted wavetable snapshots preserve export data');
});
