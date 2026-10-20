// SPDX-License-Identifier: GPL-3.0-or-later
// The Surge XT WCLAP's audio buses, as the desktop plug-in's: the Scene A and Scene B
// outputs beside the main output, and the stereo sidechain input that the vocoder and
// the audio input oscillator read. No browser: the host is web/wclap/host.
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import {modulePath, loadModule, createPlugin, juceHash} from './helpers/wclap.js';
import {EVENT} from '../wclap/host/clap-host.mjs';

const ready = fs.existsSync(modulePath);
test.beforeEach(() => test.skip(!ready, 'Build the WCLAP module first (web/scripts/build-wclap.sh).'));

const rms = samples => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
// The first instance of a module with a given seed: engines that render alike.
const engine = async (seed = 21) => createPlugin(await loadModule({seed}), 48000, 4096);
const set = (plugin, name, text) => {
  const id = juceHash(name), value = plugin.paramFromText(id, text);
  expect(value, `${name} = ${text}`).not.toBeNull();
  return {type: EVENT.PARAM_VALUE, time: 0, id, value};
};
// Renders blocks of 256 frames; returns every connected bus's channels.
function render(plugin, {blocks = 60, outputs = 3, events = [], input = null} = {}) {
  const buses = Array.from({length: outputs}, () => ({left: [], right: [], masks: []}));
  for (let block = 0; block < blocks; ++block) {
    const result = plugin.process(256, {outputs, events: block ? [] : events, input: input?.(block * 256, 256) ?? null});
    result.buses.forEach((bus, i) => {
      buses[i].left.push(...bus.left);
      buses[i].right.push(...bus.right);
      buses[i].masks.push(bus.constantMask);
    });
  }
  return buses.map(bus => ({left: Float32Array.from(bus.left), right: Float32Array.from(bus.right), masks: bus.masks}));
}
const note = (key = 60) => ({type: EVENT.NOTE_ON, time: 0, key, velocity: 0.8});

test('connecting the scene outputs does not change the main output', async () => {
  const [main, all] = [render(await engine(), {outputs: 1, events: [note()]}), render(await engine(), {outputs: 3, events: [note()]})];
  expect(all[0].left).toEqual(main[0].left);
  expect(all[0].right).toEqual(main[0].right);
  expect(rms(main[0].left)).toBeGreaterThan(0.01);
});

test('each scene output carries its scene, and only its scene', async () => {
  // Init Saw plays scene A only: Scene B is silent and reports a constant output.
  const single = render(await engine(), {events: [note()]});
  expect(rms(single[1].left)).toBeGreaterThan(0.01);
  expect(rms(single[2].left) + rms(single[2].right)).toBe(0);
  expect(single[2].masks.every(mask => mask === 3n)).toBe(true);
  // Both scenes playing (dual mode), scene B an octave up: both outputs sound.
  const plugin = await engine();
  const both = render(plugin, {events: [set(plugin, 'scenemode', 'Dual'), set(plugin, 'b_octave', '1'), note()]});
  expect(rms(both[1].left)).toBeGreaterThan(0.01);
  expect(rms(both[2].left)).toBeGreaterThan(0.01);
  // Muting scene B's oscillator silences Scene B and leaves Scene A exactly as it was.
  const quiet = await engine();
  const mute = {type: EVENT.PARAM_VALUE, time: 0, id: juceHash('b_mute_o1'), value: 1};
  const muted = render(quiet, {events: [set(quiet, 'scenemode', 'Dual'), set(quiet, 'b_octave', '1'), mute, note()]});
  expect(rms(muted[2].left) + rms(muted[2].right)).toBe(0);
  expect(muted[1].left).toEqual(both[1].left);
});

// Goertzel: the power of one frequency in a signal.
function power(samples, frequency, rate = 48000) {
  const k = 2 * Math.cos(2 * Math.PI * frequency / rate);
  let s1 = 0, s2 = 0;
  for (const x of samples) { const s = x + k * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / samples.length;
}

test('the sidechain input feeds the audio input oscillator', async () => {
  const sine = (frequency, level) => (start, frames) => {
    const left = new Float32Array(frames), right = new Float32Array(frames);
    for (let i = 0; i < frames; ++i) left[i] = right[i] = level * Math.sin(2 * Math.PI * frequency * (start + i) / 48000);
    return [left, right];
  };
  const play = async input => {
    const plugin = await engine();
    return render(plugin, {outputs: 1, events: [set(plugin, 'a_osc1_type', 'Audio Input'), note(48)], input})[0].left.subarray(48000 / 4);
  };
  const withInput = await play(sine(1000, 0.5)), silent = await play(sine(1000, 0));
  // The output is the input, not the note: 1 kHz dominates the note's 130.8 Hz.
  expect(power(withInput, 1000)).toBeGreaterThan(100 * power(withInput, 130.81));
  expect(rms(withInput)).toBeGreaterThan(0.01);
  expect(rms(silent)).toBeLessThan(rms(withInput) / 100);
});

test('the sidechain input is the vocoder\'s modulator', async () => {
  const noise = level => {
    let state = 1;
    return (start, frames) => {
      const left = new Float32Array(frames), right = new Float32Array(frames);
      for (let i = 0; i < frames; ++i) {
        state = (state * 1664525 + 1013904223) >>> 0;
        left[i] = right[i] = level * (state / 2 ** 32 - 0.5);
      }
      return [left, right];
    };
  };
  const play = async input => {
    const plugin = await engine();
    return render(plugin, {outputs: 1, events: [set(plugin, 'fx1_type', 'Vocoder'), note(48)], input})[0].left.subarray(48000 / 4);
  };
  const modulated = await play(noise(0.8)), unmodulated = await play(noise(0));
  // Without a modulator the vocoder lets nothing of the carrier through.
  expect(rms(modulated)).toBeGreaterThan(0.005);
  expect(rms(unmodulated)).toBeLessThan(rms(modulated) / 30);
});
