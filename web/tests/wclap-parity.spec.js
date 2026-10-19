// SPDX-License-Identifier: GPL-3.0-or-later
// The WCLAP renders the native/Wasm parity fixtures like the native reference
// harness, two ways:
// - clap.params: the harness's FM2 state, then the fixture's effect type and
//   parameter edits as CLAP parameter changes (params.flush), in the harness's order;
// - clap.state: the harness's state after its edits, loaded through clap.state.
// The harness seeds the Airwindows random source with 0x5eed5eed; the WCLAP takes
// that source from the host's random_get, so the first path matches stochastic
// Airwindows effects exactly too. A state load creates effects in a different
// order, so for Airwindows the second path checks only that the effect renders.
// Build both first: build-reference and web/scripts/build-wclap.sh.
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parityModes, parityFixture, harnessArguments} from './helpers/parity-cases.js';
import {harness, modulePath, root, loadModule, createPlugin, renderFixture, compareToReference, juceHash} from './helpers/wclap.js';
import {EVENT} from '../wclap/host/clap-host.mjs';

const ready = fs.existsSync(harness) && fs.existsSync(modulePath);
const data = path.join(root, 'resources/data');
const configuration = fs.readFileSync(path.join(root, 'resources/surge-shared/configuration.xml'), 'utf8').match(/<fx>([\s\S]*?)<\/fx>/)[1];
// The FX type parameter spans fx_type (SurgeStorage.h), up to n_fx_types - 1.
const fxTypes = fs.readFileSync(path.join(root, 'src/common/SurgeStorage.h'), 'utf8').match(/enum fx_type\s*\{([\s\S]*?)n_fx_types/)[1];
const lastFxType = fxTypes.split(',').filter(member => member.trim()).length - 1;
const airwindowsType = Number(configuration.match(/<type i="(\d+)" name="Airwindows"/)[1]);
// random_get for each new instance: 8 bytes of generator seed, then the
// Airwindows source the native harness uses (0x5eed5eed, little-endian).
const harnessEntropy = length => {
  const bytes = new Uint8Array(length);
  bytes.set([0xed, 0x5e, 0xed, 0x5e].slice(0, Math.max(0, length - 8)), 8);
  return bytes;
};

let module;
test.beforeAll(async () => { if (ready) module = await loadModule({random: harnessEntropy}); });

function capture(mode, rate, temporary, extra = []) {
  const output = path.join(temporary, `reference-${Math.random().toString(36).slice(2)}.f32`);
  execFileSync(harness, [...harnessArguments(mode, extra), data, parityFixture, String(rate), output], {timeout: 60000});
  return fs.readFileSync(output);
}

function expectParity(rendered, reference, mode) {
  const {signal, error, relative} = compareToReference(rendered, reference);
  if (mode.retiredSilence) {
    expect(signal, 'The retired Airwindows placeholder outputs silence').toBe(0);
    expect(error).toBe(0);
  } else {
    expect(signal).toBeGreaterThan(1);
    expect(relative).toBeLessThan(1e-5);
  }
}

for (const mode of parityModes) for (const rate of [44100, 48000]) {
  test(`WCLAP renders FM2 with ${mode.name} at ${rate} Hz through clap.state like the native harness`, async () => {
    test.skip(!ready, 'Build the native reference harness and the WCLAP module first.');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-wclap-parity-'));
    const plugin = createPlugin(module, rate);
    try {
      const state = path.join(temporary, 'state.bin');
      const reference = capture(mode, rate, temporary, ['--save-state', state]);
      expect(plugin.loadState(new Uint8Array(fs.readFileSync(state))), 'clap.state load').toBe(true);
      const rendered = renderFixture(plugin, {rate, audioInput: !!mode.audioInput});
      if (mode.type === airwindowsType && !mode.retiredSilence)
        expect(compareToReference(rendered, reference).signal).toBeGreaterThan(1);
      else
        expectParity(rendered, reference, mode);
    } finally {
      plugin.destroy();
      fs.rmSync(temporary, {recursive: true, force: true});
    }
  });

  if (mode.convolution) continue; // an impulse response is state, not a parameter
  test(`WCLAP renders FM2 with ${mode.name} at ${rate} Hz through clap.params like the native harness`, async () => {
    test.skip(!ready, 'Build the native reference harness and the WCLAP module first.');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-wclap-parity-'));
    const plugin = createPlugin(module, rate);
    try {
      const state = path.join(temporary, 'fm2.bin');
      execFileSync(harness, ['--save-state', state, data, parityFixture, String(rate), path.join(temporary, 'dry.f32')], {timeout: 60000});
      const reference = capture(mode, rate, temporary);
      expect(plugin.loadState(new Uint8Array(fs.readFileSync(state)))).toBe(true);
      const change = (id, value) => ({type: EVENT.PARAM_VALUE, time: 0, id, value});
      if (mode.type !== undefined) {
        const id = juceHash('fx1_type');
        plugin.flush([change(id, Math.fround(mode.type / lastFxType))]);
        expect(plugin.paramText(id, plugin.paramValue(id))).not.toBe('Off');
      }
      for (const edit of [...(mode.parameter ? [mode.parameter] : []), ...(mode.parameters || [])])
        plugin.flush([change(juceHash(`fx1_p${edit.index}`), Math.fround(edit.value))]);
      expectParity(renderFixture(plugin, {rate, audioInput: !!mode.audioInput}), reference, mode);
    } finally {
      plugin.destroy();
      fs.rmSync(temporary, {recursive: true, force: true});
    }
  });
}

test('WCLAP state bytes are the native engine state bytes', async () => {
  test.skip(!ready, 'Build the native reference harness and the WCLAP module first.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-wclap-state-'));
  try {
    const save = patch => {
      const state = path.join(temporary, path.basename(patch) + '.bin');
      execFileSync(harness, ['--save-state', state, data, patch, '48000', path.join(temporary, 'x.f32')], {timeout: 60000});
      return fs.readFileSync(state);
    };
    // A native state loaded through clap.state saves back byte for byte.
    const fm2 = save(parityFixture);
    const plugin = createPlugin(module, 48000);
    expect(plugin.loadState(new Uint8Array(fm2))).toBe(true);
    expect(Buffer.compare(Buffer.from(plugin.saveState()), fm2)).toBe(0);
    plugin.destroy();
    // A new instance holds the native default patch; only the path the patch was
    // loaded from (machine-specific) differs.
    const fresh = createPlugin(module, 48000);
    const strip = bytes => Buffer.from(bytes).toString('latin1').slice(8).replace(/<lastLoadedPath v="[^"]*" \/>/, '');
    const native = save(path.join(data, 'patches_factory/Templates/Init Saw.fxp'));
    expect(strip(fresh.saveState())).toBe(strip(native));
    fresh.destroy();
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
