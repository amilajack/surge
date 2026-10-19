// SPDX-License-Identifier: GPL-3.0-or-later
// The Surge XT WCLAP in a minimal webview host (web/tests/wclap-host): module.wasm
// in a DSP worker, audio through an AudioWorklet, and the editor page in a
// sandboxed srcdoc frame (opaque origin, no network) built from get_resource.
// Package the bundle first: web/scripts/package-wclap.py. Headless; with
// SURGE_TEST_SILENT_OUTPUT=1 Chrome renders audio to a silent output.
import {test, expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {root, juceHash} from './helpers/wclap.js';

const bundle = process.env.SURGE_WCLAP_BUNDLE || path.join(root, 'build-wclap/surge-xt.wclap');
const ready = fs.existsSync(path.join(bundle, 'ui/index.html'));
const port = 18000 + (process.pid % 1000);
const origin = `http://127.0.0.1:${port}`;
const VOLUME = juceHash('volume');
let server, directory, page;
const frameRequests = [];

test.describe.configure({mode: 'serial'});

test.beforeAll(async ({browser}) => {
  if (!ready) return;
  // The host, the host library and the bundle under one isolated origin.
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-wclap-host-'));
  fs.symlinkSync(path.join(root, 'web/tests/wclap-host'), path.join(directory, 'host'));
  fs.symlinkSync(path.join(root, 'web/wclap/host'), path.join(directory, 'lib'));
  fs.symlinkSync(bundle, path.join(directory, 'bundle'));
  server = spawn('python3', [path.join(root, 'web/scripts/serve.py'), '--directory', directory, '--port', String(port)], {stdio: 'ignore'});
  await expect.poll(() => fetch(origin + '/host/index.html').then(r => r.status).catch(() => 0), {timeout: 10000}).toBe(200);
  page = await browser.newPage();
  page.setDefaultTimeout(30000);
  // Every request the editor frame makes (blob: and data: URLs are not network).
  page.on('request', request => {
    if (request.frame() !== page.mainFrame() && !/^(blob|data):/.test(request.url())) frameRequests.push(request.url());
  });
  await page.goto(origin + '/host/index.html');
  await page.locator('#start').click();
});

test.afterAll(async () => {
  await page?.close();
  server?.kill();
  if (directory) fs.rmSync(directory, {recursive: true, force: true});
});

test.beforeEach(() => test.skip(!ready, 'Package the WCLAP bundle first (web/scripts/package-wclap.py).'));

const call = (method, args) => page.evaluate(([method, args]) => wclapHost.call(method, args), [method, args]);
// The editor frame, once it has the plug-in's snapshot.
async function editor() {
  let found = null;
  await expect.poll(async () => {
    found = page.frames().find(frame => frame !== page.mainFrame());
    return found ? found.evaluate(() => globalThis.Module?._surge_wclap_ui_connected?.() ?? 0).catch(() => 0) : 0;
  }, {timeout: 60000}).toBe(1);
  return found;
}
const patchName = frame => frame.evaluate(() => Module.ccall('surge_browser_patch_name', 'string', [], []));
// The editor's own (stand-in) value of a desktop parameter id.
const editorValue = (frame, id) => frame.evaluate(id => {
  const info = JSON.parse(Module.ccall('surge_wam_parameter_info', 'string', [], []));
  const index = info.findIndex(entry => entry.id === id);
  return Module.HEAPF32[(Module._surge_wam_parameter_values() >> 2) + index];
}, id);
const metaName = bytes => /<meta name="([^"]*)"/.exec(Buffer.from(bytes).toString('latin1'))?.[1];

test('the host opens the editor page from get_resource in a sandboxed, isolated frame', async () => {
  const frame = await editor();
  const iframe = page.locator('#window iframe');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await frame.evaluate(() => ({origin: self.origin, isolated: crossOriginIsolated, page: location.href,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content}))).toEqual({
    origin: 'null', isolated: true, page: 'about:srcdoc', csp: expect.stringContaining("default-src 'none'")});
  expect(await patchName(frame)).toBe('Init Saw');
  // The page reached nothing but get_resource: no network request left the frame.
  expect(frameRequests).toEqual([]);
  // The editor asked for its size and the host resized the window.
  await expect.poll(async () => Number(await iframe.getAttribute('height'))).toBeGreaterThan(600);
});

test('notes play through the DSP and the editor shows meters, voices and keys', async () => {
  const frame = await editor();
  await call('stats');
  await call('note', {key: 60, velocity: 0.8, on: true});
  await expect.poll(async () => (await call('stats')).peak, {timeout: 10000}).toBeGreaterThan(0.01);
  await expect.poll(() => frame.evaluate(() => Module._surge_wclap_ui_meter())).toBeGreaterThan(0);
  await expect.poll(() => frame.evaluate(() => Module._surge_browser_active_voices())).toBeGreaterThan(0);
  await call('note', {key: 60, on: false});
  await expect.poll(() => frame.evaluate(() => Module._surge_browser_active_voices()), {timeout: 15000}).toBe(0);
});

test('the oscilloscope streams the plug-in output while it is open', async () => {
  const frame = await editor();
  const before = await frame.evaluate(() => Module._surge_wclap_ui_scope_frames());
  await frame.locator('canvas').first().focus();
  await page.keyboard.press('Alt+o');
  await expect(frame.getByRole('group', {name: 'Oscilloscope', exact: true})).toBeAttached();
  await call('note', {key: 64, velocity: 0.8, on: true});
  await expect.poll(() => frame.evaluate(() => Module._surge_wclap_ui_scope_frames()), {timeout: 10000}).toBeGreaterThan(before + 4800);
  await call('note', {key: 64, on: false});
  await page.keyboard.press('Alt+o');
  await expect(frame.getByRole('group', {name: 'Oscilloscope', exact: true})).toHaveCount(0);
});

test('dragging a knob in the editor changes the DSP and reaches the host as automation', async () => {
  const frame = await editor();
  await call('stats');
  const before = (await call('param', {id: VOLUME})).value;
  const controls = JSON.parse(await frame.evaluate(() => Module.ccall('surge_browser_skin_controls', 'string', [], [])));
  const volume = controls.find(control => control.parameter === 'volume' && control.visible);
  expect(volume, 'the Global Volume slider').toBeTruthy();
  const box = await page.locator('#window iframe').boundingBox();
  const [x, y, w, h] = volume.bounds;
  const start = {x: box.x + 1 + x + w * 0.5, y: box.y + 1 + y + h / 2};
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 60, start.y, {steps: 12});
  await page.mouse.up();
  await expect.poll(async () => (await call('param', {id: VOLUME})).value).toBeLessThan(before - 0.01);
  const dsp = (await call('param', {id: VOLUME})).value;
  expect(await editorValue(frame, 'volume')).toBeCloseTo(dsp, 5);
  // The host recorded the edit with a gesture, as it would from a desktop plug-in.
  const events = (await call('stats')).outEvents.filter(event => event.id === VOLUME);
  expect(events.map(event => event.type)).toEqual(expect.arrayContaining([7, 5, 8]));
});

test('host automation moves the editor controls', async () => {
  const frame = await editor();
  await call('automate', {id: VOLUME, value: 0.31});
  await expect.poll(() => editorValue(frame, 'volume')).toBeCloseTo(0.31, 5);
  await call('automate', {id: juceHash('macro_2'), value: 0.6});
  await expect.poll(() => editorValue(frame, 'macro_2')).toBeCloseTo(0.6, 5);
  // Nothing echoes back to the host.
  expect((await call('stats')).outEvents.filter(event => event.id === VOLUME && event.type === 5)).toEqual([]);
});

test('loading a patch in the editor changes the DSP through state', async () => {
  const frame = await editor();
  await frame.evaluate(() => Module.ccall('surge_browser_request_patch', 'number', ['string'],
    ['/factory/patches_factory/Templates/Init Sine.fxp']));
  await expect.poll(() => patchName(frame), {timeout: 30000}).toBe('Init Sine');
  await expect.poll(async () => metaName(await call('saveState')), {timeout: 10000}).toBe('Init Sine');
  // A structural edit made in the editor (a tuning, through its own loader) also reaches the DSP.
  await frame.evaluate(async () => {
    await SurgeFactory.library.install('tuning_library/SCL/35.1 CET - Wendy Carlos - Gamma.scl', FS);
    Module.ccall('surge_browser_load_tuning', 'number', ['string'], ['/factory/tuning_library/SCL/35.1 CET - Wendy Carlos - Gamma.scl']);
  });
  await expect.poll(async () => Buffer.from(await call('saveState')).toString('latin1'), {timeout: 10000})
    .toMatch(/<hasTuning v="1"/);
});

test('a host state load updates the editor, and reopening the window restores the patch', async () => {
  let frame = await editor();
  const fm2 = fs.readFileSync(path.join(root, 'resources/data/patches_factory/Templates/Init FM2.fxp')).subarray(60);
  expect(await page.evaluate(bytes => wclapHost.call('loadState', {bytes: new Uint8Array(bytes)}), [...fm2])).toBe(true);
  await expect.poll(() => patchName(frame)).toBe('Init FM2');
  await page.evaluate(() => wclapHost.reopen());
  frame = await editor();
  expect(await patchName(frame)).toBe('Init FM2');
  expect(frameRequests).toEqual([]);
  expect(await editorValue(frame, 'volume')).toBeCloseTo((await call('param', {id: VOLUME})).value, 5);
});
