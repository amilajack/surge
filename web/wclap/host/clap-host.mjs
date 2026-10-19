// SPDX-License-Identifier: GPL-3.0-or-later
// A minimal CLAP host for WCLAP modules (wasm32), for tests, benchmarks and the
// webview test page. It runs in Node, dedicated workers and AudioWorklets.
//
// One WclapModule is one instance of module.wasm; it creates any number of plug-in
// instances inside it, as a DAW does on one DSP thread. Host callbacks are JS
// functions placed in the module's function table through a generated forwarding
// module (an import re-exported as a wasm function).
import {Wasi, utf8Decode, utf8Encode} from './wasi.mjs';

const I32 = 0x7f, I64 = 0x7e, F64 = 0x7c;

// A wasm module that imports each function and exports it again, so plain JS
// functions can be stored in another module's funcref table.
async function forwardingFunctions(signatures) {
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const leb = (out, value) => { do { let b = value & 0x7f; value >>>= 7; if (value) b |= 0x80; out.push(b); } while (value); };
  const section = (id, body) => { bytes.push(id); leb(bytes, body.length); bytes.push(...body); };
  const name = (out, text) => { const encoded = utf8Encode(text); leb(out, encoded.length); out.push(...encoded); };
  const types = [];
  leb(types, signatures.length);
  for (const {params, results} of signatures) {
    types.push(0x60);
    leb(types, params.length); types.push(...params);
    leb(types, results.length); types.push(...results);
  }
  section(1, types);
  const imports = [];
  leb(imports, signatures.length);
  signatures.forEach((_, i) => { name(imports, 'h'); name(imports, 'f' + i); imports.push(0x00); leb(imports, i); });
  section(2, imports);
  const exports = [];
  leb(exports, signatures.length);
  signatures.forEach((_, i) => { name(exports, 'f' + i); exports.push(0x00); leb(exports, i); });
  section(7, exports);
  const module = await WebAssembly.compile(new Uint8Array(bytes));
  const instance = await WebAssembly.instantiate(module, {h: Object.fromEntries(signatures.map((s, i) => ['f' + i, s.fn]))});
  return signatures.map((_, i) => instance.exports['f' + i]);
}

export const EVENT = {NOTE_ON: 0, NOTE_OFF: 1, NOTE_CHOKE: 2, NOTE_END: 3, NOTE_EXPRESSION: 4,
  PARAM_VALUE: 5, PARAM_MOD: 6, PARAM_GESTURE_BEGIN: 7, PARAM_GESTURE_END: 8, TRANSPORT: 9, MIDI: 10};
export const PROCESS = {ERROR: 0, CONTINUE: 1, CONTINUE_IF_NOT_QUIET: 2, TAIL: 3, SLEEP: 4};
export const TRANSPORT = {HAS_TEMPO: 1, HAS_BEATS_TIMELINE: 2, HAS_SECONDS_TIMELINE: 4,
  HAS_TIME_SIGNATURE: 8, IS_PLAYING: 16, IS_RECORDING: 32, IS_LOOP_ACTIVE: 64, IS_WITHIN_PRE_ROLL: 128};
export const BEATTIME_FACTOR = 2 ** 31;

export class WclapModule {
  // bytes or module: the module.wasm; files: synchronous bundle reader (wasi.mjs);
  // seed: random_get seed for bit-identical renders; root: the bundle's WASI path.
  static async load({bytes, module, files, seed, random, root = '/', log} = {}) {
    const compiled = module ?? await WebAssembly.compile(bytes);
    const wasi = new Wasi({files, seed, random, log});
    const instance = await WebAssembly.instantiate(compiled, wasi.imports);
    const self = new WclapModule(instance, wasi);
    await self.start(root);
    return self;
  }

  constructor(instance, wasi) {
    this.instance = instance;
    this.exports = instance.exports;
    this.memory = this.exports.memory;
    this.table = this.exports.__indirect_function_table;
    this.wasi = wasi;
    wasi.bind(this.memory);
    this.plugins = new Map(); // host pointer -> WclapPlugin
    this.streams = new Map();
    this.events = null;       // the input event list of the current call
    this.output = null;       // the output event sink of the current call
  }

  // ---- memory helpers ----
  view() { return new DataView(this.memory.buffer); }
  u8() { return new Uint8Array(this.memory.buffer); }
  u32(pointer) { return this.view().getUint32(pointer, true); }
  malloc(size) {
    const pointer = this.exports.malloc(size) >>> 0;
    if (!pointer) throw Error('WCLAP module out of memory');
    this.u8().fill(0, pointer, pointer + size);
    return pointer;
  }
  free(pointer) { if (pointer) this.exports.free(pointer); }
  cString(text) {
    const encoded = utf8Encode(text);
    const pointer = this.malloc(encoded.length + 1);
    this.u8().set(encoded, pointer);
    return pointer;
  }
  readString(pointer, max = 1 << 20) {
    if (!pointer) return '';
    const heap = this.u8();
    let end = pointer;
    while (heap[end] && end - pointer < max) end++;
    return utf8Decode(heap.slice(pointer, end));
  }
  fn(index) { return this.table.get(index >>> 0); }

  async start(root) {
    this.exports._initialize?.();
    this.entry = (typeof this.exports.clap_entry === 'object' ? this.exports.clap_entry.value : this.exports.clap_entry) >>> 0;
    await this.installHost();
    const path = this.cString(root);
    if (!this.fn(this.u32(this.entry + 12))(path)) throw Error('clap_entry.init failed');
    this.free(path);
    const id = this.cString('clap.plugin-factory');
    this.factory = this.fn(this.u32(this.entry + 20))(id) >>> 0;
    this.free(id);
    if (!this.factory) throw Error('The module has no clap.plugin-factory');
  }

  descriptors() {
    const count = this.fn(this.u32(this.factory))(this.factory);
    const result = [];
    for (let i = 0; i < count; ++i) {
      const d = this.fn(this.u32(this.factory + 4))(this.factory, i) >>> 0;
      const field = offset => this.readString(this.u32(d + offset));
      const features = [];
      for (let list = this.u32(d + 44), item; list && (item = this.u32(list)); list += 4) features.push(this.readString(item));
      result.push({id: field(12), name: field(16), vendor: field(20), url: field(24), version: field(36), description: field(40), features});
    }
    return result;
  }

  // Host-side functions, shared by every plug-in of this module.
  async installHost() {
    const plugin = host => this.plugins.get(host >>> 0);
    const call = (host, name, ...args) => plugin(host)?.callbacks[name]?.(...args);
    const signatures = {
      getExtension: [[I32, I32], [I32], (host, id) => this.hostExtensions.get(this.readString(id)) ?? 0],
      requestRestart: [[I32], [], host => call(host, 'requestRestart')],
      requestProcess: [[I32], [], host => call(host, 'requestProcess')],
      requestCallback: [[I32], [], host => { const p = plugin(host); if (p) { p.callbackPending = true; p.callbacks.requestCallback?.(); } }],
      eventsSize: [[I32], [I32], () => this.events?.length ?? 0],
      eventsGet: [[I32, I32], [I32], (list, index) => this.events?.[index] ?? 0],
      tryPush: [[I32, I32], [I32], (list, event) => {
        const size = this.u32(event >>> 0);
        this.output?.push(this.u8().slice(event >>> 0, (event >>> 0) + size));
        return 1;
      }],
      streamWrite: [[I32, I32, I64], [I64], (stream, buffer, size) => {
        const sink = this.streams.get(stream >>> 0);
        if (!sink) return -1n;
        sink.chunks.push(this.u8().slice(buffer >>> 0, (buffer >>> 0) + Number(size)));
        return size;
      }],
      streamRead: [[I32, I32, I64], [I64], (stream, buffer, size) => {
        const source = this.streams.get(stream >>> 0);
        if (!source) return -1n;
        const chunk = source.data.subarray(source.position, source.position + Number(size));
        this.u8().set(chunk, buffer >>> 0);
        source.position += chunk.length;
        return BigInt(chunk.length);
      }],
      paramsRescan: [[I32, I32], [], (host, flags) => call(host, 'paramsRescan', flags)],
      paramsClear: [[I32, I32, I32], [], () => {}],
      paramsRequestFlush: [[I32], [], host => { const p = plugin(host); if (p) { p.flushPending = true; p.callbacks.requestFlush?.(); } }],
      stateMarkDirty: [[I32], [], host => call(host, 'markDirty')],
      guiResizeHintsChanged: [[I32], [], () => {}],
      guiRequestResize: [[I32, I32, I32], [I32], (host, w, h) => call(host, 'requestResize', w >>> 0, h >>> 0) ? 1 : 0],
      guiRequestShow: [[I32], [I32], () => 0],
      guiRequestHide: [[I32], [I32], () => 0],
      guiClosed: [[I32, I32], [], () => {}],
      webviewSend: [[I32, I32, I32], [I32], (host, buffer, size) => {
        const p = plugin(host);
        if (!p?.callbacks.webviewSend) return 0;
        const message = this.u8().slice(buffer >>> 0, (buffer >>> 0) + (size >>> 0));
        return p.callbacks.webviewSend(message.buffer) === false ? 0 : 1;
      }],
      log: [[I32, I32, I32], [], (host, severity, message) => {
        const text = this.readString(message >>> 0);
        const p = plugin(host);
        if (p?.callbacks.log) p.callbacks.log(severity, text); else console.warn(`[wclap ${severity}] ${text}`);
      }],
      changed: [[I32], [], () => {}],
    };
    const names = Object.keys(signatures);
    const functions = await forwardingFunctions(names.map(n => ({params: signatures[n][0], results: signatures[n][1], fn: signatures[n][2]})));
    const base = this.table.grow(functions.length);
    const index = {};
    names.forEach((n, i) => { this.table.set(base + i, functions[i]); index[n] = base + i; });
    this.index = index;
    const struct = words => {
      const pointer = this.malloc(words.length * 4);
      words.forEach((w, i) => this.view().setUint32(pointer + i * 4, w, true));
      return pointer;
    };
    this.hostExtensions = new Map([
      ['clap.params', struct([index.paramsRescan, index.paramsClear, index.paramsRequestFlush])],
      ['clap.state', struct([index.stateMarkDirty])],
      ['clap.gui', struct([index.guiResizeHintsChanged, index.guiRequestResize, index.guiRequestShow, index.guiRequestHide, index.guiClosed])],
      ['clap.webview/3', struct([index.webviewSend])],
      ['clap.log', struct([index.log])],
      ['clap.latency', struct([index.changed])],
      ['clap.tail', struct([index.changed])],
    ]);
    this.hostStrings = ['Surge WCLAP test host', 'Surge', 'https://github.com/amilajack/surge', '1.0.0'].map(t => this.cString(t));
  }

  createPlugin(id, callbacks = {}) {
    const host = this.malloc(48);
    const v = this.view();
    v.setUint32(host, 1, true); v.setUint32(host + 4, 2, true); v.setUint32(host + 8, 7, true);
    v.setUint32(host + 12, host, true);
    this.hostStrings.forEach((s, i) => v.setUint32(host + 16 + i * 4, s, true));
    v.setUint32(host + 32, this.index.getExtension, true);
    v.setUint32(host + 36, this.index.requestRestart, true);
    v.setUint32(host + 40, this.index.requestProcess, true);
    v.setUint32(host + 44, this.index.requestCallback, true);
    const plugin = new WclapPlugin(this, host, callbacks);
    this.plugins.set(host, plugin);
    const idPointer = this.cString(id);
    const pointer = this.fn(this.u32(this.factory + 8))(this.factory, host, idPointer) >>> 0;
    this.free(idPointer);
    if (!pointer) { this.plugins.delete(host); this.free(host); throw Error(`create_plugin(${id}) failed`); }
    plugin.pointer = pointer;
    if (!plugin.method(8)(pointer)) { plugin.destroy(); throw Error(`${id}: init failed`); }
    plugin.bindExtensions();
    return plugin;
  }

  // Heap bytes in use by the module (the high-water mark of its linear memory).
  memoryBytes() { return this.memory.buffer.byteLength; }

  withStream(data, fn) {
    const stream = this.malloc(8);
    const entry = data ? {data, position: 0} : {chunks: []};
    this.view().setUint32(stream + 4, data ? this.index.streamRead : this.index.streamWrite, true);
    this.streams.set(stream, entry);
    try {
      const ok = fn(stream);
      return {ok, entry};
    } finally {
      this.streams.delete(stream);
      this.free(stream);
    }
  }
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export class WclapPlugin {
  constructor(module, host, callbacks) {
    this.module = module;
    this.host = host;
    this.callbacks = callbacks;
    this.pointer = 0;
    this.callbackPending = false;
    this.flushPending = false;
  }
  method(offset) { return this.module.fn(this.module.u32(this.pointer + offset)); }
  extension(id) {
    const name = this.module.cString(id);
    const pointer = this.method(40)(this.pointer, name) >>> 0;
    this.module.free(name);
    return pointer;
  }
  bindExtensions() {
    const ids = {params: 'clap.params', state: 'clap.state', audioPorts: 'clap.audio-ports',
      notePorts: 'clap.note-ports', latency: 'clap.latency', tail: 'clap.tail', render: 'clap.render',
      gui: 'clap.gui', webview: 'clap.webview/3', voiceInfo: 'clap.voice-info'};
    this.ext = {};
    for (const [key, id] of Object.entries(ids)) this.ext[key] = this.extension(id);
  }
  extFn(ext, index) { return this.module.fn(this.module.u32(this.ext[ext] + index * 4)); }

  activate(sampleRate, minFrames = 1, maxFrames = 4096) {
    const m = this.module;
    this.maxFrames = maxFrames;
    if (!this.process_) {
      const p = this.process_ = {};
      p.struct = m.malloc(40);
      p.inputs = m.malloc(24); p.outputs = m.malloc(24);
      p.inPointers = m.malloc(8); p.outPointers = m.malloc(8);
      p.buffers = m.malloc(4 * 4 * maxFrames);
      p.inEvents = m.malloc(12); p.outEvents = m.malloc(8);
      p.transport = m.malloc(104);
      p.arena = m.malloc(1 << 16);
      const v = m.view();
      for (let c = 0; c < 2; ++c) {
        v.setUint32(p.inPointers + c * 4, p.buffers + c * 4 * maxFrames, true);
        v.setUint32(p.outPointers + c * 4, p.buffers + (2 + c) * 4 * maxFrames, true);
      }
      v.setUint32(p.inputs, p.inPointers, true); v.setUint32(p.inputs + 8, 2, true);
      v.setUint32(p.outputs, p.outPointers, true); v.setUint32(p.outputs + 8, 2, true);
      v.setUint32(p.inEvents, p.inEvents, true);
      v.setUint32(p.inEvents + 4, m.index.eventsSize, true);
      v.setUint32(p.inEvents + 8, m.index.eventsGet, true);
      v.setUint32(p.outEvents, p.outEvents, true);
      v.setUint32(p.outEvents + 4, m.index.tryPush, true);
      this.processFn = this.method(36);
    }
    if (!this.method(16)(this.pointer, sampleRate, minFrames, maxFrames)) throw Error('activate failed');
    this.steadyTime = 0n;
    this.processing = false;
  }
  startProcessing() {
    if (!this.method(24)(this.pointer)) throw Error('start_processing failed');
    this.processing = true;
  }

  // events: [{time, type, ...}] sorted by time. input: [Float32Array L, R] or null.
  // Returns {status, left, right, events} (outputs are views valid until the next call).
  process(frames, {events = [], transport = null, input = null} = {}) {
    const m = this.module, p = this.process_;
    if (frames > this.maxFrames) throw Error('frames exceed maxFrames');
    let v = m.view();
    const pointers = [];
    let at = p.arena;
    for (const event of events) {
      const size = writeEvent(v, at, event);
      pointers.push(at);
      at += (size + 7) & ~7;
    }
    if (transport) writeTransport(v, p.transport, transport);
    v.setBigInt64(p.struct, this.steadyTime, true);
    v.setUint32(p.struct + 8, frames, true);
    v.setUint32(p.struct + 12, transport ? p.transport : 0, true);
    v.setUint32(p.struct + 16, input ? p.inputs : 0, true);
    v.setUint32(p.struct + 20, p.outputs, true);
    v.setUint32(p.struct + 24, input ? 1 : 0, true);
    v.setUint32(p.struct + 28, 1, true);
    v.setUint32(p.struct + 32, p.inEvents, true);
    v.setUint32(p.struct + 36, p.outEvents, true);
    if (input) {
      const heap = new Float32Array(m.memory.buffer);
      heap.set(input[0].subarray(0, frames), (p.buffers >> 2));
      heap.set((input[1] ?? input[0]).subarray(0, frames), (p.buffers >> 2) + this.maxFrames);
    }
    m.events = pointers;
    const out = [];
    m.output = out;
    if (!this.processing) this.startProcessing();
    const status = this.processFn(this.pointer, p.struct);
    m.events = null;
    m.output = null;
    this.steadyTime += BigInt(frames);
    const heap = new Float32Array(m.memory.buffer);
    const left = heap.subarray((p.buffers >> 2) + 2 * this.maxFrames, (p.buffers >> 2) + 2 * this.maxFrames + frames);
    const right = heap.subarray((p.buffers >> 2) + 3 * this.maxFrames, (p.buffers >> 2) + 3 * this.maxFrames + frames);
    return {status, left, right, events: out.map(decodeEvent), constantMask: m.view().getBigUint64(p.outputs + 16, true)};
  }

  stopProcessing() { this.method(28)(this.pointer); this.processing = false; }
  deactivate() { this.method(20)(this.pointer); }
  reset() { this.method(32)(this.pointer); }
  onMainThread() { this.callbackPending = false; this.method(44)(this.pointer); }

  flush(events = []) {
    const m = this.module, p = this.process_;
    const v = m.view();
    const pointers = [];
    let at = p.arena;
    for (const event of events) { const size = writeEvent(v, at, event); pointers.push(at); at += (size + 7) & ~7; }
    m.events = pointers;
    const out = [];
    m.output = out;
    this.extFn('params', 5)(this.pointer, p.inEvents, p.outEvents);
    m.events = null; m.output = null;
    this.flushPending = false;
    return out.map(decodeEvent);
  }

  // ---- params ----
  paramCount() { return this.extFn('params', 0)(this.pointer) >>> 0; }
  paramInfo(index) {
    const m = this.module;
    const info = m.malloc(1320);
    try {
      if (!this.extFn('params', 1)(this.pointer, index, info)) return null;
      const v = m.view();
      return {id: v.getUint32(info, true), flags: v.getUint32(info + 4, true), cookie: v.getUint32(info + 8, true),
        name: m.readString(info + 12, 256), module: m.readString(info + 268, 1024),
        min: v.getFloat64(info + 1296, true), max: v.getFloat64(info + 1304, true), defaultValue: v.getFloat64(info + 1312, true)};
    } finally { m.free(info); }
  }
  paramValue(id) {
    const m = this.module;
    const out = m.malloc(8);
    try { return this.extFn('params', 2)(this.pointer, id, out) ? m.view().getFloat64(out, true) : null; }
    finally { m.free(out); }
  }
  paramText(id, value) {
    const m = this.module;
    const out = m.malloc(256);
    try { return this.extFn('params', 3)(this.pointer, id, value, out, 256) ? m.readString(out, 256) : null; }
    finally { m.free(out); }
  }
  paramFromText(id, text) {
    const m = this.module;
    const input = m.cString(text), out = m.malloc(8);
    try { return this.extFn('params', 4)(this.pointer, id, input, out) ? m.view().getFloat64(out, true) : null; }
    finally { m.free(input); m.free(out); }
  }

  // ---- state ----
  saveState() {
    const {ok, entry} = this.module.withStream(null, stream => this.extFn('state', 0)(this.pointer, stream));
    if (!ok) throw Error('state save failed');
    return concat(entry.chunks);
  }
  loadState(bytes) {
    const {ok} = this.module.withStream(bytes, stream => this.extFn('state', 1)(this.pointer, stream));
    return !!ok;
  }

  // ---- ports, latency, tail ----
  audioPorts(input) {
    const m = this.module, count = this.extFn('audioPorts', 0)(this.pointer, input ? 1 : 0) >>> 0, ports = [];
    const info = m.malloc(276);
    for (let i = 0; i < count; ++i) {
      if (!this.extFn('audioPorts', 1)(this.pointer, i, input ? 1 : 0, info)) continue;
      const v = m.view();
      ports.push({id: v.getUint32(info, true), name: m.readString(info + 4, 256), flags: v.getUint32(info + 260, true),
        channels: v.getUint32(info + 264, true), type: m.readString(v.getUint32(info + 268, true))});
    }
    m.free(info);
    return ports;
  }
  notePorts(input) {
    const m = this.module, count = this.extFn('notePorts', 0)(this.pointer, input ? 1 : 0) >>> 0, ports = [];
    const info = m.malloc(268);
    for (let i = 0; i < count; ++i) {
      if (!this.extFn('notePorts', 1)(this.pointer, i, input ? 1 : 0, info)) continue;
      const v = m.view();
      ports.push({id: v.getUint32(info, true), dialects: v.getUint32(info + 4, true), preferred: v.getUint32(info + 8, true), name: m.readString(info + 12, 256)});
    }
    m.free(info);
    return ports;
  }
  latency() { return this.extFn('latency', 0)(this.pointer) >>> 0; }
  tail() { return this.extFn('tail', 0)(this.pointer) >>> 0; }
  setRenderMode(offline) { return !!this.extFn('render', 1)(this.pointer, offline ? 1 : 0); }

  // ---- gui + webview ----
  guiCreate() {
    const api = this.module.cString('webview');
    try {
      if (!this.extFn('gui', 0)(this.pointer, api, 0)) return false;
      return !!this.extFn('gui', 2)(this.pointer, api, 0);
    } finally { this.module.free(api); }
  }
  guiSize() {
    const m = this.module, out = m.malloc(8);
    try { return this.extFn('gui', 5)(this.pointer, out, out + 4) ? {width: m.u32(out), height: m.u32(out + 4)} : null; }
    finally { m.free(out); }
  }
  guiCanResize() { return !!this.extFn('gui', 6)(this.pointer); }
  guiDestroy() { this.extFn('gui', 3)(this.pointer); }
  webviewUri() {
    const m = this.module;
    const length = this.extFn('webview', 0)(this.pointer, 0, 0);
    if (length <= 0) return null;
    const out = m.malloc(length);
    try { this.extFn('webview', 0)(this.pointer, out, length); return m.readString(out, length); }
    finally { m.free(out); }
  }
  webviewResource(path) {
    const m = this.module;
    const p = m.cString(path), mime = m.malloc(256);
    try {
      const {ok, entry} = m.withStream(null, stream => this.extFn('webview', 1)(this.pointer, p, mime, 256, stream));
      return ok ? {mime: m.readString(mime, 256), data: concat(entry.chunks)} : null;
    } finally { m.free(p); m.free(mime); }
  }
  webviewReceive(message) {
    const m = this.module;
    const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
    const buffer = m.malloc(Math.max(1, bytes.length));
    m.u8().set(bytes, buffer);
    try { return !!this.extFn('webview', 2)(this.pointer, buffer, bytes.length); }
    finally { m.free(buffer); }
  }

  destroy() {
    if (this.pointer) {
      if (this.process_) { try { if (this.processing) this.stopProcessing(); this.deactivate(); } catch {} }
      this.method(12)(this.pointer);
    }
    const m = this.module;
    if (this.process_) for (const key of ['struct', 'inputs', 'outputs', 'inPointers', 'outPointers', 'buffers', 'inEvents', 'outEvents', 'transport', 'arena']) m.free(this.process_[key]);
    m.plugins.delete(this.host);
    m.free(this.host);
    this.pointer = 0;
  }
}

function writeHeader(v, at, size, time, type) {
  v.setUint32(at, size, true); v.setUint32(at + 4, time, true);
  v.setUint16(at + 8, 0, true); v.setUint16(at + 10, type, true); v.setUint32(at + 12, 0, true);
}

function writeEvent(v, at, e) {
  switch (e.type) {
  case EVENT.NOTE_ON: case EVENT.NOTE_OFF: case EVENT.NOTE_CHOKE:
    writeHeader(v, at, 40, e.time, e.type);
    v.setInt32(at + 16, e.noteId ?? -1, true); v.setInt16(at + 20, e.port ?? 0, true);
    v.setInt16(at + 22, e.channel ?? 0, true); v.setInt16(at + 24, e.key, true);
    v.setFloat64(at + 32, e.velocity ?? 0, true);
    return 40;
  case EVENT.PARAM_VALUE: case EVENT.PARAM_MOD:
    writeHeader(v, at, 48, e.time, e.type);
    v.setUint32(at + 16, e.id, true); v.setUint32(at + 20, e.cookie ?? 0, true);
    v.setInt32(at + 24, e.noteId ?? -1, true); v.setInt16(at + 28, e.port ?? -1, true);
    v.setInt16(at + 30, e.channel ?? -1, true); v.setInt16(at + 32, e.key ?? -1, true);
    v.setFloat64(at + 40, e.value, true);
    return 48;
  case EVENT.NOTE_EXPRESSION:
    writeHeader(v, at, 40, e.time, e.type);
    v.setInt32(at + 16, e.expression, true); v.setInt32(at + 20, e.noteId ?? -1, true);
    v.setInt16(at + 24, e.port ?? 0, true); v.setInt16(at + 26, e.channel ?? -1, true);
    v.setInt16(at + 28, e.key ?? -1, true); v.setFloat64(at + 32, e.value, true);
    return 40;
  case EVENT.MIDI:
    writeHeader(v, at, 24, e.time, e.type);
    v.setUint16(at + 16, e.port ?? 0, true);
    for (let i = 0; i < 3; ++i) v.setUint8(at + 18 + i, e.data[i] ?? 0);
    return 24;
  case EVENT.TRANSPORT:
    writeTransport(v, at, e);
    return 104;
  default:
    throw Error('Unsupported event type ' + e.type);
  }
}

function writeTransport(v, at, t) {
  writeHeader(v, at, 104, t.time ?? 0, EVENT.TRANSPORT);
  let flags = TRANSPORT.HAS_TEMPO | TRANSPORT.HAS_BEATS_TIMELINE | TRANSPORT.HAS_TIME_SIGNATURE;
  if (t.playing) flags |= TRANSPORT.IS_PLAYING;
  v.setUint32(at + 16, t.flags ?? flags, true);
  v.setBigInt64(at + 24, BigInt(Math.round((t.beats ?? 0) * BEATTIME_FACTOR)), true);
  v.setBigInt64(at + 32, 0n, true);
  v.setFloat64(at + 40, t.tempo ?? 120, true);
  v.setFloat64(at + 48, 0, true);
  for (let o = 56; o < 96; o += 8) v.setBigInt64(at + o, 0n, true);
  v.setBigInt64(at + 88, BigInt(Math.round((t.barStart ?? 0) * BEATTIME_FACTOR)), true);
  v.setInt32(at + 96, t.bar ?? 0, true);
  v.setUint16(at + 100, t.numerator ?? 4, true); v.setUint16(at + 102, t.denominator ?? 4, true);
}

function decodeEvent(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = v.getUint16(10, true), time = v.getUint32(4, true);
  switch (type) {
  case EVENT.NOTE_END: case EVENT.NOTE_ON: case EVENT.NOTE_OFF: case EVENT.NOTE_CHOKE:
    return {type, time, noteId: v.getInt32(16, true), channel: v.getInt16(22, true), key: v.getInt16(24, true)};
  case EVENT.PARAM_VALUE:
    return {type, time, id: v.getUint32(16, true), value: v.getFloat64(40, true)};
  case EVENT.PARAM_GESTURE_BEGIN: case EVENT.PARAM_GESTURE_END:
    return {type, time, id: v.getUint32(16, true)};
  default:
    return {type, time};
  }
}
