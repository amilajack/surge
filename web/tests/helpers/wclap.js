// SPDX-License-Identifier: GPL-3.0-or-later
// Node-side helpers for the WCLAP tests: load the built module, render the native
// harness's fixture schedule and compare captures.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WclapModule, EVENT} from '../../wclap/host/clap-host.mjs';
import {nodeFiles} from '../../wclap/host/wasi.mjs';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const harness = path.join(root, 'build-reference/src/surge-web/surge-engine-reference');
// The bundle directory (preopened as "/"), or the build's module directory.
export const bundle = process.env.SURGE_WCLAP_BUNDLE || path.join(root, 'build-wclap/surge-xt.wclap');
export const modulePath = fs.existsSync(path.join(bundle, 'module.wasm'))
  ? path.join(bundle, 'module.wasm') : path.join(root, 'build-wclap/wclap/module.wasm');
export const PLUGIN_ID = 'org.surge-synth-team.surge-xt';

// juce::String::hashCode of a desktop parameter id: its CLAP id.
export function juceHash(identifier) {
  let result = 0;
  for (const c of identifier) result = (Math.imul(31, result) + c.codePointAt(0)) >>> 0;
  return result;
}

let compiled;
export async function loadModule({seed = 1, random, log} = {}) {
  compiled ??= await WebAssembly.compile(fs.readFileSync(modulePath));
  const files = await nodeFiles(fs.existsSync(bundle) ? bundle : path.dirname(modulePath));
  return WclapModule.load({module: compiled, files, seed, random, log});
}

// The native harness's schedule: C4 (MIDI velocity 100) before the first block,
// released at the 32-frame block holding the one-second mark; three seconds. Input
// is the harness's integer-period saws when audioInput is set.
export function renderFixture(plugin, {rate, audioInput = false, chunk = 512, seconds = 3}) {
  // Whole 32-frame blocks, like the harness, so input is never delayed.
  const total = Math.ceil(rate * seconds / 32) * 32, release = rate - rate % 32;
  const left = new Float32Array(total), right = new Float32Array(total);
  const inL = new Float32Array(chunk), inR = new Float32Array(chunk);
  for (let at = 0; at < total; at += chunk) {
    const frames = Math.min(chunk, total - at);
    const events = [];
    if (at === 0) events.push({type: EVENT.MIDI, time: 0, data: [0x90, 60, 100]});
    if (release >= at && release < at + frames) events.push({type: EVENT.MIDI, time: release - at, data: [0x80, 60, 0]});
    let input = null;
    if (audioInput) {
      for (let i = 0; i < frames; ++i) {
        inL[i] = ((at + i) % 257 - 128) / 256;
        inR[i] = ((at + i) % 193 - 96) / 256;
      }
      input = [inL, inR];
    }
    const result = plugin.process(frames, {events, input});
    left.set(result.left, at);
    right.set(result.right, at);
  }
  return {left, right};
}

// Relative RMS error of the WCLAP output against an interleaved native capture.
// The native harness adds 32 frames of latency; the WCLAP adds none.
export function compareToReference({left, right}, reference, latency = 32) {
  const frames = reference.length / 8;
  let signal = 0, error = 0, peak = 0;
  for (let i = 0; i + latency < frames; ++i) {
    for (const [channel, actual] of [[0, left], [1, right]]) {
      const expected = reference.readFloatLE(((i + latency) * 2 + channel) * 4);
      if (!Number.isFinite(actual[i])) throw Error(`Non-finite sample ${i}`);
      signal += expected * expected;
      const d = actual[i] - expected;
      error += d * d;
      peak = Math.max(peak, Math.abs(d));
    }
  }
  return {signal, error, relative: signal ? Math.sqrt(error / signal) : Math.sqrt(error), peak};
}

export function createPlugin(module, rate = 48000, maxFrames = 4096, callbacks = {}) {
  const plugin = module.createPlugin(PLUGIN_ID, callbacks);
  plugin.activate(rate, 1, maxFrames);
  return plugin;
}
