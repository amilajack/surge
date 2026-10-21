// SPDX-License-Identifier: GPL-3.0-or-later
// CLAP preset discovery and preset-load of the Surge XT WCLAP (src/surge-wclap/Presets.cpp):
// one provider, Surge XT patches as file locations, as the desktop CLAP indexes them.
// The factory patches are files in the packaged bundle (factory/patches_factory, the
// WASI root here); user patches live in the /user preopen. Package the bundle first
// (web/scripts/package-wclap.py).
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {bundle, loadModule, createPlugin, PLUGIN_ID} from './helpers/wclap.js';
import {EVENT} from '../wclap/host/clap-host.mjs';
import {memoryFiles} from '../wclap/host/wasi.mjs';

const factory = path.join(bundle, 'factory/patches_factory');
const ready = fs.existsSync(factory);
const FACTORY = 1, USER = 2;

// What a patch file says about itself, read here independently of the plug-in.
function meta(bytes) {
  const xmlSize = Buffer.from(bytes).readUInt32LE(64);
  const xml = Buffer.from(bytes).subarray(92, 92 + xmlSize).toString('utf8');
  const element = /<meta ([^>]*?)\/?>/.exec(xml)[1];
  const attr = name => {
    const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(element);
    return match ? match[1].replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(+dec)).replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '';
  };
  return {name: attr('name'), author: attr('author'), comment: attr('comment'), license: attr('license')};
}
const files = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
  entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith('.fxp') ? [path.join(dir, entry.name)] : []);
const location = file => '/factory/patches_factory/' + path.relative(factory, file).split(path.sep).join('/');

test.beforeEach(() => test.skip(!ready, 'Package the WCLAP bundle first (web/scripts/package-wclap.py).'));

test('the provider declares Surge XT patches in the bundle, and indexes every factory patch with its metadata', async () => {
  const module = await loadModule();
  const discovery = module.discoverPresets();
  try {
    expect(discovery.providers).toEqual([{id: 'org.surge-synth-team.surge-xt.preset-indexer', name: 'Surge XT Presets', vendor: 'Surge Synth Team'}]);
    expect(discovery.filetypes).toEqual([{name: 'Surge XT Patch', description: 'A Surge XT patch', extension: 'fxp'}]);
    // No user folder: only the factory location, inside the bundle path the host gave.
    expect(discovery.locations).toEqual([{flags: FACTORY, name: 'Surge XT Factory Presets', kind: 0, location: '/factory/patches_factory'}]);
    const all = files(factory);
    expect(all.length).toBe(641);
    for (const file of all) {
      const result = discovery.metadata(location(file));
      expect(result.ok, file).toBe(true);
      expect(result.presets.length).toBe(1);
      const preset = result.presets[0], expected = meta(fs.readFileSync(file));
      const category = path.relative(factory, path.dirname(file)).split(path.sep).join('/');
      expect(preset.name, file).toBe(expected.name);
      expect(preset.key).toBeNull();
      expect(preset.pluginIds).toEqual([{abi: 'clap', id: PLUGIN_ID}]);
      expect(preset.flags).toBe(FACTORY);
      expect(preset.creators).toEqual(expected.author ? [expected.author] : []);
      if (expected.comment) expect(preset.description).toBe(expected.comment);
      expect(preset.extra.category).toBe(category);
      for (const word of category.toLowerCase().split('/')) expect(preset.features).toContain(word);
      if (expected.license) expect(preset.extra.license).toBe(expected.license);
    }
    const missing = discovery.metadata('/factory/patches_factory/Nope.fxp');
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toMatch(/Nope\.fxp: unable to read the file/);
    expect(discovery.metadata('/factory/patches_factory', 1).ok, 'only file locations').toBe(false);
  } finally { discovery.destroy(); }
});

test('user patches in the /user folder are a user location, with their modification time', async () => {
  const fxp = fs.readFileSync(path.join(factory, 'Leads/Fuji.fxp'));
  const user = memoryFiles({'Patches/Mine/Fuji Copy.fxp': new Uint8Array(fxp)});
  const module = await loadModule({user});
  const discovery = module.discoverPresets();
  try {
    expect(discovery.locations).toEqual([
      {flags: FACTORY, name: 'Surge XT Factory Presets', kind: 0, location: '/factory/patches_factory'},
      {flags: USER, name: 'Surge XT User Presets', kind: 0, location: '/user/Patches'}]);
    const result = discovery.metadata('/user/Patches/Mine/Fuji Copy.fxp');
    expect(result.ok).toBe(true);
    const preset = result.presets[0];
    expect(preset).toMatchObject({name: meta(fxp).name, flags: USER, extra: expect.objectContaining({category: 'Mine'})});
    const mtime = Math.floor(user.stat('/Patches/Mine/Fuji Copy.fxp').mtime / 1000);
    expect(preset.timestamps).toEqual([0, mtime]);
  } finally { discovery.destroy(); }
});

test('preset-load loads a patch from a location and tells the host; failures are reported', async () => {
  const module = await loadModule();
  const loaded = [], errors = [], sent = [];
  const plugin = createPlugin(module, 48000, 4096, {
    presetLoaded: info => loaded.push(info), presetError: info => errors.push(info),
    webviewSend: buffer => { sent.push(new Uint8Array(buffer)); return true; },
  });
  try {
    expect(plugin.guiCreate()).toBe(true);
    const hello = new Uint8Array(8); hello[0] = 1; new DataView(hello.buffer).setUint32(4, 2, true);
    plugin.webviewReceive(hello);
    sent.length = 0;
    const where = '/factory/patches_factory/Basses/Bass 1.fxp';
    expect(plugin.loadPreset(where)).toBe(true);
    const state = new TextDecoder('latin1').decode(plugin.saveState());
    expect(/<meta name="([^"]*)"/.exec(state)[1]).toBe('Bass 1');
    expect(state, 'the editor\'s patch browser knows it by its path').toMatch(/<lastLoadedPath v="\/factory\/patches_factory\/Basses\/Bass 1\.fxp"/);
    expect(loaded).toEqual([{kind: 0, location: where, key: null}]);
    expect(sent.some(message => message[0] === 64), 'the open editor gets the new patch').toBe(true);
    // The engine holds the patch the file holds, loaded as the desktop plug-in loads
    // a patch file: named by the file and its folder ("Bass 1" in "Basses"), every
    // parameter the file stores, and the global volume and polyphony kept (Surge's
    // patch browser does not change them).
    const params = text => new Map([...(/<parameters>([^]*?)<\/parameters>/.exec(text)[1])
      .matchAll(/<(\w+) type="(\d)" value="([^"]*)"/g)].map(([, name, type, value]) => [name, {type, value}]));
    const file = params(fs.readFileSync(path.join(factory, 'Basses/Bass 1.fxp')).toString('latin1'));
    const engine = params(state);
    expect(state).toMatch(/<meta name="Bass 1" category="Basses"/);
    let compared = 0;
    for (const [name, {type, value}] of file) {
      // Version 1 patches store some floats as their bits, and oscillator settings
      // the loader converts for the oscillator type: compare what is stored as is.
      if (['volume', 'polylimit'].includes(name) || (type === '2' && !value.includes('.')) ||
          /_osc\d_(param\d|retrigger)$/.test(name)) continue;
      expect(Number(engine.get(name)?.value), name).toBeCloseTo(Number(value), 5);
      ++compared;
    }
    expect(compared).toBeGreaterThan(300);
    let loudest = 0;
    for (let block = 0; block < 40; ++block)
      for (const x of plugin.process(256, {events: block ? [] : [{type: EVENT.NOTE_ON, time: 0, key: 48, velocity: 0.8}]}).left)
        loudest = Math.max(loudest, Math.abs(x));
    expect(loudest).toBeGreaterThan(0.01);
    expect(plugin.loadPreset('/factory/patches_factory/Nope.fxp')).toBe(false);
    expect(plugin.loadPreset(where, {kind: 1})).toBe(false);
    expect(errors.map(e => e.location)).toEqual(['/factory/patches_factory/Nope.fxp', where]);
    expect(errors[0].message).toMatch(/unable to read the file/);
  } finally { plugin.destroy(); }
});

test('a patch the editor loads from the factory library is reported to the host as that preset', async () => {
  const module = await loadModule();
  const source = createPlugin(module);
  const loaded = [];
  const plugin = createPlugin(module, 48000, 4096, {presetLoaded: info => loaded.push(info), webviewSend: () => true});
  try {
    // The editor's state after loading a factory patch carries the path it came from.
    expect(source.loadPreset('/factory/patches_factory/Pads/Pad 1.fxp')).toBe(true);
    const state = source.saveState();
    expect(plugin.guiCreate()).toBe(true);
    const message = new Uint8Array(4 + state.length); message[0] = 4; message.set(state, 4);
    expect(plugin.webviewReceive(message)).toBe(true);
    expect(loaded).toEqual([{kind: 0, location: '/factory/patches_factory/Pads/Pad 1.fxp', key: null}]);
  } finally { source.destroy(); plugin.destroy(); }
});
