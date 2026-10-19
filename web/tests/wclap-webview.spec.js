// SPDX-License-Identifier: GPL-3.0-or-later
// The WCLAP's CLAP surface and its side of the webview protocol, driven directly
// (src/surge-wclap/Protocol.h): no browser, the host is web/wclap/host.
import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {modulePath, root, loadModule, createPlugin, juceHash, PLUGIN_ID} from './helpers/wclap.js';
import {EVENT, PROCESS} from '../wclap/host/clap-host.mjs';

const ready = fs.existsSync(modulePath);
const T = {Hello: 1, Param: 2, Gesture: 3, State: 4, Modulation: 5, Note: 6, EditorState: 7, Resize: 8, Scope: 9,
  Snapshot: 64, Telemetry: 65, ScopeAudio: 66};
const frame = (type, write = () => {}, extra = 0) => {
  const bytes = new Uint8Array(4 + extra);
  bytes[0] = type;
  write(new DataView(bytes.buffer));
  return bytes;
};
const patchChunk = name => {
  const fxp = fs.readFileSync(path.join(root, 'resources/data/patches_factory/Templates', name + '.fxp'));
  return new Uint8Array(fxp.subarray(60));
};
const metaName = state => /<meta name="([^"]*)"/.exec(new TextDecoder('latin1').decode(state))?.[1];

let module;
test.beforeAll(async () => { if (ready) module = await loadModule({seed: 3}); });
test.beforeEach(() => test.skip(!ready, 'Build the WCLAP module first (web/scripts/build-wclap.sh).'));

function withPage() {
  const sent = [], host = {sent, mainThread: 0, flushes: 0, dirty: 0, rescans: [], resizes: []};
  const plugin = createPlugin(module, 48000, 4096, {
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
    expect(plugin.audioPorts(false)).toEqual([{id: 0, name: 'Output', flags: 1, channels: 2, type: 'stereo'}]);
    expect(plugin.audioPorts(true)).toEqual([{id: 1, name: 'Audio Input', flags: 1, channels: 2, type: 'stereo'}]);
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
    expect(plugin.webviewReceive(frame(T.Hello, v => v.setUint32(4, 1, true), 4))).toBe(true);
    const snapshot = take(host, T.Snapshot);
    expect(snapshot).not.toBeNull();
    expect(new DataView(snapshot.buffer).getUint32(4, true)).toBe(1);
    expect(metaName(snapshot.subarray(8))).toBe('Init Saw');
    expect(plugin.webviewReceive(frame(T.Hello, v => v.setUint32(4, 99, true), 4)), 'unknown protocol version').toBe(false);
  } finally { plugin.destroy(); }
});

test('page parameter edits reach the engine and the host, with gestures, without echo', () => {
  const {plugin, host} = withPage();
  try {
    plugin.webviewReceive(frame(T.Hello, v => v.setUint32(4, 1, true), 4));
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
    plugin.webviewReceive(frame(T.Hello, v => v.setUint32(4, 1, true), 4));
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
    plugin.webviewReceive(frame(T.Hello, v => v.setUint32(4, 1, true), 4));
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
    plugin.webviewReceive(frame(T.Hello, v => v.setUint32(4, 1, true), 4));
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
