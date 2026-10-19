import {expect} from '../fixtures.js';

// The test WAM host (web/tests/wam-host) runs on another origin than the plugin,
// as a real host would: python3 web/scripts/serve.py --port 8081 --directory web/tests/wam-host
// next to python3 web/scripts/serve.py --cors (the plugin, on 8080).
export const hostUrl = process.env.SURGE_WAM_HOST_URL || 'http://127.0.0.1:8081/';
export const pluginUrl = new URL('/wam/index.js', process.env.SURGE_TEST_URL || 'http://127.0.0.1:8080').href;

export async function openHost(page) {
  page.setDefaultTimeout(20000);
  await page.goto(`${hostUrl}?plugin=${encodeURIComponent(pluginUrl)}`);
  // A user activation lets the host resume its AudioContext.
  await page.locator('#host-input').click();
}
export async function startWam(page, options = {}) {
  await openHost(page);
  const descriptor = await page.evaluate(options => wamHost.start(options), options);
  await expect.poll(() => page.evaluate(() => Module._surge_browser_audio_status())).toBe(2);
  return descriptor;
}
// Peak absolute output sample seen by the host's analyser during `ms`.
export const peak = (page, ms = 300) => page.evaluate(ms => wamHost.peak(ms), ms);
// Schedules events on the plugin node from the main thread. `at` is seconds from now.
export const schedule = (page, ...events) => page.evaluate(events => {
  const now = wamHost.context.currentTime;
  wamHost.plugin.audioNode.scheduleEvents(...events.map(({at, ...event}) =>
    at === undefined ? event : {...event, time: now + at}));
}, events);
// Emits events from the upstream test WAM on the audio thread. `delay` is seconds.
export const emitFromSequencer = (page, ...events) =>
  page.evaluate(events => wamHost.sequencer.port.postMessage({events}), events);
export const note = (key, velocity = 110, channel = 0) =>
  ({type: 'wam-midi', data: {bytes: [(velocity ? 0x90 : 0x80) | channel, key, velocity]}});
export const patchName = page => page.evaluate(() => Module.ccall('surge_browser_patch_name', 'string', [], []));
export async function requestPatch(page, path) {
  await page.evaluate(path => Module.ccall('surge_browser_request_patch', 'number', ['string'], [path]), path);
  await expect.poll(() => patchName(page)).toBe(path.split('/').pop().replace(/\.fxp$/, ''));
}
