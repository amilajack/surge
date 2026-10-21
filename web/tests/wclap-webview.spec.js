// SPDX-License-Identifier: GPL-3.0-or-later
// The WCLAP's CLAP surface and its side of the webview protocol, driven directly
// (src/surge-wclap/Protocol.h): no browser, the host is web/wclap/host.
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {modulePath, root, loadModule, createPlugin, juceHash, PLUGIN_ID} from './helpers/wclap.js';
import {EVENT, PROCESS} from '../wclap/host/clap-host.mjs';
import {memoryFiles} from '../wclap/host/wasi.mjs';

const ready = fs.existsSync(modulePath);
const T = {Hello: 1, Param: 2, Gesture: 3, State: 4, Modulation: 5, Note: 6, EditorState: 7, Resize: 8, Scope: 9,
  Delta: 10, UserFiles: 11, UserFileOps: 12, Snapshot: 64, Telemetry: 65, ScopeAudio: 66, OutputState: 67, Scale: 68,
  NeedState: 69, UserFileList: 70, UserFilesDone: 71};
const VERSION = 2;
const frame = (type, write = () => {}, extra = 0) => {
  const bytes = new Uint8Array(4 + extra);
  bytes[0] = type;
  write(new DataView(bytes.buffer));
  return bytes;
};
const hello = () => frame(T.Hello, v => v.setUint32(4, VERSION, true), 4);
const patchChunk = name => {
  const fxp = fs.readFileSync(path.join(root, 'resources/data/patches_factory/Templates', name + '.fxp'));
  return new Uint8Array(fxp.subarray(60));
};
const metaName = state => /<meta name="([^"]*)"/.exec(new TextDecoder('latin1').decode(state))?.[1];

let module;
test.beforeAll(async () => { if (ready) module = await loadModule({seed: 3}); });
test.beforeEach(() => test.skip(!ready, 'Build the WCLAP module first (web/scripts/build-wclap.sh).'));

function withPage(target = module) {
  const sent = [], host = {sent, mainThread: 0, flushes: 0, dirty: 0, rescans: [], resizes: [], processRequests: 0,
    hintChanges: 0, voiceChanges: 0, presets: [], presetErrors: []};
  const plugin = createPlugin(target, 48000, 4096, {
    requestProcess: () => host.processRequests++,
    resizeHintsChanged: () => host.hintChanges++,
    voiceInfoChanged: () => host.voiceChanges++,
    presetLoaded: info => host.presets.push(info),
    presetError: info => host.presetErrors.push(info),
    webviewSend: buffer => { sent.push(new Uint8Array(buffer)); return true; },
    requestCallback: () => host.mainThread++,
    requestFlush: () => host.flushes++,
    markDirty: () => host.dirty++,
    paramsRescan: flags => host.rescans.push(flags),
    requestResize: (width, height) => { host.resizes.push([width, height]); return true; },
  });
  expect(plugin.guiCreate()).toBe(true);
  return {plugin, host};
}
const take = (host, type) => {
  const index = host.sent.findIndex(message => message[0] === type);
  return index < 0 ? null : host.sent.splice(index, 1)[0];
};

test('the factory, descriptor and extensions match the desktop CLAP', () => {
  expect(module.descriptors()).toEqual([expect.objectContaining({id: PLUGIN_ID, name: 'Surge XT', vendor: 'Surge Synth Team',
    features: ['instrument', 'synthesizer', 'stereo', 'free and open source']})]);
  const plugin = createPlugin(module);
  try {
    expect(plugin.latency()).toBe(0);
    expect(plugin.tail()).toBe(96000);
    // The desktop plug-in's buses and port ids (clap-juce-extensions): the scene
    // outputs, and the sidechain input, which is not the main input.
    expect(plugin.audioPorts(false)).toEqual([{id: 1, name: 'Output', flags: 1, channels: 2, type: 'stereo'},
      {id: 2, name: 'Scene A', flags: 0, channels: 2, type: 'stereo'}, {id: 3, name: 'Scene B', flags: 0, channels: 2, type: 'stereo'}]);
    expect(plugin.audioPorts(true)).toEqual([{id: 32768, name: 'Sidechain', flags: 0, channels: 2, type: 'stereo'}]);
    expect(plugin.notePorts(true)).toEqual([{id: 0, dialects: 7, preferred: 1, name: 'Note Input'}]);
    expect(plugin.notePorts(false)).toEqual([]);
    expect(plugin.setRenderMode(true)).toBe(true);
    expect(plugin.webviewUri()).toBe('/ui/index.html');
    // Desktop ids: juce::String::hashCode of the storage name, macros first.
    const count = plugin.paramCount(), infos = Array.from({length: count}, (_, i) => plugin.paramInfo(i));
    expect(new Set(infos.map(info => info.id)).size).toBe(count);
    expect(infos.slice(0, 8).map(info => info.id)).toEqual(Array.from({length: 8}, (_, m) => juceHash('macro_' + m)));
    expect(infos.slice(0, 8).every(info => info.module === 'Macros')).toBe(true);
    const volume = infos.find(info => info.id === juceHash('volume'));
    expect(volume).toMatchObject({name: 'Global Volume', module: 'Global & FX', min: 0, max: 1});
    expect(volume.flags & 32, 'automatable').toBe(32);
    const cutoff = infos.find(info => info.id === juceHash('a_filter1_cutoff'));
    expect(cutoff.flags & 0x7c00, 'polyphonically modulatable').toBe(0x7c00);
    // value_to_text and text_to_value round trip through Surge's own display.
    expect(plugin.paramText(juceHash('volume'), plugin.paramFromText(juceHash('volume'), '-6 dB'))).toBe('-6.00 dB');
    expect(plugin.paramText(juceHash('macro_0'), 0.5)).toBe('50.00 %');
    expect(plugin.paramFromText(juceHash('macro_0'), '25 %')).toBeCloseTo(0.25, 6);
  } finally { plugin.destroy(); }
});

test('Hello is answered with a snapshot of the current patch', () => {
  const {plugin, host} = withPage();
  try {
    expect(plugin.webviewReceive(hello())).toBe(true);
    const snapshot = take(host, T.Snapshot);
    expect(snapshot).not.toBeNull();
    expect(new DataView(snapshot.buffer).getUint32(4, true)).toBe(VERSION);
    expect(metaName(snapshot.subarray(8))).toBe('Init Saw');
    expect(plugin.webviewReceive(frame(T.Hello, v => v.setUint32(4, 99, true), 4)), 'unknown protocol version').toBe(false);
  } finally { plugin.destroy(); }
});

test('page parameter edits reach the engine and the host, with gestures, without echo', () => {
  const {plugin, host} = withPage();
  try {
    plugin.webviewReceive(hello());
    const id = juceHash('volume');
    plugin.webviewReceive(frame(T.Gesture, v => { v.setUint32(4, id, true); v.setUint8(8, 1); }, 5));
    plugin.webviewReceive(frame(T.Param, v => { v.setUint32(4, id, true); v.setFloat64(8, 0.25, true); }, 12));
    plugin.webviewReceive(frame(T.Gesture, v => { v.setUint32(4, id, true); v.setUint8(8, 0); }, 5));
    expect(plugin.paramValue(id)).toBeCloseTo(0.25, 6);
    const out = plugin.process(256).events;
    expect(out.map(e => [e.type, e.id])).toEqual([[EVENT.PARAM_GESTURE_BEGIN, id], [EVENT.PARAM_VALUE, id], [EVENT.PARAM_GESTURE_END, id]]);
    expect(out[1].value).toBeCloseTo(0.25, 6);
    // Telemetry carries no echo of the page's own edit.
    host.sent.length = 0;
    plugin.process(2048);
    plugin.onMainThread();
    expect(host.sent.filter(m => m[0] === T.Param)).toEqual([]);
    expect(take(host, T.Telemetry)).not.toBeNull();
  } finally { plugin.destroy(); }
});

test('host automation and engine changes reach the page as parameter frames', () => {
  const {plugin, host} = withPage();
  try {
    plugin.webviewReceive(hello());
    host.sent.length = 0;
    const id = juceHash('a_filter1_cutoff');
    plugin.process(2048, {events: [{type: EVENT.PARAM_VALUE, time: 0, id, value: 0.3}]});
    expect(host.mainThread).toBeGreaterThan(0);
    plugin.onMainThread();
    const param = take(host, T.Param);
    const view = new DataView(param.buffer);
    expect([view.getUint32(4, true), view.getFloat64(8, true)]).toEqual([id, Math.fround(0.3)]);
  } finally { plugin.destroy(); }
});

test('page states, modulation, notes and editor state change the engine', () => {
  const {plugin, host} = withPage();
  try {
    plugin.webviewReceive(hello());
    const dirty = host.dirty;
    const state = patchChunk('Init FM2');
    expect(plugin.webviewReceive(frame(T.State, v => new Uint8Array(v.buffer).set(state, 4), state.length))).toBe(true);
    expect(metaName(plugin.saveState())).toBe('Init FM2');
    expect(host.dirty).toBeGreaterThan(dirty);
    expect(host.rescans.length).toBeGreaterThan(0);
    expect(plugin.webviewReceive(frame(T.State, v => v.setUint32(4, 0xdeadbeef, true), 4)), 'not a patch').toBe(false);
    // Modulation routings: macro 1 (ms_ctrl1, 7) onto engine parameter tag 0, muted, cleared.
    const routings = () => (new TextDecoder('latin1').decode(plugin.saveState()).match(/<modrouting source="7"[^>]*>/g) || []);
    const modulation = (op, value) => frame(T.Modulation, v => {
      [op, 0, 7, 0, 0].forEach((x, i) => v.setInt32(4 + i * 4, x, true));
      v.setFloat32(24, value, true);
    }, 24);
    const before = routings().length;
    expect(plugin.webviewReceive(modulation(0, 0.75))).toBe(true);
    expect(routings().length).toBe(before + 1);
    expect(plugin.webviewReceive(modulation(1, 1))).toBe(true);
    expect(routings().some(r => /depth="0.75" muted="1"/.test(r))).toBe(true);
    expect(plugin.webviewReceive(modulation(2, 0))).toBe(true);
    expect(routings().length).toBe(before);
    // Notes from the editor's keyboard play.
    plugin.webviewReceive(frame(T.Note, v => { v.setUint8(4, 1); v.setUint8(5, 0); v.setUint8(6, 60); v.setUint8(7, 100); }, 4));
    let peak = 0;
    for (let i = 0; i < 20; ++i) for (const x of plugin.process(256).left) peak = Math.max(peak, Math.abs(x));
    expect(peak).toBeGreaterThan(0.01);
    plugin.webviewReceive(frame(T.Note, v => { v.setUint8(4, 0); v.setUint8(5, 0); v.setUint8(6, 60); v.setUint8(7, 0); }, 4));
    // Editor view state is saved with the plug-in state.
    const xml = '<dawExtraState populated="1"><instanceZoomFactor v="150" /><editor current_scene="1" current_fx="3" modsource="1" /></dawExtraState>';
    expect(plugin.webviewReceive(frame(T.EditorState, v => new Uint8Array(v.buffer).set(new TextEncoder().encode(xml), 4), xml.length))).toBe(true);
    const saved = new TextDecoder('latin1').decode(plugin.saveState());
    expect(saved).toMatch(/<instanceZoomFactor v="150"/);
    expect(saved).toMatch(/<editor current_scene="1" current_fx="3"/);
    // Resize requests reach the host.
    plugin.webviewReceive(frame(T.Resize, v => { v.setUint32(4, 1370, true); v.setUint32(8, 950, true); }, 8));
    expect(host.resizes).toEqual([[1370, 950]]);
    expect(plugin.guiSize()).toEqual({width: 1370, height: 950});
  } finally { plugin.destroy(); }
});

test('telemetry reports meters, voices and keys, and the oscilloscope streams output', () => {
  const {plugin, host} = withPage();
  try {
    plugin.webviewReceive(hello());
    plugin.webviewReceive(frame(T.Scope, v => v.setUint8(4, 1), 1));
    host.sent.length = 0;
    plugin.process(2048, {events: [{type: EVENT.NOTE_ON, time: 0, key: 64, velocity: 0.9}]});
    plugin.onMainThread();
    const telemetry = new DataView(take(host, T.Telemetry).buffer);
    const vu = Math.max(telemetry.getFloat32(4, true), telemetry.getFloat32(8, true));
    expect(vu).toBeGreaterThan(0);
    expect(telemetry.getUint32(40, true), 'active voices').toBeGreaterThan(0);
    expect(telemetry.getUint8(44 + (64 >> 3)) & (1 << (64 & 7)), 'key 64 lit').toBeTruthy();
    const scope = take(host, T.ScopeAudio);
    expect(scope.length - 4).toBeGreaterThanOrEqual(2048 * 8);
    // A closed window gets nothing.
    plugin.guiDestroy();
    host.sent.length = 0;
    plugin.process(2048);
    plugin.onMainThread();
    expect(host.sent).toEqual([]);
  } finally { plugin.destroy(); }
});

test('get_resource serves the page and its files from the bundle, and nothing outside it', () => {
  const plugin = createPlugin(module);
  try {
    const bundled = fs.existsSync(path.join(root, 'build-wclap/surge-xt.wclap/ui/index.html'));
    test.skip(!bundled, 'Package the bundle first (web/scripts/package-wclap.py).');
    const page = plugin.webviewResource('/ui/index.html');
    expect(page.mime).toBe('text/html; charset=utf-8');
    for (const file of ['support.js', 'library.js', 'surge-xt-wclap-ui.js', 'surge-xt-wclap-ui.wasm', 'surge-xt-wclap-ui.data', 'library/manifest.json'])
      expect(plugin.webviewResource('/ui/' + file), file).not.toBeNull();
    expect(plugin.webviewResource('/ui/surge-xt-wclap-ui.wasm').mime).toBe('application/wasm');
    for (const bad of ['/module.wasm', '/ui/../module.wasm', 'ui/index.html', '/ui//index.html', '/missing'])
      expect(plugin.webviewResource(bad), bad).toBeNull();
  } finally { plugin.destroy(); }
});

test('process returns silence as a constant output and asks to sleep when quiet', () => {
  const plugin = createPlugin(module);
  try {
    const quiet = plugin.process(256);
    expect(quiet.status).toBe(PROCESS.CONTINUE_IF_NOT_QUIET);
    expect(quiet.constantMask).toBe(3n);
    const playing = plugin.process(256, {events: [{type: EVENT.NOTE_ON, time: 0, key: 60, velocity: 0.8}]});
    expect(playing.constantMask).toBe(0n);
  } finally { plugin.destroy(); }
});

test('a page state the engine already holds changes only the editor view, without a reload', () => {
  const {plugin, host} = withPage();
  try {
    plugin.webviewReceive(hello());
    const current = new TextDecoder('latin1').decode(plugin.saveState());
    // The page's state: the same patch, another editor view and dirty flag.
    const edited = current.replace(/<editor current_scene="\d+"/, '<editor current_scene="1"');
    expect(edited).not.toBe(current);
    const bytes = Uint8Array.from(edited, c => c.charCodeAt(0));
    new DataView(bytes.buffer).setUint32(4, new DataView(bytes.buffer).getUint32(4, true) + 0, true);
    const rescans = host.rescans.length, dirty = host.dirty;
    expect(plugin.webviewReceive(frame(T.State, v => new Uint8Array(v.buffer).set(bytes, 4), bytes.length))).toBe(true);
    expect(host.rescans.length, 'no reload').toBe(rescans);
    expect(host.dirty).toBe(dirty);
    expect(new TextDecoder('latin1').decode(plugin.saveState())).toMatch(/<editor current_scene="1"/);
  } finally { plugin.destroy(); }
});

// ---- protocol 2: output state, scale and size, remote controls, voices, deltas, user files

const delta = (digest, parts) => {
  const encoded = parts.map(part => ({...part, data: typeof part.data === 'string' ? new TextEncoder().encode(part.data) : part.data}));
  const size = 12 + encoded.reduce((n, part) => n + 8 + part.data.length, 0);
  return frame(T.Delta, v => {
    v.setBigUint64(4, BigInt(digest), true);
    v.setUint32(12, encoded.length, true);
    const bytes = new Uint8Array(v.buffer);
    let at = 16;
    for (const part of encoded) {
      bytes.set([part.kind, part.a ?? 0, part.b ?? 0, 0], at);
      v.setUint32(at + 4, part.data.length, true);
      bytes.set(part.data, at + 8);
      at += 8 + part.data.length;
    }
  }, size);
};
const PART = {Meta: 1, ExtraOsc: 2, StepSequence: 3, Mseg: 4, Formula: 5, ExtraLfo: 6, Macro: 7, ModulatorNames: 8, Wavetable: 9, Tuning: 10, FxData: 11};
const xmlOf = plugin => new TextDecoder('latin1').decode(plugin.saveState());

test('the editor gets the host output state, and keeps the plug-in processing while it is visible', () => {
  const {plugin, host} = withPage();
  try {
    plugin.webviewReceive(hello());
    const state = take(host, T.OutputState);
    const view = new DataView(state.buffer);
    expect([view.getFloat64(4, true), view.getUint8(12), view.getUint8(13), view.getUint32(16, true)]).toEqual([48000, 1, 0, 4096]);
    expect(new TextDecoder().decode(state.subarray(20))).toBe('Surge WCLAP test host');
    expect(host.processRequests, 'Hello wakes the plug-in').toBe(1);
    // Processing starts on the audio thread; the page hears it from the main thread.
    host.sent.length = 0;
    expect(plugin.process(256).status, 'awake while visible, even silent').toBe(PROCESS.CONTINUE);
    plugin.onMainThread();
    expect(new DataView(take(host, T.OutputState).buffer).getUint8(13)).toBe(1);
    expect(plugin.guiHide()).toBe(true);
    expect(plugin.process(256).status, 'a hidden editor lets a silent plug-in sleep').toBe(PROCESS.CONTINUE_IF_NOT_QUIET);
    expect(plugin.guiShow()).toBe(true);
    expect(host.processRequests, 'showing the editor wakes it').toBe(2);
    // The host stops processing (sleep): the page shows it and gets no telemetry.
    plugin.stopProcessing();
    plugin.onMainThread();
    expect(new DataView(take(host, T.OutputState).buffer).getUint8(13)).toBe(0);
    host.sent.length = 0;
    plugin.onMainThread();
    expect(host.sent.filter(m => m[0] === T.Telemetry)).toEqual([]);
  } finally { plugin.destroy(); }
});

test('host scale and size: hints keep the editor shape, sizes snap to its zooms, and the editor follows', () => {
  const {plugin, host} = withPage();
  try {
    expect(plugin.guiCanResize()).toBe(true);
    expect(plugin.guiResizeHints()).toEqual({horizontal: true, vertical: true, preserveAspectRatio: true, aspectWidth: 913, aspectHeight: 569});
    // Whole-percent zooms of 913 x 569, from 25 % to 500 %.
    expect(plugin.guiAdjustSize(1826, 1138)).toEqual({width: 1826, height: 1138});
    expect(plugin.guiAdjustSize(1000, 700)).toEqual({width: 995, height: 620});
    expect(plugin.guiAdjustSize(100, 100)).toEqual({width: 228, height: 142});
    expect(plugin.guiAdjustSize(20000, 20000)).toEqual({width: 4565, height: 2845});
    // Every zoom's size (as SurgeGUIEditor::setZoomFactor computes it) adjusts to itself.
    for (let zoom = 25; zoom <= 500; ++zoom) {
      const factor = Math.fround(zoom * 0.01), size = {width: Math.trunc(Math.fround(factor * 913)), height: Math.trunc(Math.fround(factor * 569))};
      expect(plugin.guiAdjustSize(size.width, size.height), `${zoom} %`).toEqual(size);
    }
    plugin.webviewReceive(hello());
    // The editor grew its virtual keyboard: a taller base, new hints, a resize request.
    plugin.webviewReceive(frame(T.Resize, v => [913, 619, 913, 619].forEach((x, i) => v.setUint32(4 + 4 * i, x, true)), 16));
    expect(host.hintChanges).toBe(1);
    expect(plugin.guiResizeHints()).toMatchObject({aspectWidth: 913, aspectHeight: 619});
    expect(host.resizes).toEqual([[913, 619]]);
    // The host resizes the window: the page is told and zooms; its answer is not
    // sent back to the host as a request.
    host.sent.length = 0;
    expect(plugin.guiSetSize(1826, 1238)).toBe(true);
    const resize = new DataView(take(host, T.Resize).buffer);
    expect([resize.getUint32(4, true), resize.getUint32(8, true)]).toEqual([1826, 1238]);
    plugin.webviewReceive(frame(T.Resize, v => [1826, 1238, 913, 619].forEach((x, i) => v.setUint32(4 + 4 * i, x, true)), 16));
    expect(host.resizes).toEqual([[913, 619]]);
    expect(plugin.guiSize()).toEqual({width: 1826, height: 1238});
    // The editor's own zoom change afterwards is a request again.
    plugin.webviewReceive(frame(T.Resize, v => [1369, 928, 913, 619].forEach((x, i) => v.setUint32(4 + 4 * i, x, true)), 16));
    expect(host.resizes.at(-1)).toEqual([1369, 928]);
    // The host's scale overrides the device pixel ratio.
    expect(plugin.guiSetScale(2)).toBe(true);
    expect(new DataView(take(host, T.Scale).buffer).getFloat64(4, true)).toBe(2);
    expect(plugin.guiSetScale(0)).toBe(false);
    plugin.webviewReceive(hello());
    expect(new DataView(take(host, T.Scale).buffer).getFloat64(4, true), 'reopened windows get it too').toBe(2);
    // A reopened window starts at the zoom saved with the instance.
    const xml = '<dawExtraState populated="1"><instanceZoomFactor v="150" /></dawExtraState>';
    plugin.webviewReceive(frame(T.EditorState, v => new Uint8Array(v.buffer).set(new TextEncoder().encode(xml), 4), xml.length));
    plugin.guiDestroy();
    expect(plugin.guiCreate()).toBe(true);
    expect(plugin.guiSize()).toEqual({width: 1369, height: 928});
  } finally { plugin.destroy(); }
});

test('remote controls are the desktop plug-in pages', () => {
  const plugin = createPlugin(module);
  try {
    const pages = plugin.remotePages();
    expect(pages.map(page => [page.section, page.name, page.id, page.forPreset])).toEqual([
      ['Global', 'Macros', 2054, false], ['Scene A', 'Scene A Mixer', 2055, false], ['Scene A', 'Scene A Filters', 2056, false],
      ['Scene B', 'Scene B Mixer', 2057, false], ['Scene B', 'Scene B Filters', 2058, false]]);
    const NONE = 0xffffffff;
    const ids = (scene, names) => names.map(name => name ? juceHash(scene + name) : NONE);
    expect(pages[0].params).toEqual(Array.from({length: 8}, (_, m) => juceHash('macro_' + m)));
    for (const [page, scene] of [[1, 'a_'], [3, 'b_']])
      expect(pages[page].params).toEqual(ids(scene, ['level_o1', 'level_o2', 'level_o3', null, 'level_noise', 'level_ring12', 'level_ring23', 'level_pfg']));
    for (const [page, scene] of [[2, 'a_'], [4, 'b_']])
      expect(pages[page].params).toEqual(ids(scene, ['filter1_cutoff', 'filter1_resonance', 'filter2_cutoff', 'filter2_resonance', 'ws_drive', null, 'f_balance', 'feedback']));
    const known = new Set(Array.from({length: plugin.paramCount()}, (_, i) => plugin.paramInfo(i).id));
    expect(pages.flatMap(page => page.params).filter(id => id !== NONE).every(id => known.has(id))).toBe(true);
  } finally { plugin.destroy(); }
});

test('voice info follows the patch: its polyphony, or one voice per monophonic scene', () => {
  const {plugin, host} = withPage();
  try {
    expect(plugin.voiceInfo()).toEqual({count: 16, capacity: 64, flags: 1});
    const polymode = juceHash('a_polymode');
    plugin.process(256, {events: [{type: EVENT.PARAM_VALUE, time: 0, id: polymode, value: plugin.paramFromText(polymode, 'Mono')}]});
    plugin.onMainThread();
    expect(host.voiceChanges).toBe(1);
    expect(plugin.voiceInfo().count).toBe(1);
  } finally { plugin.destroy(); }
});

test('structural edits as parts apply in place: a held note keeps playing, unlike a state load', async () => {
  // Three engines that get the same entropy (the first instance of a module with
  // the same seed), holding the same note.
  const engines = await Promise.all([0, 1, 2].map(async () => withPage(await loadModule({seed: 11}))));
  try {
    const shape = juceHash('a_lfo0_shape');
    for (const {plugin} of engines) {
      plugin.webviewReceive(hello());
      plugin.process(256, {events: [{type: EVENT.PARAM_VALUE, time: 0, id: shape, value: plugin.paramFromText(shape, 'MSEG')},
        {type: EVENT.NOTE_ON, time: 0, key: 60, velocity: 0.8}]});
    }
    const render = (plugin, blocks) => {
      const out = [];
      for (let i = 0; i < blocks; ++i) out.push(...plugin.process(256).left);
      return Float32Array.from(out);
    };
    const before = engines.map(({plugin}) => render(plugin, 40));
    expect(before[1]).toEqual(before[0]);
    // The edit: LFO 1's MSEG (routed nowhere) and the name of macro 1.
    const current = xmlOf(engines[0].plugin);
    const mseg = /<mseg scene="0" i="0"[^]*?<\/mseg>/.exec(current)[0];
    const edited = mseg.replace(/<segment ([^>]*?)v0="[^"]*"/, '<segment $1v0="0.250000"');
    expect(edited).not.toBe(mseg);
    const parts = [{kind: PART.Mseg, a: 0, b: 0, data: edited.replace(/^<mseg scene="0" i="0"/, '<mseg')},
      {kind: PART.Macro, a: 0, data: '<entry bipolar="0" label="Wobble" />'}];
    const engine = engines[0];
    engine.host.sent.length = 0;
    const dirty = engine.host.dirty;
    expect(engine.plugin.webviewReceive(delta(0, parts))).toBe(true);
    expect(engine.host.dirty).toBeGreaterThan(dirty);
    const after = xmlOf(engine.plugin);
    expect(after).toMatch(/<entry i="0" bipolar="0" v="[^"]*" label="Wobble"/);
    expect(/<mseg scene="0" i="0"[^]*?<\/mseg>/.exec(after)[0].replace(/^<mseg scene="0" i="0"/, '<mseg')).toBe(parts[0].data);
    // The same edit as a complete state reloads the patch, retriggering the note.
    const state = Uint8Array.from(after, c => c.charCodeAt(0));
    expect(engines[2].plugin.webviewReceive(frame(T.State, v => new Uint8Array(v.buffer).set(state, 4), state.length))).toBe(true);
    const [inPlace, untouched, reloaded] = engines.map(({plugin}) => render(plugin, 40));
    expect(inPlace, 'the edited engine plays on exactly as the untouched one').toEqual(untouched);
    expect(reloaded, 'a state load restarts the note').not.toEqual(untouched);
    // A delta that does not reproduce the page's state asks for the state.
    engine.host.sent.length = 0;
    expect(engine.plugin.webviewReceive(delta(12345, [parts[1]]))).toBe(true);
    expect(take(engine.host, T.NeedState)).not.toBeNull();
    // Malformed or out-of-range parts are refused.
    expect(engine.plugin.webviewReceive(delta(0, [{kind: PART.Mseg, a: 5, b: 0, data: parts[0].data}]))).toBe(false);
    expect(engine.plugin.webviewReceive(delta(0, [{kind: PART.Formula, a: 0, b: 0, data: '<nope'}]))).toBe(false);
  } finally { for (const {plugin} of engines) plugin.destroy(); }
});

test('the user folder is listed for the editor and written through the plug-in, inside the folder only', async () => {
  const fxp = fs.readFileSync(path.join(root, 'resources/data/patches_factory/Templates/Init Sine.fxp'));
  const user = memoryFiles({'Patches/Mine/Lead.fxp': new Uint8Array(fxp), 'SurgeXTUserDefaults.xml': '<defaults version="1" />'});
  const {plugin, host} = withPage(await loadModule({seed: 5, user}));
  const list = () => {
    host.sent.length = 0;
    expect(plugin.webviewReceive(frame(T.UserFiles, v => v.setUint32(4, VERSION, true), 4))).toBe(true);
    const reply = take(host, T.UserFileList), v = new DataView(reply.buffer), entries = new Map();
    let at = 12;
    for (let i = 0, count = v.getUint32(8, true); i < count; ++i) {
      const kind = v.getUint8(at), pathSize = v.getUint32(at + 12, true);
      const name = new TextDecoder().decode(reply.subarray(at + 16, at + 16 + pathSize));
      const dataSize = v.getUint32(at + 16 + pathSize, true);
      entries.set(name, {kind, mtime: v.getFloat64(at + 4, true), data: reply.subarray(at + 20 + pathSize, at + 20 + pathSize + dataSize)});
      at += 20 + pathSize + dataSize;
    }
    return {available: v.getUint8(4), entries};
  };
  let sequence = 0;
  const ops = list => {
    host.sent.length = 0;
    const encoded = list.map(([op, p, data = new Uint8Array()]) => [op, new TextEncoder().encode(p), typeof data === 'string' ? new TextEncoder().encode(data) : data]);
    const size = 8 + encoded.reduce((n, [, p, d]) => n + 12 + p.length + d.length, 0);
    const id = ++sequence;
    expect(plugin.webviewReceive(frame(T.UserFileOps, v => {
      v.setUint32(4, id, true); v.setUint32(8, encoded.length, true);
      const bytes = new Uint8Array(v.buffer);
      let at = 12;
      for (const [op, p, d] of encoded) {
        bytes[at] = op; v.setUint32(at + 4, p.length, true); bytes.set(p, at + 8);
        v.setUint32(at + 8 + p.length, d.length, true); bytes.set(d, at + 12 + p.length);
        at += 12 + p.length + d.length;
      }
    }, size))).toBe(true);
    const reply = take(host, T.UserFilesDone), v = new DataView(reply.buffer);
    expect(v.getUint32(4, true)).toBe(id);
    return {ok: !!v.getUint8(8), error: new TextDecoder().decode(reply.subarray(12))};
  };
  try {
    const first = list();
    expect(first.available).toBe(1);
    expect([...first.entries.keys()].sort()).toEqual(['Patches', 'Patches/Mine', 'Patches/Mine/Lead.fxp', 'SurgeXTUserDefaults.xml']);
    expect(first.entries.get('Patches').kind).toBe(2);
    expect(Buffer.from(first.entries.get('Patches/Mine/Lead.fxp').data).equals(fxp)).toBe(true);
    // Folder, file, replace, remove: applied in order, written atomically.
    expect(ops([[3, 'Patches/New'], [1, 'Patches/New/Pad.fxp', 'pad'], [1, 'Patches/New/Pad.fxp', 'pad 2'], [2, 'SurgeXTUserDefaults.xml']])).toEqual({ok: true, error: ''});
    expect(new TextDecoder().decode(user.read('/Patches/New/Pad.fxp'))).toBe('pad 2');
    expect(user.stat('/SurgeXTUserDefaults.xml')).toBeNull();
    expect([...user.entries.keys()].some(k => k.includes('.wclap-partial')), 'no partial files').toBe(false);
    const second = list();
    expect(new TextDecoder().decode(second.entries.get('Patches/New/Pad.fxp').data)).toBe('pad 2');
    // Paths that leave the folder, and failures, stop the batch with an error.
    for (const bad of ['../escape.fxp', '/abs.fxp', 'Patches//x', 'Patches/./x', 'a\\b', 'x.wclap-partial']) {
      const result = ops([[1, bad, 'x']]);
      expect(result.ok, bad).toBe(false);
    }
    const failed = ops([[4, 'Patches/New'], [1, 'Patches/after.fxp', 'x']]);
    expect(failed.ok, 'a folder with files is not removed').toBe(false);
    expect(failed.error).toMatch(/^Patches\/New: /);
    expect(user.stat('/Patches/after.fxp'), 'the batch stops at the failure').toBeNull();
  } finally { plugin.destroy(); }
  // Without a /user preopen the editor keeps user files in memory.
  const {plugin: alone, host: aloneHost} = withPage();
  try {
    alone.webviewReceive(frame(T.UserFiles, v => v.setUint32(4, VERSION, true), 4));
    const reply = take(aloneHost, T.UserFileList);
    expect([reply[4], new DataView(reply.buffer).getUint32(8, true)]).toEqual([0, 0]);
  } finally { alone.destroy(); }
});
