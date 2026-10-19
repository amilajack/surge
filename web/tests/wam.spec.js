import {test, expect} from './fixtures.js';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {openHost, startWam, peak, schedule, emitFromSequencer, note, patchName, requestPatch, hostUrl, pluginUrl}
  from './helpers/wam.js';

// Surge XT as a Web Audio Module 2.0 instrument, loaded cross-origin by the test
// host in web/tests/wam-host (see helpers/wam.js for the two servers).
const factory = name => `/factory/patches_factory/Templates/${name}.fxp`;
const node = 'wamHost.plugin.audioNode';

test('the event queue delivers out-of-order WAM events in time order without panicking', () => {
  const executable = path.join(os.tmpdir(), `surge-wam-event-queue-${process.pid}`);
  execFileSync('c++', ['-std=c++17', '-pthread', path.resolve('tests/wam-event-queue.cpp'), '-o', executable]);
  execFileSync(executable);
});

test('a cross-origin host loads Surge XT as a WAM instrument', async ({page}) => {
  const descriptor = await startWam(page);
  expect(descriptor).toMatchObject({identifier: 'com.surge-synth-team.surge-xt', name: 'Surge XT', vendor: 'Surge Synth Team',
    isInstrument: true, hasMidiInput: true, hasMpeInput: true, hasAudioInput: true, hasAudioOutput: true,
    hasAutomationInput: true, hasMidiOutput: false, hasAutomationOutput: false, hasSysexInput: false});
  const shape = await page.evaluate(() => {
    const {plugin, Plugin, context} = wamHost, node = plugin.audioNode;
    return {constructor: Plugin.isWebAudioModuleConstructor, module: plugin.isWebAudioModule, initialized: plugin.initialized,
      moduleId: plugin.moduleId, instance: plugin.instanceId.startsWith(plugin.moduleId), group: plugin.groupId === wamHost.groupId,
      worklet: node instanceof AudioWorkletNode, context: node.context === context, back: node.module === plugin,
      ids: node.instanceId === plugin.instanceId && node.groupId === plugin.groupId && node.moduleId === plugin.moduleId,
      inputs: node.numberOfInputs, outputs: node.numberOfOutputs,
      host: location.origin, plugin: [...document.scripts].map(script => script.src).find(src => src.endsWith('/surge-xt-browser.js'))};
  });
  expect(shape).toMatchObject({constructor: true, module: true, initialized: true, moduleId: 'com.surge-synth-team.surge-xt',
    instance: true, group: true, worklet: true, context: true, back: true, ids: true, inputs: 1, outputs: 1});
  expect(new URL(shape.plugin).origin).toBe(new URL(pluginUrl).origin);
  expect(new URL(shape.plugin).origin).not.toBe(shape.host);
  expect(await page.evaluate(`${node}.getCompensationDelay()`)).toBe(0);
  // Nothing of the standalone page's chrome is added to the host page.
  for (const id of ['enable-audio', 'midi-controls', 'transport-controls', 'audio-input-controls', 'user-files', 'status'])
    expect(await page.locator(`#${id}`).count()).toBe(0);
  // Canvases and the accessibility mirror live in the plugin's container only.
  expect(await page.evaluate(() => [...document.querySelectorAll('canvas')].every(c => c.closest('.surge-xt')))).toBe(true);
  expect(await page.evaluate(() => document.getElementById('juce-accessibility')?.closest('.surge-xt') !== null)).toBe(true);
});

for (const sampleRate of [44100, 48000]) test(`MIDI scheduled by the host plays at ${sampleRate} Hz`, async ({page}) => {
  await startWam(page, {sampleRate});
  expect(await page.evaluate(() => wamHost.context.sampleRate)).toBe(sampleRate);
  expect(await peak(page)).toBe(0);
  await schedule(page, note(60));
  expect(await peak(page, 400)).toBeGreaterThan(0.02);
  await schedule(page, note(60, 0));
  await expect.poll(() => peak(page, 200), {timeout: 5000}).toBeLessThan(1e-4);
});

test('timed MIDI plays at its AudioContext time even when scheduled out of order', async ({page}) => {
  await startWam(page);
  // The note-off is scheduled first and far ahead; it must not hold back the note-on.
  await schedule(page, {...note(57, 0), at: 1.3}, {...note(57), at: 0.6});
  expect(await peak(page, 350)).toBe(0);
  await page.waitForTimeout(450);
  expect(await peak(page, 300)).toBeGreaterThan(0.02);
  await page.waitForTimeout(1000);
  await expect.poll(() => peak(page, 200), {timeout: 5000}).toBeLessThan(1e-4);
  // clearEvents drops scheduled events without sounding anything.
  await schedule(page, {...note(64), at: 0.5});
  await page.evaluate(`${node}.clearEvents()`);
  await page.waitForTimeout(500);
  expect(await peak(page, 400)).toBeLessThan(1e-4);
  expect(await page.evaluate(() => Module._surge_wam_dropped_events())).toBe(0);
});

test('an upstream WAM routes MIDI to Surge on the audio thread', async ({page}) => {
  await startWam(page);
  await emitFromSequencer(page, {...note(62), delay: 0.2});
  await expect.poll(() => peak(page, 200), {timeout: 5000}).toBeGreaterThan(0.02);
  await emitFromSequencer(page, note(62, 0));
  await expect.poll(() => peak(page, 200), {timeout: 5000}).toBeLessThan(1e-4);
});

test('parameters are described, automated from both threads and applied while suspended', async ({page}) => {
  await startWam(page);
  const info = await page.evaluate(async () => Object.values(await wamHost.plugin.audioNode.getParameterInfo())
    .map(({id, label, type, minValue, maxValue, defaultValue, discreteStep, choices}) =>
      ({id, label, type, minValue, maxValue, defaultValue, discreteStep, choices})));
  expect(info.length).toBeGreaterThan(700);
  expect(new Set(info.map(p => p.id)).size).toBe(info.length);
  expect(info.slice(0, 8).map(p => p.id)).toEqual(Array.from({length: 8}, (_, i) => `macro_${i}`));
  expect(info.every(p => p.type === 'float' && p.minValue === 0 && p.maxValue === 1 && p.discreteStep === 0 &&
    p.choices.length === 0 && p.defaultValue >= 0 && p.defaultValue <= 1 && p.label)).toBe(true);
  expect(info.some(p => p.id === 'surgext-bypass')).toBe(false);
  const volume = info.find(p => p.label === 'Global Volume');
  expect(volume).toBeTruthy();
  const value = id => page.evaluate(async id => (await wamHost.plugin.audioNode.getParameterValues(true, id))[id].value, id);
  // Defaults are Surge's own (0 dB for Global Volume), not JUCE's placeholder 0.
  expect(volume.defaultValue).toBe(1);
  expect(info.filter(p => p.defaultValue > 0).length).toBeGreaterThan(100);
  expect(await page.evaluate(async id => (await wamHost.plugin.audioNode.getParameterInfo(id))[id].valueString(0.5), volume.id))
    .toMatch(/dB/);
  // Unknown ids are ignored rather than failing the whole query.
  expect(Object.keys(await page.evaluate(id => wamHost.plugin.audioNode.getParameterInfo(id, 'no-such-parameter'), volume.id)))
    .toEqual([volume.id]);

  const slider = page.getByRole('slider', {name: 'Global Volume', exact: true});
  const shown = await slider.getAttribute('aria-valuetext');
  await page.evaluate(id => wamHost.plugin.audioNode.setParameterValues({[id]: {id, value: 0.25, normalized: true}}), volume.id);
  await expect.poll(() => value(volume.id)).toBeCloseTo(0.25, 5);
  await expect.poll(() => slider.getAttribute('aria-valuetext')).not.toBe(shown);
  await schedule(page, {type: 'wam-automation', data: {id: volume.id, value: 0.6, normalized: true}, at: 0.05});
  await expect.poll(() => value(volume.id)).toBeCloseTo(0.6, 5);
  await emitFromSequencer(page, {type: 'wam-automation', data: {id: 'macro_2', value: 0.4, normalized: true}});
  await expect.poll(() => value('macro_2')).toBeCloseTo(0.4, 2);

  // With the host's context suspended nothing renders; values still apply.
  await page.evaluate(() => wamHost.context.suspend());
  await expect.poll(() => page.evaluate(() => Module._surge_browser_audio_status())).toBe(4);
  await page.evaluate(id => wamHost.plugin.audioNode.setParameterValues({[id]: {id, value: 0.1, normalized: true}}), volume.id);
  expect(await value(volume.id)).toBeCloseTo(0.1, 5);
  await page.evaluate(() => wamHost.context.resume());
  await expect.poll(() => page.evaluate(() => Module._surge_browser_audio_status())).toBe(2);
});

test('the host transport sets tempo, play state and position', async ({page}) => {
  await startWam(page);
  const position = () => page.evaluate(() => Module._surge_browser_transport_position());
  const start = await page.evaluate(() => {
    const time = wamHost.context.currentTime;
    wamHost.plugin.audioNode.scheduleEvents({type: 'wam-transport', data: {currentBar: 8, currentBarStarted: time,
      tempo: 90, timeSigNumerator: 3, timeSigDenominator: 4, playing: true}});
    return time;
  });
  await expect.poll(() => page.evaluate(() => Module._surge_browser_transport_bpm())).toBe(90);
  await expect.poll(() => page.evaluate(() => Module._surge_browser_transport_playing())).toBe(1);
  // Bar 8 of 3/4 starts at quarter note 24, then advances at 1.5 quarter notes a second.
  await page.waitForTimeout(400);
  const [now, at] = await Promise.all([page.evaluate(() => wamHost.context.currentTime), position()]);
  expect(at).toBeGreaterThan(24);
  expect(Math.abs(at - (24 + (now - start) * 1.5))).toBeLessThan(0.1);
  // A patch load does not replace the host's tempo with the patch's.
  await requestPatch(page, factory('Init Sine'));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => Module._surge_browser_transport_bpm())).toBe(90);
  await emitFromSequencer(page, {type: 'wam-transport', data: {currentBar: 2, currentBarStarted: 0, tempo: 120,
    timeSigNumerator: 4, timeSigDenominator: 4, playing: false}});
  await expect.poll(() => page.evaluate(() => Module._surge_browser_transport_playing())).toBe(0);
  const stopped = await position();
  await page.waitForTimeout(300);
  expect(await position()).toBe(stopped);
});

test('state round-trips through JSON during playback and restores at creation', async ({page, browser}) => {
  await startWam(page);
  await requestPatch(page, factory('Init Sine'));
  const saved = await page.evaluate(`${node}.getState()`);
  expect(saved).toMatchObject({format: 'surge-xt-patch', version: 1});
  expect(saved.data.length).toBeGreaterThan(1000);
  await schedule(page, note(60));
  await requestPatch(page, factory('Init Square'));
  // Hosts often serialize state as JSON.
  await page.evaluate(state => wamHost.plugin.audioNode.setState(JSON.parse(state)), JSON.stringify(saved));
  expect(await patchName(page)).toBe('Init Sine');
  await schedule(page, note(60, 0));
  for (const [state, message] of [[{format: 'surge-xt-patch', version: 1, data: btoa('not a patch')}, 'not a Surge XT patch'],
    [{format: 'other', data: ''}, 'Unrecognized Surge XT state']])
    expect(await page.evaluate(state => wamHost.plugin.audioNode.setState(state).then(() => 'resolved', e => e.message), state))
      .toContain(message);
  expect(await patchName(page)).toBe('Init Sine');

  const second = await browser.newPage();
  try {
    await startWam(second, {state: saved});
    expect(await patchName(second)).toBe('Init Sine');
  } finally { await second.close(); }
});

test('host audio reaches the input bus', async ({page}) => {
  await startWam(page);
  await requestPatch(page, factory('Audio In Stereo Osc 1'));
  await schedule(page, note(60));
  expect(await peak(page, 300)).toBeLessThan(1e-4);
  await page.evaluate(() => {
    const tone = new OscillatorNode(wamHost.context, {frequency: 220});
    tone.connect(new GainNode(wamHost.context, {gain: 0.3})).connect(wamHost.plugin.audioNode);
    tone.start();
  });
  await expect.poll(() => peak(page, 200), {timeout: 5000}).toBeGreaterThan(0.01);
});

test('WAM events, automation and live state loads make no system heap calls in the callback', async ({page}) => {
  test.setTimeout(120000);
  await startWam(page);
  const counters = () => page.evaluate(() => ({heap: Module._surge_browser_audio_allocations(), releases: Module._surge_browser_audio_releases()}));
  const blocks = () => page.evaluate(() => Module._surge_browser_audio_blocks());
  const settle = async () => { const start = await blocks(); await expect.poll(blocks).toBeGreaterThan(start + 60); };
  const saved = await page.evaluate(`${node}.getState()`);
  await page.evaluate(() => Module._surge_browser_audio_allocations_reset());
  const ids = await page.evaluate(async () => Object.keys(await wamHost.plugin.audioNode.getParameterInfo()));
  const checks = [];
  const check = async (name, action) => { await action(); await settle(); checks.push([name, await counters()]); };
  await check('notes', () => schedule(page, ...[48, 52, 55, 60, 64].map((key, i) => ({...note(key), at: i * 0.01}))));
  await check('sequencer notes', () => emitFromSequencer(page, note(67), note(71)));
  await check('automation', () => schedule(page, ...ids.filter((_, i) => i % 7 === 0)
    .map((id, i) => ({type: 'wam-automation', data: {id, value: (i % 10) / 10, normalized: true}, at: (i % 20) * 0.003}))));
  // Effect types change through the control thread, as the editor changes them.
  // (Not Nimbus: a patch load that replaces a running Nimbus frees memory in the
  // callback in the standalone application too; Nimbus::initialize via suspend.)
  const type = id => page.evaluate(async id => (await wamHost.plugin.audioNode.getParameterValues(true, id))[id].value, id);
  const [type1, type2] = [await type('fx1_type'), await type('fx2_type')];
  await check('effect type', () => schedule(page, {type: 'wam-automation', data: {id: 'fx1_type', value: 0.3, normalized: true}, at: 0.05}));
  await check('sequencer effect type', () => emitFromSequencer(page, {type: 'wam-automation', data: {id: 'fx2_type', value: 0.1, normalized: true}}));
  await expect.poll(() => type('fx1_type')).not.toBe(type1);
  await expect.poll(() => type('fx2_type')).not.toBe(type2);
  await check('transport', () => schedule(page, {type: 'wam-transport', data: {currentBar: 1, currentBarStarted: 0, tempo: 133,
    timeSigNumerator: 4, timeSigDenominator: 4, playing: true}}));
  await check('state', () => page.evaluate(state => wamHost.plugin.audioNode.setState(state), saved));
  await check('release', () => schedule(page, ...[48, 52, 55, 60, 64, 67, 71].map(key => note(key, 0))));
  expect(checks.filter(([, c]) => c.heap || c.releases)).toEqual([]);
});

test('the GUI mounts, parks and remounts into a shadow root with working mouse and menus', async ({page}) => {
  await startWam(page);
  const first = await page.evaluate(() => wamHost.mountGui());
  expect(first.width).toBeGreaterThan(800);
  expect(first.height).toBeGreaterThan(500);
  expect(await page.evaluate(() => wamHost.gui.querySelectorAll('canvas').length)).toBeGreaterThan(0);
  await page.evaluate(() => wamHost.unmountGui());
  await expect.poll(() => page.evaluate(() => document.querySelector('.surge-xt').getBoundingClientRect().left)).toBeLessThan(-1000);
  const mounted = await page.evaluate(async () => {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:150px;top:60px';
    document.body.append(holder);
    const root = holder.attachShadow({mode: 'open'});
    const gui = wamHost.gui = await wamHost.plugin.createGui();
    root.append(gui);
    return gui.getBoundingClientRect().toJSON();
  });
  expect(mounted).toMatchObject({left: 150, top: 60, width: first.width, height: first.height});
  // The Menu button sits at the bottom right of the editor (Init Saw, default skin).
  await page.mouse.click(mounted.left + 872, mounted.top + 557);
  await expect(page.getByRole('menu')).toHaveCount(1);
  // JUCE keeps the menu inside the visible viewport, not inside the plugin's box.
  const menuBox = await page.evaluate(() => [...SurgeHost.container().querySelectorAll('canvas')]
    .filter(canvas => canvas.style.zIndex === '2000' && canvas.style.display !== 'none')
    .map(canvas => canvas.getBoundingClientRect().toJSON()).pop());
  expect(menuBox.left).toBeGreaterThanOrEqual(0);
  expect(menuBox.right).toBeLessThanOrEqual(1100);
  expect(menuBox.bottom).toBeLessThanOrEqual(750);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('keys typed into the host page stay with the host', async ({page}) => {
  await startWam(page);
  const gui = await page.evaluate(() => wamHost.mountGui());
  // Give Surge keyboard focus first, then move to the host's own field.
  await page.mouse.click(gui.left + 400, gui.top + 300);
  await page.locator('#host-input').click();
  await page.keyboard.type('abc');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('X.');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  expect(await page.inputValue('#host-input')).toBe('abX.');
  // A Surge menu open does not capture the host's navigation keys either.
  await page.mouse.click(gui.left + 872, gui.top + 557);
  await expect(page.getByRole('menu')).toHaveCount(1);
  await page.locator('#host-input').focus();
  await page.keyboard.press('Home');
  await page.keyboard.type('Y');
  expect(await page.inputValue('#host-input')).toBe('YabX.');
});

test('one instance per page; destroy stops the processor', async ({page}) => {
  await startWam(page);
  expect(await page.evaluate(() => wamHost.Plugin.createInstance(wamHost.groupId, wamHost.context).then(() => 'created', e => e.message)))
    .toContain('one instance per page');
  await page.evaluate(() => wamHost.mountGui());
  const blocks = () => page.evaluate(() => Module._surge_browser_audio_blocks());
  const before = await blocks();
  await expect.poll(blocks).toBeGreaterThan(before);
  await page.evaluate(`${node}.destroy()`);
  await page.waitForTimeout(200);
  const stopped = await blocks();
  await page.waitForTimeout(400);
  expect(await blocks()).toBe(stopped);
  expect(await page.evaluate(() => wamHost.gui.childElementCount)).toBe(0);
  expect(await page.evaluate(`${node}.getState().then(() => 'state', e => e.message)`)).toContain('destroyed');
  expect(await page.evaluate(() => wamHost.Plugin.createInstance(wamHost.groupId, wamHost.context).then(() => 'created', e => e.message)))
    .toContain('one instance per page');
});

test('hosts without a WAM group or cross-origin isolation get clear errors', async ({page, browser}) => {
  await openHost(page);
  expect(await page.evaluate(() => wamHost.start({initializeGroup: false}).then(() => 'started', e => e.message)))
    .toContain('Web Audio Module group');
  // Rewritten responses lose their loopback address space; allow the plugin fetch.
  const context = await browser.newContext({permissions: ['local-network-access']});
  const isolated = await context.newPage();
  try {
    await isolated.route(`${hostUrl}**`, async route => {
      const response = await route.fetch();
      const headers = {...response.headers()};
      delete headers['cross-origin-opener-policy'];
      delete headers['cross-origin-embedder-policy'];
      await route.fulfill({response, headers});
    });
    await openHost(isolated);
    expect(await isolated.evaluate(() => crossOriginIsolated)).toBe(false);
    expect(await isolated.evaluate(() => wamHost.start().then(() => 'started', e => e.message))).toContain('cross-origin isolated');
    expect(await isolated.evaluate(() => 'Module' in globalThis)).toBe(false);
  } finally { await context.close(); }
});
