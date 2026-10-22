// SPDX-License-Identifier: GPL-3.0-or-later
// Measure the editor's canvas uploads under the same WCLAP host and workload.
// Run once with the pinned bundle and once with a bundle containing a new UI.
// Usage: node web/scripts/wclap-ui-bench.mjs <bundle directory>
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = path.resolve(process.argv[2] || 'build-wclap/surge-xt.wclap');
if (!fs.existsSync(path.join(bundle, 'module.wasm'))) throw Error(`No WCLAP bundle at ${bundle}`);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-ui-bench-'));
const port = 19000 + (process.pid % 1000);
const origin = `http://127.0.0.1:${port}`;
let server, browser;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  fs.symlinkSync(path.join(root, 'web/tests/wclap-host'), path.join(directory, 'host'));
  fs.symlinkSync(path.join(root, 'web/wclap/host'), path.join(directory, 'lib'));
  fs.symlinkSync(bundle, path.join(directory, 'bundle'));
  server = spawn('python3', [path.join(root, 'web/scripts/serve.py'), '--directory', directory, '--port', String(port)], {stdio: 'ignore'});
  for (let attempt = 0; attempt < 100; ++attempt) {
    if (await fetch(`${origin}/host/index.html`).then(response => response.ok).catch(() => false)) break;
    if (attempt === 99) throw Error('WCLAP host did not start');
    await pause(100);
  }
  browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--disable-audio-output']});
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.putImageData;
    const originalCreate = CanvasRenderingContext2D.prototype.createImageData;
    globalThis.__surgePaint = {calls: 0, pixels: 0, milliseconds: 0, imageAllocations: 0};
    CanvasRenderingContext2D.prototype.createImageData = function (...args) {
      __surgePaint.imageAllocations++;
      return originalCreate.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.putImageData = function (image, ...args) {
      const start = performance.now();
      try { return original.call(this, image, ...args); }
      finally {
        __surgePaint.calls++;
        __surgePaint.pixels += image.width * image.height;
        __surgePaint.milliseconds += performance.now() - start;
      }
    };
  });
  await page.goto(`${origin}/host/index.html`);
  await page.locator('#start').click();
  let frame;
  for (let attempt = 0; attempt < 600; ++attempt) {
    frame = page.frames().find(candidate => candidate !== page.mainFrame());
    if (frame && await frame.evaluate(() => globalThis.Module?._surge_wclap_ui_connected?.() === 1).catch(() => false)) break;
    if (attempt === 599) throw Error('Surge XT editor did not connect');
    await pause(100);
  }
  await page.evaluate(() => wclapHost.call('guiSetScale', {scale: 2}));
  await pause(1000);
  const screenshot = createHash('sha256').update(await page.locator('#window iframe').screenshot()).digest('hex');
  const measure = async (name, action, duration) => {
    await frame.evaluate(() => { globalThis.__surgePaint = {calls: 0, pixels: 0, milliseconds: 0, imageAllocations: 0}; });
    await action();
    await pause(duration);
    const stats = await frame.evaluate(() => globalThis.__surgePaint);
    return {name, seconds: duration / 1000, ...stats};
  };
  const idle = await measure('idle', async () => {}, 2000);
  const note = await measure('held-note', async () => {
    await page.evaluate(() => wclapHost.call('note', {key: 60, velocity: 0.8, on: true}));
  }, 3000);
  await page.evaluate(() => wclapHost.call('note', {key: 60, on: false}));
  console.log(JSON.stringify({bundle, screenshot, idle, note}));
} finally {
  await browser?.close();
  server?.kill();
  fs.rmSync(directory, {recursive: true, force: true});
}
