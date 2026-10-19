// SPDX-License-Identifier: GPL-3.0-or-later
// A small WASI preview1 implementation for hosting WCLAP modules in Node, workers
// and AudioWorklets. The file system is one read-only preopened directory ("/")
// served by a synchronous backend: { stat(path), read(path), list(path) }.
// random_get draws from a seeded generator when a seed is given, so a host can
// make every render of a module bit-identical.

const ERRNO = {SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44,
  NOSYS: 52, NOTDIR: 54, PERM: 63, ROFS: 69, NOTCAPABLE: 76};
const FILETYPE = {CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4};
const OFLAGS = {CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8};
const RIGHTS_ALL = 0x1fffffffn;

export class WasiExit extends Error {
  constructor(code) { super(`WASI exit ${code}`); this.code = code; }
}

// UTF-8 without TextEncoder/TextDecoder, which AudioWorkletGlobalScope lacks.
export function utf8Encode(text) {
  const out = [];
  for (const char of text) {
    let c = char.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  return new Uint8Array(out);
}
export function utf8Decode(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    let c = b;
    if (b >= 0xf0) c = (b & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
    else if (b >= 0xe0) c = (b & 15) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
    else if (b >= 0xc0) c = (b & 31) << 6 | bytes[i++] & 63;
    text += String.fromCodePoint(c);
  }
  return text;
}

// splitmix64 over BigInt; seeds are 64-bit.
export function seededBytes(seed) {
  let state = BigInt.asUintN(64, BigInt(seed));
  return length => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 8) {
      state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
      let z = state;
      z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
      z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
      z ^= z >> 31n;
      for (let k = 0; k < 8 && i + k < length; ++k) out[i + k] = Number((z >> BigInt(8 * k)) & 255n);
    }
    return out;
  };
}

function normalize(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return '/' + parts.join('/');
}

export class Wasi {
  // files: synchronous backend; seed: BigInt/number for random_get, or undefined
  // for crypto randomness; log: (stream, text) for stdout/stderr lines.
  constructor({files, seed, random, log = (stream, text) => console[stream === 2 ? 'error' : 'log'](text), now} = {}) {
    this.files = files;
    this.random = random ?? (seed === undefined ? null : seededBytes(seed));
    this.log = log;
    this.now = now ?? (() => (globalThis.performance?.now?.() ?? Date.now()));
    this.memory = null;
    this.fds = new Map([[0, {kind: 'stdin'}], [1, {kind: 'stdout', text: ''}], [2, {kind: 'stdout', text: ''}],
      [3, {kind: 'dir', path: '/', preopen: '/'}]]);
    this.nextFd = 4;
    this.imports = {wasi_snapshot_preview1: this.functions()};
  }
  bind(memory) { this.memory = memory; }
  view() { return new DataView(this.memory.buffer); }
  bytes() { return new Uint8Array(this.memory.buffer); }
  string(pointer, length) { return utf8Decode(this.bytes().subarray(pointer, pointer + length)); }

  resolve(fd, pointer, length) {
    const base = this.fds.get(fd);
    if (!base || base.kind !== 'dir') return null;
    const relative = this.string(pointer, length);
    return normalize(relative.startsWith('/') ? relative : base.path + '/' + relative);
  }
  stat(path) {
    if (path === '/') return {type: 'dir', size: 0};
    return this.files.stat(path);
  }
  writeFilestat(pointer, stat, ino = 0) {
    const v = this.view();
    for (let i = 0; i < 64; i += 8) v.setBigUint64(pointer + i, 0n, true);
    v.setBigUint64(pointer + 8, BigInt(ino), true);
    v.setUint8(pointer + 16, stat.type === 'dir' ? FILETYPE.DIRECTORY : stat.type === 'char' ? FILETYPE.CHARACTER_DEVICE : FILETYPE.REGULAR_FILE);
    v.setBigUint64(pointer + 24, 1n, true);
    v.setBigUint64(pointer + 32, BigInt(stat.size ?? 0), true);
  }

  functions() {
    const wasi = this;
    const iovs = (pointer, count, fn) => {
      const v = wasi.view();
      let total = 0;
      for (let i = 0; i < count; ++i) {
        const base = v.getUint32(pointer + i * 8, true), length = v.getUint32(pointer + i * 8 + 4, true);
        const done = fn(base, length);
        total += done;
        if (done < length) break;
      }
      return total;
    };
    return {
      args_sizes_get(count, size) { const v = wasi.view(); v.setUint32(count, 0, true); v.setUint32(size, 0, true); return ERRNO.SUCCESS; },
      args_get() { return ERRNO.SUCCESS; },
      environ_sizes_get(count, size) { const v = wasi.view(); v.setUint32(count, 0, true); v.setUint32(size, 0, true); return ERRNO.SUCCESS; },
      environ_get() { return ERRNO.SUCCESS; },
      clock_res_get(id, pointer) { wasi.view().setBigUint64(pointer, 1000n, true); return ERRNO.SUCCESS; },
      clock_time_get(id, precision, pointer) {
        const ms = id === 0 ? Date.now() : wasi.now();
        wasi.view().setBigUint64(pointer, BigInt(Math.round(ms * 1e6)), true);
        return ERRNO.SUCCESS;
      },
      random_get(pointer, length) {
        const target = wasi.bytes().subarray(pointer, pointer + length);
        if (wasi.random) target.set(wasi.random(length));
        else globalThis.crypto.getRandomValues(target);
        return ERRNO.SUCCESS;
      },
      proc_exit(code) { throw new WasiExit(code); },
      sched_yield() { return ERRNO.SUCCESS; },
      poll_oneoff() { return ERRNO.NOSYS; },
      fd_prestat_get(fd, pointer) {
        const entry = wasi.fds.get(fd);
        if (!entry?.preopen) return ERRNO.BADF;
        const v = wasi.view();
        v.setUint8(pointer, 0);
        v.setUint32(pointer + 4, utf8Encode(entry.preopen).length, true);
        return ERRNO.SUCCESS;
      },
      fd_prestat_dir_name(fd, pointer, length) {
        const entry = wasi.fds.get(fd);
        if (!entry?.preopen) return ERRNO.BADF;
        wasi.bytes().set(utf8Encode(entry.preopen).subarray(0, length), pointer);
        return ERRNO.SUCCESS;
      },
      fd_fdstat_get(fd, pointer) {
        const entry = wasi.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        const v = wasi.view();
        v.setUint8(pointer, entry.kind === 'dir' ? FILETYPE.DIRECTORY : entry.kind === 'file' ? FILETYPE.REGULAR_FILE : FILETYPE.CHARACTER_DEVICE);
        v.setUint16(pointer + 2, 0, true);
        v.setBigUint64(pointer + 8, RIGHTS_ALL, true);
        v.setBigUint64(pointer + 16, RIGHTS_ALL, true);
        return ERRNO.SUCCESS;
      },
      fd_fdstat_set_flags() { return ERRNO.SUCCESS; },
      fd_filestat_get(fd, pointer) {
        const entry = wasi.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        wasi.writeFilestat(pointer, entry.kind === 'file' ? {type: 'file', size: entry.data.length}
          : entry.kind === 'dir' ? {type: 'dir'} : {type: 'char'}, fd);
        return ERRNO.SUCCESS;
      },
      fd_filestat_set_size() { return ERRNO.ROFS; },
      fd_filestat_set_times() { return ERRNO.ROFS; },
      fd_advise() { return ERRNO.SUCCESS; },
      fd_allocate() { return ERRNO.ROFS; },
      fd_datasync() { return ERRNO.SUCCESS; },
      fd_sync() { return ERRNO.SUCCESS; },
      fd_close(fd) {
        if (!wasi.fds.has(fd) || fd < 3) return ERRNO.BADF;
        wasi.fds.delete(fd);
        return ERRNO.SUCCESS;
      },
      fd_seek(fd, offset, whence, pointer) {
        const entry = wasi.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        if (entry.kind !== 'file') return ERRNO.INVAL;
        const base = whence === 0 ? 0 : whence === 1 ? entry.position : entry.data.length;
        const position = base + Number(offset);
        if (position < 0) return ERRNO.INVAL;
        entry.position = position;
        wasi.view().setBigUint64(pointer, BigInt(position), true);
        return ERRNO.SUCCESS;
      },
      fd_tell(fd, pointer) {
        const entry = wasi.fds.get(fd);
        if (!entry || entry.kind !== 'file') return ERRNO.BADF;
        wasi.view().setBigUint64(pointer, BigInt(entry.position), true);
        return ERRNO.SUCCESS;
      },
      fd_read(fd, pointer, count, done) {
        const entry = wasi.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        if (entry.kind === 'dir') return ERRNO.ISDIR;
        let total = 0;
        if (entry.kind === 'file') {
          total = iovs(pointer, count, (base, length) => {
            const chunk = entry.data.subarray(entry.position, entry.position + length);
            wasi.bytes().set(chunk, base);
            entry.position += chunk.length;
            return chunk.length;
          });
        }
        wasi.view().setUint32(done, total, true);
        return ERRNO.SUCCESS;
      },
      fd_pread() { return ERRNO.NOSYS; },
      fd_write(fd, pointer, count, done) {
        const entry = wasi.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        if (entry.kind !== 'stdout') return ERRNO.ROFS;
        const total = iovs(pointer, count, (base, length) => {
          entry.text += utf8Decode(wasi.bytes().subarray(base, base + length));
          let newline;
          while ((newline = entry.text.indexOf('\n')) >= 0) {
            wasi.log(fd, entry.text.slice(0, newline));
            entry.text = entry.text.slice(newline + 1);
          }
          return length;
        });
        wasi.view().setUint32(done, total, true);
        return ERRNO.SUCCESS;
      },
      fd_pwrite() { return ERRNO.ROFS; },
      fd_readdir(fd, pointer, length, cookie, used) {
        const entry = wasi.fds.get(fd);
        if (!entry || entry.kind !== 'dir') return ERRNO.BADF;
        const names = ['.', '..', ...(wasi.files.list?.(entry.path) ?? [])];
        const out = wasi.bytes(), v = wasi.view();
        let at = 0;
        for (let index = Number(cookie); index < names.length; ++index) {
          const name = utf8Encode(names[index]);
          const child = index < 2 ? {type: 'dir'} : wasi.stat(normalize(entry.path + '/' + names[index])) ?? {type: 'file'};
          const header = new DataView(new ArrayBuffer(24));
          header.setBigUint64(0, BigInt(index + 1), true);
          header.setBigUint64(8, BigInt(index + 1), true);
          header.setUint32(16, name.length, true);
          header.setUint8(20, child.type === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
          const record = new Uint8Array(24 + name.length);
          record.set(new Uint8Array(header.buffer), 0);
          record.set(name, 24);
          const room = length - at;
          out.set(record.subarray(0, Math.min(room, record.length)), pointer + at);
          at += Math.min(room, record.length);
          if (room <= record.length) break;
        }
        v.setUint32(used, at, true);
        return ERRNO.SUCCESS;
      },
      fd_renumber() { return ERRNO.NOSYS; },
      path_open(fd, dirflags, pointer, length, oflags, rightsBase, rightsInheriting, fdflags, result) {
        const path = wasi.resolve(fd, pointer, length);
        if (!path) return ERRNO.BADF;
        if (oflags & (OFLAGS.CREAT | OFLAGS.TRUNC) || rightsBase & 64n) {
          // Writes, creation and truncation: the bundle is read-only.
          if (!wasi.stat(path) || oflags & (OFLAGS.CREAT | OFLAGS.TRUNC)) return ERRNO.ROFS;
          if (rightsBase & 64n) return ERRNO.ROFS;
        }
        const stat = wasi.stat(path);
        if (!stat) return ERRNO.NOENT;
        if (oflags & OFLAGS.DIRECTORY && stat.type !== 'dir') return ERRNO.NOTDIR;
        let entry;
        if (stat.type === 'dir') entry = {kind: 'dir', path};
        else {
          const data = wasi.files.read(path);
          if (!data) return ERRNO.NOENT;
          entry = {kind: 'file', path, data, position: 0};
        }
        const opened = wasi.nextFd++;
        wasi.fds.set(opened, entry);
        wasi.view().setUint32(result, opened, true);
        return ERRNO.SUCCESS;
      },
      path_filestat_get(fd, flags, pointer, length, result) {
        const path = wasi.resolve(fd, pointer, length);
        if (!path) return ERRNO.BADF;
        const stat = wasi.stat(path);
        if (!stat) return ERRNO.NOENT;
        wasi.writeFilestat(result, stat);
        return ERRNO.SUCCESS;
      },
      path_filestat_set_times() { return ERRNO.ROFS; },
      path_readlink() { return ERRNO.INVAL; },
      path_create_directory() { return ERRNO.ROFS; },
      path_remove_directory() { return ERRNO.ROFS; },
      path_unlink_file() { return ERRNO.ROFS; },
      path_rename() { return ERRNO.ROFS; },
      path_link() { return ERRNO.ROFS; },
      path_symlink() { return ERRNO.ROFS; },
      sock_accept() { return ERRNO.NOSYS; },
      sock_recv() { return ERRNO.NOSYS; },
      sock_send() { return ERRNO.NOSYS; },
      sock_shutdown() { return ERRNO.NOSYS; },
    };
  }
}

// A read-only directory of the local file system (Node).
export async function nodeFiles(root) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const real = p => path.join(root, p);
  return {
    stat(p) {
      try {
        const s = fs.statSync(real(p));
        return {type: s.isDirectory() ? 'dir' : 'file', size: s.size};
      } catch { return null; }
    },
    read(p) {
      try { return new Uint8Array(fs.readFileSync(real(p))); } catch { return null; }
    },
    list(p) {
      try { return fs.readdirSync(real(p)).sort(); } catch { return []; }
    },
  };
}

// A bundle served over HTTP, read with synchronous requests (dedicated workers).
export function httpFiles(base) {
  const cache = new Map();
  const get = p => {
    if (cache.has(p)) return cache.get(p);
    const request = new XMLHttpRequest();
    request.open('GET', base.replace(/\/$/, '') + p, false);
    request.responseType = 'arraybuffer';
    let data = null;
    try {
      request.send();
      if (request.status === 200) data = new Uint8Array(request.response);
    } catch { data = null; }
    cache.set(p, data);
    return data;
  };
  return {
    stat(p) { const data = get(p); return data ? {type: 'file', size: data.length} : null; },
    read: get,
    list() { return []; },
  };
}
