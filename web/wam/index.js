// SPDX-License-Identifier: GPL-3.0-or-later
// Surge XT as a Web Audio Module (WAM 2.0) instrument.
//
// A host imports this file and calls the default export's
// createInstance(groupId, audioContext, initialState). Requirements:
// - the host page is cross-origin isolated (COOP same-origin, COEP require-corp),
//   because Surge runs on shared-memory threads;
// - the host has created its WAM environment and group in the context's
//   AudioWorklet (initializeWamHost) before creating Surge;
// - one Surge instance per page, on a realtime AudioContext. A destroyed
//   instance cannot be recreated without reloading the page.
//
// The application is the same build as the standalone page. Module.surgeWam
// switches it to plugin mode: it renders into this plugin's container, resolves
// files against this module's URL, and attaches to the host's AudioContext
// instead of creating and connecting its own.

const moduleUrl = import.meta.url;
const baseUrl = new URL('../', moduleUrl).href;
// Support scripts the application calls into, in the standalone page's order.
// The standalone page's MIDI, transport, audio input and user-files controls are
// left out: the host provides MIDI, transport and audio.
const supportScripts = ['audio-lifecycle.js', 'reports.js', 'tuning-library.js', 'archive-recovery.js',
  'clipboard.js', 'text-input.js', 'accessibility.js', 'runtime.js'];
const stateFormat = 'surge-xt-patch';

let descriptorPromise = null;
const loadDescriptor = () => descriptorPromise ??= fetch(new URL('./descriptor.json', moduleUrl))
  .then(response => {
    if (!response.ok) throw new Error(`Surge XT descriptor download failed (${response.status})`);
    return response.json();
  })
  .then(descriptor => Object.freeze(descriptor))
  .catch(error => { descriptorPromise = null; throw error; });

// The page's single Surge runtime, claimed by the first instance.
let runtime = null;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const withTimeout = (promise, ms, message) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
async function poll(check, ms, message) {
  const deadline = performance.now() + ms;
  for (;;) {
    const result = check();
    if (result !== undefined) return result;
    if (performance.now() > deadline) throw new Error(message);
    await delay(10);
  }
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.crossOrigin = 'anonymous'; // report real errors from another origin
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Unable to download ${new URL(src).pathname.split('/').pop()}`));
    document.head.append(script);
  });
}
const toBase64 = bytes => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));

function checkHost(context) {
  if (!globalThis.crossOriginIsolated)
    throw new Error('Surge XT needs a cross-origin isolated host page. Serve it with ' +
      '"Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp".');
  if (typeof OfflineAudioContext !== 'undefined' && context instanceof OfflineAudioContext)
    throw new Error('Surge XT renders in real time and cannot run in an OfflineAudioContext.');
  if (!context || !context.audioWorklet) throw new Error('Surge XT needs an AudioContext with AudioWorklet support.');
  if (context.state === 'closed') throw new Error('The AudioContext is closed.');
  if ('Module' in globalThis)
    throw new Error('This page already defines globalThis.Module (another Emscripten application). ' +
      'Surge XT cannot share it.');
}

async function bootRuntime(state, context, groupId, instanceId) {
  checkHost(context);
  // The editor exists from startup, so it renders into a parked container until
  // the host asks for a GUI. The container stays in the document for focus,
  // hit testing and accessibility.
  const park = document.createElement('div');
  park.style.cssText = 'position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden';
  const container = document.createElement('div');
  container.className = 'surge-xt';
  container.style.cssText = 'position:relative;overflow:visible;background:#202328;color:white;font:14px sans-serif';
  park.append(container);
  document.body.append(park);
  Object.assign(state, {park, container, context});

  const started = deferred(), nodeReady = deferred(), registered = deferred();
  const wam = {
    baseUrl, container, context,
    onStatus(kind, message, code) {
      if (kind === 'status') {
        state.status = {code, message};
        if (code < 0) nodeReady.reject(new Error(message));
      }
      state.events.dispatchEvent(new CustomEvent('status', {detail: {kind, message, code}}));
    },
    nodeReady(node) { nodeReady.resolve(node); },
    registered(ok) {
      if (ok) registered.resolve();
      else registered.reject(new Error('The host has not set up its Web Audio Module group in this AudioContext. ' +
        'Call initializeWamHost (initializeWamEnv and initializeWamGroup) before creating Surge XT.'));
    }
  };
  const Module = globalThis.Module = {
    surgeWam: wam,
    locateFile: path => new URL(path, baseUrl).href,
    setStatus() {},
    onAbort(error) { started.reject(new Error('Surge XT failed to start: ' + String(error))); },
    // After main() has created the processor and editor.
    postRun: [() => started.resolve()]
  };
  for (const script of supportScripts) await loadScript(new URL(script, baseUrl).href);
  await loadScript(new URL('surge-xt-browser.js', baseUrl).href);
  await withTimeout(started.promise, 180000, 'Surge XT took too long to start.');
  state.Module = Module;
  globalThis.SurgeAccessibility.attach(Module);

  // The container takes the editor's size, so a host can lay out the GUI.
  const editor = globalThis.SurgeHost.mainCanvas;
  const size = () => {
    container.style.width = (parseFloat(editor.style.left) || 0) + (parseFloat(editor.style.width) || 0) + 'px';
    container.style.height = (parseFloat(editor.style.top) || 0) + (parseFloat(editor.style.height) || 0) + 'px';
  };
  new MutationObserver(size).observe(editor, {attributes: true, attributeFilter: ['style']});
  size();

  const writeId = (which, text) => {
    const pointer = Module._surge_wam_id_buffer(which, text.length);
    if (!pointer) throw new Error('WAM group and instance identifiers must be 1 to 256 characters.');
    for (let i = 0; i < text.length; ++i) Module.HEAPU16[(pointer >> 1) + i] = text.charCodeAt(i);
  };
  writeId(0, String(groupId));
  writeId(1, String(instanceId));
  if (!Module._surge_wam_attach()) throw new Error('Surge XT could not attach to the AudioContext.');
  const node = await withTimeout(nodeReady.promise, 60000, 'The Surge XT audio processor did not start.');
  await withTimeout(registered.promise, 10000, 'Surge XT could not join the host\'s WAM group.');
  return node;
}

class SurgeXTNode extends AudioWorkletNode {
  // Never constructed. Surge's own Emscripten worklet node adopts this prototype,
  // so host audio reaches the input bus without extra latency (BrowserAudio.cpp).
  get module() { return nodes.get(this).module; }
  get groupId() { return nodes.get(this).module.groupId; }
  get moduleId() { return nodes.get(this).module.moduleId; }
  get instanceId() { return nodes.get(this).module.instanceId; }

  async getParameterInfo(...ids) {
    const {parameters} = nodes.get(this);
    const result = {};
    for (const id of ids.length ? ids : parameters.order) {
      const info = parameters.info.get(id);
      if (info) result[id] = info;
    }
    return result;
  }
  // Values are normalized 0..1 either way: every parameter's range is 0..1.
  async getParameterValues(normalized = false, ...ids) {
    const state = nodes.get(this), {Module, parameters} = state;
    const pointer = Module._surge_wam_parameter_values() >> 2;
    const values = Module.HEAPF32.subarray(pointer, pointer + parameters.order.length);
    const result = {};
    for (const id of ids.length ? ids : parameters.order) {
      const index = parameters.index.get(id);
      if (index !== undefined) result[id] = {id, value: values[index], normalized: !!normalized};
    }
    return result;
  }
  async setParameterValues(values) {
    const state = nodes.get(this);
    alive(state);
    for (const [id, data] of Object.entries(values || {})) {
      const index = state.parameters.index.get(data?.id ?? id);
      if (index !== undefined && Number.isFinite(Number(data?.value)))
        state.Module._surge_wam_automation(0, index, Number(data.value), 0);
    }
  }
  // {format: 'surge-xt-patch', version: 1, data: base64}. The data is the desktop
  // plugin's state (a raw Surge patch), so it round-trips with getState.
  async getState() {
    const state = nodes.get(this), {Module} = state;
    alive(state);
    const size = await poll(() => {
      const result = Module._surge_wam_get_state();
      return result >= 0 ? result : undefined;
    }, 30000, 'Surge XT is still loading a patch; try again.');
    const pointer = Module._surge_wam_state_data();
    return {format: stateFormat, version: 1, data: toBase64(Module.HEAPU8.slice(pointer, pointer + size))};
  }
  async setState(value) {
    const state = nodes.get(this), {Module} = state;
    alive(state);
    if (value === undefined || value === null) return;
    let bytes;
    if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (value.format === stateFormat && value.version === 1 && typeof value.data === 'string')
      bytes = fromBase64(value.data);
    else throw new Error('Unrecognized Surge XT state.');
    const pointer = Module._surge_wam_state_buffer(bytes.length);
    if (!pointer) throw new Error('Surge XT state is empty or too large.');
    Module.HEAPU8.set(bytes, pointer);
    // -1: a patch load holds the loader; the queued bytes stay until the retry.
    const ticket = await poll(() => {
      const result = Module._surge_wam_set_state();
      return result >= 0 ? result : undefined;
    }, 30000, 'Surge XT is still loading a patch; try again.');
    if (!ticket) throw new Error('The state is not a Surge XT patch.');
    // Resolves once this load, or a later one that replaced it, has completed.
    await poll(() => (Module._surge_wam_state_loaded() >>> 0) >= ticket ? true : undefined, 60000,
      'Surge XT did not finish loading the state.');
  }
  async getCompensationDelay() { return 0; }
  // Events are delivered at their AudioContext time; MIDI is sample-accurate and
  // automation applies at the start of the 128-frame block that contains it.
  scheduleEvents(...events) {
    const state = nodes.get(this);
    if (state.destroyed) return;
    const {Module, parameters} = state, rate = this.context.sampleRate;
    for (const event of events) {
      const data = event?.data;
      if (!data) continue;
      const frame = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time * rate : 0;
      if (event.type === 'wam-midi' || event.type === 'wam-mpe') {
        const bytes = data.bytes;
        if (bytes) Module._surge_wam_midi(0, bytes[0] | 0, bytes[1] | 0, bytes[2] | 0, frame);
      } else if (event.type === 'wam-automation') {
        const index = parameters.index.get(data.id), value = Number(data.value);
        if (index === undefined) continue;
        // Effect types change on this thread, as the editor changes them; wait
        // for the event's time instead of handing them to the audio callback.
        const wait = parameters.control.has(index) && frame ? (event.time - this.context.currentTime) * 1000 : 0;
        if (wait > 0) setTimeout(() => { if (!state.destroyed) Module._surge_wam_automation(0, index, value, 0); }, wait);
        else Module._surge_wam_automation(0, index, value, frame);
      } else if (event.type === 'wam-transport') {
        Module._surge_wam_transport(0, data.playing ? 1 : 0, data.timeSigNumerator | 0, data.timeSigDenominator | 0,
          Number(data.currentBar), Number(data.currentBarStarted), Number(data.tempo), frame);
      }
    }
  }
  clearEvents() {
    const state = nodes.get(this);
    if (!state.destroyed) state.Module._surge_wam_clear(0);
  }
  // Surge has no event outputs.
  connectEvents() {}
  disconnectEvents() {}
  destroy() {
    const state = nodes.get(this);
    if (state.destroyed) return;
    state.destroyed = true;
    state.Module._surge_wam_destroy();
    if (state.gui) state.module.destroyGui(state.gui);
    this.disconnect();
  }
}
const nodes = new WeakMap();
function alive(state) {
  if (state.destroyed) throw new Error('This Surge XT instance was destroyed.');
}

function readParameters(Module) {
  const list = JSON.parse(Module.ccall('surge_wam_parameter_info', 'string', [], []));
  const info = new Map(), index = new Map(), order = [], control = new Set();
  list.forEach((entry, position) => {
    order.push(entry.id);
    if (entry.controlThread) control.add(position);
    index.set(entry.id, position);
    info.set(entry.id, Object.freeze({
      id: entry.id, label: entry.label, type: 'float', defaultValue: entry.defaultValue,
      minValue: 0, maxValue: 1, discreteStep: 0, exponent: 0, choices: [], units: '',
      normalize: value => value,
      denormalize: value => value,
      valueString: value => Module.ccall('surge_wam_parameter_text', 'string', ['number', 'number'], [position, value])
    }));
  });
  return {info, index, order, control};
}

export default class SurgeXT {
  static get isWebAudioModuleConstructor() { return true; }
  static async createInstance(groupId, audioContext, initialState) {
    const instance = new SurgeXT(groupId, audioContext);
    return instance.initialize(initialState);
  }
  constructor(groupId, audioContext) {
    this._groupId = groupId;
    this.audioContext = audioContext;
    this.audioNode = undefined;
    this.initialized = false;
    this._descriptor = null;
    this._instanceId = 'com.surge-synth-team.surge-xt-' + (crypto.randomUUID?.() ?? String(performance.now()));
  }
  get isWebAudioModule() { return true; }
  get groupId() { return this._groupId; }
  get moduleId() { return this.descriptor.identifier; }
  get instanceId() { return this._instanceId; }
  get descriptor() {
    if (!this._descriptor) throw new Error('Initialize Surge XT before reading its descriptor.');
    return this._descriptor;
  }
  get name() { return this.descriptor.name; }
  get vendor() { return this.descriptor.vendor; }
  // Status lines from the application ({kind, message, code}); code < 0 is a failure.
  addEventListener(...args) { runtime?.events.addEventListener(...args); }
  removeEventListener(...args) { runtime?.events.removeEventListener(...args); }

  async initialize(state) {
    this._descriptor = await loadDescriptor();
    if (!this.audioNode) this.audioNode = await this.createAudioNode(state);
    this.initialized = true;
    return this;
  }
  async createAudioNode(initialState) {
    if (this.audioNode) return this.audioNode;
    if (runtime) {
      throw new Error(runtime.module === this ? 'Surge XT is already starting.' :
        'Surge XT supports one instance per page' + (runtime.failed ? ', and it failed to start: ' + runtime.failed.message : '.'));
    }
    const state = runtime = {module: this, events: new EventTarget(), status: {code: 0, message: ''},
      destroyed: false, gui: null, Module: null, parameters: null, failed: null};
    try {
      const node = await bootRuntime(state, this.audioContext, this.groupId, this.instanceId);
      state.parameters = readParameters(state.Module);
      Object.setPrototypeOf(node, SurgeXTNode.prototype);
      nodes.set(node, state);
      if (initialState !== undefined && initialState !== null) await node.setState(initialState);
      return node;
    } catch (error) {
      state.failed = error;
      throw error;
    }
  }
  async createGui() {
    const state = runtime;
    if (!state || state.module !== this || !state.Module) throw new Error('Initialize Surge XT before creating its GUI.');
    alive(state);
    const gui = document.createElement('div');
    gui.className = 'surge-xt-gui';
    gui.style.cssText = 'display:inline-block;position:relative;vertical-align:top';
    // A second GUI takes the editor over from the first.
    gui.append(state.container);
    state.gui = gui;
    if (!state.watchingDisplays) {
      state.watchingDisplays = true;
      // JUCE keeps menus inside the visible viewport, in container coordinates.
      let pending = false;
      const changed = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; state.Module._surge_browser_displays_changed(); });
      };
      addEventListener('resize', changed, {passive: true});
      document.addEventListener('scroll', changed, {capture: true, passive: true});
      new ResizeObserver(changed).observe(gui);
    }
    requestAnimationFrame(() => state.Module._surge_browser_displays_changed());
    return gui;
  }
  destroyGui(gui) {
    const state = runtime;
    if (!state || state.module !== this || state.gui !== gui) return;
    // The editor stays alive in the parked container for the next GUI.
    state.park.append(state.container);
    state.gui = null;
  }
}
