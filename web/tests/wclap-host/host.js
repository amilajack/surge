// SPDX-License-Identifier: GPL-3.0-or-later
// A minimal WCLAP host page: module.wasm runs in a DSP worker, audio plays through
// an AudioWorklet, and the plug-in's clap.webview/3 page opens in a sandboxed
// srcdoc frame (opaque origin, no network) built from get_resource. The frame's
// fetch() of its own files is answered from get_resource through a MessagePort,
// as a DAW host does. Playwright drives it through globalThis.wclapHost.
const PLUGIN = 'org.surge-synth-team.surge-xt';
const VIRTUAL = 'https://wclap.invalid';
const CSP = ["default-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data: blob:", 'img-src data: blob:', 'font-src data: blob:', 'media-src data: blob:',
  'connect-src data: blob:', 'worker-src data: blob:', `base-uri ${VIRTUAL}`, "form-action 'none'"].join('; ');
// Runs first in the frame: answers fetch() of the page's own (virtual) URLs.
const BOOTSTRAP = `(() => {
  const pending = new Map(), queued = [];
  let port = null, next = 0;
  addEventListener('message', event => {
    if (event.source !== parent || event.data !== 'wclap-host:resources' || !event.ports[0]) return;
    event.stopImmediatePropagation();
    port = event.ports[0];
    port.onmessage = ({data}) => {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.ok) request.resolve(new Response(data.body, {headers: {'content-type': data.mime}}));
      else request.reject(new TypeError('Failed to fetch ' + data.path));
    };
    for (const message of queued.splice(0)) port.postMessage(message);
  });
  const nativeFetch = fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), document.baseURI);
    if (url.origin !== ${JSON.stringify(VIRTUAL)}) return nativeFetch(input, init);
    return new Promise((resolve, reject) => {
      const message = {id: next++, path: decodeURIComponent(url.pathname)};
      pending.set(message.id, {resolve, reject});
      if (port) port.postMessage(message); else queued.push(message);
    });
  };
})();`;

const log = document.getElementById('log');
const say = text => { log.textContent += text + '\n'; };
const worker = new Worker(new URL('dsp-worker.js', import.meta.url), {type: 'module'});
let nextId = 0, frame = null, frameLoaded = false, resources = null;
const replies = new Map(), queuedMessages = [];
const events = [];
worker.onmessage = ({data}) => {
  if (data.type === 'reply') {
    const reply = replies.get(data.id);
    replies.delete(data.id);
    if (data.error) reply.reject(new Error(data.error)); else reply.resolve(data.result);
  } else if (data.type === 'webview') {
    if (frameLoaded) frame.contentWindow.postMessage(data.buffer, '*', [data.buffer]);
    else queuedMessages.push(data.buffer);
  } else if (data.type === 'event') {
    events.push(data);
    if (data.name === 'resize' && frame) { frame.width = data.width; frame.height = data.height; }
    if (data.name === 'log') say(`plug-in: ${data.text}`);
  }
};
const call = (method, args, transfer = []) => new Promise((resolve, reject) => {
  const id = nextId++;
  replies.set(id, {resolve, reject});
  worker.postMessage({id, method, args}, transfer);
});

addEventListener('message', event => {
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data;
  const buffer = data instanceof ArrayBuffer ? data
    : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null;
  if (buffer) call('receive', {buffer}, [buffer]);
});

async function pageDocument(uri) {
  const page = new URL(uri, VIRTUAL + '/');
  if (page.origin !== VIRTUAL) throw new Error('This test host opens bundled pages only');
  const found = await call('resource', {path: decodeURIComponent(page.pathname)});
  if (!found) throw new Error('The plug-in has no ' + page.pathname);
  const html = new TextDecoder().decode(found.data);
  const prelude = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><base href="${page.href}"><script>${BOOTSTRAP}<\/script>`;
  return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, head => head + prelude) : prelude + html;
}

async function openWindow() {
  const {ok, size, uri} = await call('guiCreate');
  if (!ok) throw new Error('The plug-in has no webview GUI');
  frame = document.createElement('iframe');
  frame.title = 'Surge XT';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('allow', 'cross-origin-isolated');
  frame.width = size.width;
  frame.height = size.height;
  frameLoaded = false;
  frame.addEventListener('load', () => {
    frameLoaded = true;
    const channel = new MessageChannel();
    resources = channel.port1;
    resources.onmessage = async ({data}) => {
      const found = await call('resource', {path: data.path}).catch(() => null);
      if (!found) { resources.postMessage({id: data.id, path: data.path, ok: false}); return; }
      const body = found.data.buffer;
      resources.postMessage({id: data.id, path: data.path, ok: true, mime: found.mime, body}, [body]);
    };
    frame.contentWindow.postMessage('wclap-host:resources', '*', [channel.port2]);
    for (const buffer of queuedMessages.splice(0)) frame.contentWindow.postMessage(buffer, '*', [buffer]);
  });
  await call('open');
  frame.srcdoc = await pageDocument(uri);
  document.getElementById('window').append(frame);
  say(`window open (${size.width}x${size.height})`);
}

async function closeWindow() {
  if (!frame) return;
  await call('guiDestroy');
  resources?.close();
  frame.remove();
  frame = null;
  queuedMessages.length = 0;
  say('window closed');
}

let context = null;
async function startAudio() {
  context = new AudioContext({sampleRate: 48000, latencyHint: 'interactive'});
  await context.audioWorklet.addModule(new URL('output-worklet.js', import.meta.url));
  const node = new AudioWorkletNode(context, 'wclap-output', {numberOfInputs: 0, outputChannelCount: [2]});
  node.connect(context.destination);
  const channel = new MessageChannel();
  node.port.postMessage({port: channel.port1}, [channel.port1]);
  worker.postMessage({method: 'audio'}, [channel.port2]);
  await context.resume();
}

const params = new URLSearchParams(location.search);
const bundle = new URL(params.get('bundle') || '../bundle/', location.href).href;
globalThis.wclapHost = {
  async start() {
    const descriptors = await call('load', {bundle, seed: Number(params.get('seed') || 1)});
    const info = await call('create', {id: PLUGIN, rate: 48000});
    await startAudio();
    await openWindow();
    say(`${descriptors[0].name} ${descriptors[0].version}: ${info.params} parameters`);
    return {descriptors, info};
  },
  call,
  openWindow,
  closeWindow,
  async reopen() { await closeWindow(); await openWindow(); },
  // The host resizes the window (adjusted to the plug-in's hints first).
  async setSize(width, height) {
    const size = await call('guiSetSize', {width, height});
    if (frame) { frame.width = size.width; frame.height = size.height; }
    return size;
  },
  frame: () => frame,
  events: () => events.splice(0),
};
document.getElementById('start').addEventListener('click', () => wclapHost.start().catch(error => say(String(error))));
