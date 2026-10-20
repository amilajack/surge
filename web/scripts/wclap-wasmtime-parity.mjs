#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The Surge XT WCLAP renders bit-identically in V8 and in wasmtime configured as
// the DAW's desktop host (SIMD, deterministic relaxed SIMD, standard exceptions;
// web/wasmtime-check). Each of the DAW's 23 Surge XT x100 patches renders in a
// fresh module with random_get seeded alike: a chord held for 1,500 blocks of 64
// frames at 48 kHz, then released for 1,500.
//
//   node web/scripts/wclap-wasmtime-parity.mjs [--bundle build-wclap/surge-xt.wclap]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {WclapModule, EVENT} from '../wclap/host/clap-host.mjs';
import {nodeFiles} from '../wclap/host/wasi.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {values} = parseArgs({options: {bundle: {type: 'string', default: path.join(root, 'build-wclap/surge-xt.wclap')}}});
const bundle = path.resolve(values.bundle);
const factory = path.join(root, 'resources/data/patches_factory');
const patches = ['Pads/Pad 1', 'Pads/MKS-70 Warm Pad', 'Pads/Bell Pad', 'Polysynths/Juno-60 Strings',
  'Polysynths/Jupiter-8', 'Polysynths/Fast Poly', 'Polysynths/Anthemish 1', 'Polysynths/Gentle',
  'Keys/EP 1', 'Keys/Organ 1', 'Keys/DX EP', 'Plucks/FM Pluck', 'Plucks/Bell 1', 'Plucks/Clean', 'Plucks/Diamonds',
  'Leads/Classic Lead 1', 'Leads/Crisp PWM', 'Leads/Fuji', 'Basses/Bass 1', 'Basses/FM Bass 1', 'Basses/Rubber Bass',
  'Basses/Deep End', 'Templates/Init Saw'];

const crate = path.join(root, 'web/wasmtime-check');
execFileSync('cargo', ['build', '--release', '--quiet', '--manifest-path', path.join(crate, 'Cargo.toml')], {stdio: 'inherit'});
const checker = path.join(process.env.CARGO_TARGET_DIR ?? path.join(crate, 'target'), 'release/surge-wclap-wasmtime-check');

const compiled = await WebAssembly.compile(fs.readFileSync(path.join(bundle, 'module.wasm')));
async function v8(patch, key) {
  const module = await WclapModule.load({module: compiled, files: await nodeFiles(bundle), seed: 1});
  const plugin = module.createPlugin('org.surge-synth-team.surge-xt');
  plugin.activate(48000, 64, 64);
  if (!plugin.loadState(new Uint8Array(fs.readFileSync(path.join(factory, patch + '.fxp')).subarray(60)))) throw Error(patch);
  const hash = crypto.createHash('sha256');
  const chord = status => [0, 4, 7].map(k => ({type: EVENT.MIDI, time: 0, data: [status, key + k, status === 0x90 ? 100 : 0]}));
  for (let block = 0; block < 3000; ++block) {
    const result = plugin.process(64, {events: block === 0 ? chord(0x90) : block === 1500 ? chord(0x80) : []});
    hash.update(Buffer.from(result.left.buffer, result.left.byteOffset, 256));
    hash.update(Buffer.from(result.right.buffer, result.right.byteOffset, 256));
  }
  plugin.destroy();
  return hash.digest('hex').slice(0, 16);
}

let same = 0;
for (const [i, patch] of patches.entries()) {
  const key = 48 + i % 12, user = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-wclap-user-'));
  const browser = await v8(patch, key);
  const desktop = execFileSync(checker, [bundle, user, path.join(factory, patch + '.fxp'), String(key), '1'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  fs.rmSync(user, {recursive: true, force: true});
  same += browser === desktop;
  console.log(`${patch.padEnd(28)} V8 ${browser}  wasmtime ${desktop}  ${browser === desktop ? 'same' : 'DIFFERENT'}`);
}
console.log(`${same} of ${patches.length} patches render bit-identically in V8 (Node ${process.version}) and wasmtime`);
process.exit(same === patches.length ? 0 : 1);
