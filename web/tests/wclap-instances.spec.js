// SPDX-License-Identifier: GPL-3.0-or-later
// Determinism and many instances of the Surge XT WCLAP in one module instance, as a
// DAW hosts them on one DSP thread. Each instance's random streams come from the
// host's random_get when it is created, so a test host decides every seed.
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {modulePath, root, loadModule, PLUGIN_ID} from './helpers/wclap.js';
import {EVENT} from '../wclap/host/clap-host.mjs';

const ready = fs.existsSync(modulePath);
const factory = path.join(root, 'resources/data/patches_factory');
const patches = ['Templates/Init Saw.fxp', ...['Basses', 'Brass', 'Keys', 'Leads', 'Pads', 'Plucks', 'Polysynths'].map(category =>
  category + '/' + fs.readdirSync(path.join(factory, category)).filter(name => name.endsWith('.fxp')).sort()[0])];
const chunk = name => new Uint8Array(fs.readFileSync(path.join(factory, name)).subarray(60));

// random_get for the n-th instance a module creates: its seed is (base + n).
function entropy(base) {
  let call = 0;
  return length => {
    const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
    const value = BigInt(base + call++);
    for (let i = 0; i + 8 <= length; i += 8) view.setBigUint64(i, value * 0x9e3779b97f4a7c15n + BigInt(i), true);
    if (length % 8) for (let i = length - length % 8; i < length; ++i) bytes[i] = Number(value & 255n) ^ i;
    return bytes;
  };
}

async function instances(count, {base = 1, patchOf = i => patches[i % patches.length]} = {}) {
  const module = await loadModule({random: entropy(base)});
  const plugins = [];
  for (let i = 0; i < count; ++i) {
    const plugin = module.createPlugin(PLUGIN_ID);
    plugin.activate(48000, 64, 64);
    expect(plugin.loadState(chunk(patchOf(i)))).toBe(true);
    plugins.push(plugin);
  }
  return {module, plugins};
}

// Each instance holds a chord from the first block; returns every instance's output.
function play(plugins, blocks, chordOf = i => [48 + i % 12, 52 + i % 12, 55 + i % 12]) {
  const outputs = plugins.map(() => new Float32Array(blocks * 128));
  for (let b = 0; b < blocks; ++b)
    plugins.forEach((plugin, i) => {
      const events = b === 0 ? chordOf(i).map(key => ({type: EVENT.MIDI, time: 0, data: [0x90, key, 100]})) : [];
      const {left, right} = plugin.process(64, {events});
      for (let k = 0; k < 64; ++k) { outputs[i][b * 128 + k * 2] = left[k]; outputs[i][b * 128 + k * 2 + 1] = right[k]; }
    });
  return outputs;
}
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer)) === 0;
const energy = a => a.reduce((sum, x) => sum + x * x, 0);

test.beforeEach(() => test.skip(!ready, 'Build the WCLAP module first (web/scripts/build-wclap.sh).'));

test('the same host seed renders bit-identical output; another seed changes stochastic patches', async () => {
  const blocks = 750; // one second
  const first = play((await instances(patches.length, {base: 11})).plugins, blocks);
  const again = play((await instances(patches.length, {base: 11})).plugins, blocks);
  const other = play((await instances(patches.length, {base: 9000})).plugins, blocks);
  first.forEach((output, i) => {
    expect(energy(output), patches[i]).toBeGreaterThan(0.1);
    expect(same(output, again[i]), patches[i]).toBe(true);
  });
  // Oscillator drift, noise and random modulation draw from the seeded streams.
  expect(first.filter((output, i) => !same(output, other[i])).length).toBeGreaterThan(0);
});

test('offline rendering (clap.render) renders like real time', async () => {
  const realtime = play((await instances(4, {base: 5})).plugins, 400);
  const {plugins} = await instances(4, {base: 5});
  for (const plugin of plugins) expect(plugin.setRenderMode(true)).toBe(true);
  play(plugins, 400).forEach((output, i) => expect(same(output, realtime[i]), patches[i]).toBe(true));
});

for (const count of [2, 16, 100]) {
  test(`${count} instances in one module play independent patches like solo instances`, async () => {
    test.setTimeout(240000);
    const blocks = 200;
    const {module, plugins} = await instances(count, {base: 100});
    const base = module.memoryBytes();
    const outputs = play(plugins, blocks);
    const perInstance = module.memoryBytes() / count;
    // Each instance owns its engine and random streams: rendered alone, with the
    // seed it had in the shared module, it produces the same samples.
    const checked = count <= 16 ? [...Array(count).keys()] : [0, 1, 7, 8, 15, 31, 50, 63, 98, 99];
    for (const i of checked) {
      const solo = await instances(1, {base: 100 + i, patchOf: () => patches[i % patches.length]});
      const [output] = play(solo.plugins, blocks, () => [48 + i % 12, 52 + i % 12, 55 + i % 12]);
      expect(same(output, outputs[i]), `instance ${i} (${patches[i % patches.length]})`).toBe(true);
    }
    // Instances with the same patch and chord but other seeds still produce sound.
    outputs.forEach((output, i) => expect(energy(output), `instance ${i}`).toBeGreaterThan(0.01));
    test.info().annotations.push({type: 'memory', description: `${count} instances: module ${(base / 1048576).toFixed(1)} MiB, ` +
      `${(perInstance / 1048576).toFixed(2)} MiB per instance while playing`});
    // About 8 MiB per playing instance (voices are allocated as they are played);
    // 100 instances fit easily in the module's 4 GiB address space.
    if (count >= 16) expect(perInstance).toBeLessThan(12 * 1048576);
    for (const plugin of plugins) plugin.destroy();
  });
}
