#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Per-instance cost of the Surge XT WCLAP against native Surge.
//
//   node web/scripts/wclap-bench.mjs [--instances 1,2,16,100] [--blocks 750] [--frames 64] [--out report.json]
//
// For each count, one module instance hosts that many plug-in instances (as a DAW
// DSP thread does). Instance i loads patch i of a fixed factory list through
// clap.state and holds a three-note chord; each 64-frame block processes every
// instance once and times each process() call. Memory is the growth of the
// module's linear memory per instance (its high-water mark; voices are allocated
// as they are first played). The native numbers come from the reference harness
// (surge-engine-reference --bench) running the same engine, patches and chords.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {WclapModule, EVENT} from '../wclap/host/clap-host.mjs';
import {nodeFiles} from '../wclap/host/wasi.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {values} = parseArgs({allowNegative: true, options: {
  instances: {type: 'string', default: '1,2,16,100'}, blocks: {type: 'string', default: '750'},
  frames: {type: 'string', default: '64'}, out: {type: 'string'}, module: {type: 'string'},
  harness: {type: 'string'}, native: {type: 'boolean', default: true},
}});
const counts = values.instances.split(',').map(Number);
const blocks = Number(values.blocks), frames = Number(values.frames), rate = 48000;
const modulePath = values.module ?? [path.join(root, 'build-wclap/surge-xt.wclap/module.wasm'), path.join(root, 'build-wclap/wclap/module.wasm')].find(fs.existsSync);
const harness = values.harness ?? path.join(root, 'build-reference/src/surge-web/surge-engine-reference');
const factory = path.join(root, 'resources/data/patches_factory');
// The first patch of eight categories: light and heavy, wavetable, FM, effects.
const patches = ['Templates/Init Saw.fxp', ...['Basses', 'Brass', 'Keys', 'Leads', 'Pads', 'Plucks', 'Polysynths'].map(category =>
  category + '/' + fs.readdirSync(path.join(factory, category)).filter(name => name.endsWith('.fxp')).sort()[0])];

const percentiles = samples => {
  samples.sort((a, b) => a - b);
  const at = q => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {mean: +mean.toFixed(3), p50: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), p99: +at(0.99).toFixed(3), max: +samples.at(-1).toFixed(3)};
};

async function wclap(count) {
  const compiled = await WebAssembly.compile(fs.readFileSync(modulePath));
  const module = await WclapModule.load({module: compiled, files: await nodeFiles(path.dirname(modulePath)), seed: 1});
  const base = module.memoryBytes();
  const plugins = [];
  const start = performance.now();
  for (let i = 0; i < count; ++i) {
    const plugin = module.createPlugin('org.surge-synth-team.surge-xt');
    plugin.activate(rate, frames, frames);
    const fxp = fs.readFileSync(path.join(factory, patches[i % patches.length]));
    if (!plugin.loadState(new Uint8Array(fxp.subarray(60)))) throw Error('state load failed: ' + patches[i % patches.length]);
    plugins.push(plugin);
  }
  const creation = (performance.now() - start) / count;
  const created = module.memoryBytes();
  const chord = i => [0, 4, 7].map(k => ({type: EVENT.MIDI, time: 0, data: [0x90, 48 + i % 12 + k, 100]}));
  plugins.forEach((plugin, i) => plugin.process(frames, {events: chord(i)}));
  for (let b = 0; b < 31; ++b) for (const plugin of plugins) plugin.process(frames);
  const playing = module.memoryBytes();
  const samples = new Float64Array(blocks * count);
  let n = 0, total = 0;
  for (let b = 0; b < blocks; ++b)
    for (const plugin of plugins) {
      const t = performance.now();
      plugin.process(frames);
      const micros = (performance.now() - t) * 1000;
      samples[n++] = micros;
      total += micros;
    }
  for (const plugin of plugins) plugin.destroy();
  return {instances: count, blocks, frames, creationMillisPerInstance: +creation.toFixed(2),
    moduleMemoryBase: base, memoryPerInstanceCreated: Math.round((created - base) / count),
    memoryPerInstancePlaying: Math.round((playing - base) / count), moduleMemoryPlaying: playing,
    microsPerInstanceBlock: percentiles(Array.from(samples)),
    realtimeFraction: +(total / blocks / (frames * 1e6 / rate)).toFixed(5)};
}

function native(count) {
  const output = execFileSync(harness, ['--bench', String(count), String(blocks), String(frames),
    path.join(root, 'resources/data'), ...patches.map(p => path.join(factory, p))], {encoding: 'utf8', maxBuffer: 1 << 24});
  return JSON.parse(output);
}

const report = {date: new Date().toISOString(), module: path.relative(root, modulePath), patches, rate, results: []};
for (const count of counts) {
  const w = await wclap(count);
  const n = values.native && fs.existsSync(harness) ? native(count) : null;
  const ratio = n ? {
    cpuMean: +(w.microsPerInstanceBlock.mean / n.microsPerInstanceBlock.mean).toFixed(2),
    cpuP99: +(w.microsPerInstanceBlock.p99 / n.microsPerInstanceBlock.p99).toFixed(2),
    memoryPlaying: +(w.memoryPerInstancePlaying / n.heapPerInstancePlaying).toFixed(2)} : null;
  report.results.push({instances: count, wclap: w, native: n, ratio});
  console.error(`${count} instances: WCLAP ${w.microsPerInstanceBlock.mean} µs/instance/block (p99 ${w.microsPerInstanceBlock.p99}), ` +
    `${(w.memoryPerInstancePlaying / 1048576).toFixed(2)} MiB/instance` + (n ? `; native ${n.microsPerInstanceBlock.mean} µs (p99 ${n.microsPerInstanceBlock.p99}), ` +
    `${(n.heapPerInstancePlaying / 1048576).toFixed(2)} MiB/instance` : ''));
}
const json = JSON.stringify(report, null, 2);
if (values.out) fs.writeFileSync(values.out, json + '\n'); else console.log(json);
