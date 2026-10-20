// SPDX-License-Identifier: GPL-3.0-or-later
// A small WASI preview1 implementation for hosting WCLAP modules in Node, workers
// and AudioWorklets. The file system is a read-only preopened directory ("/", the
// bundle) served by a synchronous backend: { stat(path), read(path), list(path) },
// and optionally a writable one ("/user", the plug-in's private folder) whose
// backend also has write(path, bytes), mkdir(path), unlink(path), rmdir(path) and
// rename(from, to) (memoryFiles() keeps one in memory).
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
  constructor({files, user, seed, random, log = (stream, text) => console[stream === 2 ? 'error' : 'log'](text), now} = {}) {
    this.files = files;
    this.user = user ?? null;
    this.random = random ?? (seed === undefined ? null : seededBytes(seed));
    this.log = log;
    this.now = now ?? (() => (globalThis.performance?.now?.() ?? Date.now()));
    this.memory = null;
    this.fds = new Map([[0, {kind: 'stdin'}], [1, {kind: 'stdout', text: ''}], [2, {kind: 'stdout', text: ''}],
      [3, {kind: 'dir', path: '/', preopen: '/'}]]);
    if (this.user) this.fds.set(4, {kind: 'dir', path: '/user', preopen: '/user'});
    this.nextFd = this.user ? 5 : 4;
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
  // The backend holding an absolute path and the path within it.
  backend(path) {
    if (this.user && (path === '/user' || path.startsWith('/user/')))
      return {store: this.user, path: path.slice(5) || '/', writable: true};
    return {store: this.files, path, writable: false};
  }
  stat(path) {
    if (path === '/' || (this.user && path === '/user')) return {type: 'dir', size: 0};
    const {store, path: inner} = this.backend(path);
    return store.stat(inner);
  }
  writeFilestat(pointer, stat, ino = 0) {
    const v = this.view();
    for (let i = 0; i < 64; i += 8) v.setBigUint64(pointer + i, 0n, true);
    v.setBigUint64(pointer + 8, BigInt(ino), true);
    v.setUint8(pointer + 16, stat.type === 'dir' ? FILETYPE.DIRECTORY : stat.type === 'char' ? FILETYPE.CHARACTER_DEVICE : FILETYPE.REGULAR_FILE);
    v.setBigUint64(pointer + 24, 1n, true);
    v.setBigUint64(pointer + 32, BigInt(stat.size ?? 0), true);
    const ns = BigInt(Math.round((stat.mtime ?? 0) * 1e6));
    for (const offset of [40, 48, 56]) v.setBigUint64(pointer + offset, ns, true);
  }
  // A written file reaches its backend when it is closed or synced.
  flush(entry) {
    if (entry?.kind === 'file' && entry.dirty) {
      this.backend(entry.path).store.write(this.backend(entry.path).path, entry.data.slice(0, entry.length));
      entry.dirty = false;
    }
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
        wasi.writeFilestat(pointer, entry.kind === 'file' ? {type: 'file', size: entry.length ?? entry.data.length, mtime: entry.mtime}
          : entry.kind === 'dir' ? {type: 'dir'} : {type: 'char'}, fd);
        return ERRNO.SUCCESS;
      },
      fd_filestat_set_size(fd, size) {
        const entry = wasi.fds.get(fd);
        if (!entry || entry.kind !== 'file') return ERRNO.BADF;
        if (!entry.writable) return ERRNO.ROFS;
        entry.length = Number(size);
        if (entry.data.length < entry.length) { const grown = new Uint8Array(entry.length); grown.set(entry.data); entry.data = grown; }
        entry.dirty = true;
        return ERRNO.SUCCESS;
      },
      fd_filestat_set_times() { return ERRNO.ROFS; },
      fd_advise() { return ERRNO.SUCCESS; },
      fd_allocate() { return ERRNO.ROFS; },
      fd_datasync(fd) { wasi.flush(wasi.fds.get(fd)); return ERRNO.SUCCESS; },
      fd_sync(fd) { wasi.flush(wasi.fds.get(fd)); return ERRNO.SUCCESS; },
      fd_close(fd) {
        if (!wasi.fds.has(fd) || fd < 3 || wasi.fds.get(fd).preopen) return ERRNO.BADF;
        wasi.flush(wasi.fds.get(fd));
        wasi.fds.delete(fd);
        return ERRNO.SUCCESS;
      },
      fd_seek(fd, offset, whence, pointer) {
        const entry = wasi.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        if (entry.kind !== 'file') return ERRNO.INVAL;
        const base = whence === 0 ? 0 : whence === 1 ? entry.position : (entry.length ?? entry.data.length);
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
          const end = entry.length ?? entry.data.length;
          total = iovs(pointer, count, (base, length) => {
            const chunk = entry.data.subarray(entry.position, Math.min(end, entry.position + length));
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
        if (entry.kind === 'file') {
          if (!entry.writable) return ERRNO.ROFS;
          const written = iovs(pointer, count, (base, length) => {
            const at = entry.append ? entry.length : entry.position;
            if (entry.data.length < at + length) {
              const grown = new Uint8Array(Math.max(at + length, entry.data.length * 2, 4096));
              grown.set(entry.data.subarray(0, entry.length));
              entry.data = grown;
            }
            entry.data.set(wasi.bytes().subarray(base, base + length), at);
            entry.position = at + length;
            entry.length = Math.max(entry.length, at + length);
            entry.dirty = true;
            return length;
          });
          wasi.view().setUint32(done, written, true);
          return ERRNO.SUCCESS;
        }
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
        const {store, path: inner} = wasi.backend(entry.path);
        const names = ['.', '..', ...(store.list?.(inner) ?? [])];
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
        const {store, path: inner, writable} = wasi.backend(path);
        const writes = (oflags & (OFLAGS.CREAT | OFLAGS.TRUNC)) || (rightsBase & 64n);
        // Writes, creation and truncation: only the user folder is writable.
        if (writes && !writable) return ERRNO.ROFS;
        let stat = wasi.stat(path);
        if (stat && oflags & OFLAGS.EXCL && oflags & OFLAGS.CREAT) return ERRNO.EXIST;
        if (!stat && !(oflags & OFLAGS.CREAT)) return ERRNO.NOENT;
        if (stat && oflags & OFLAGS.DIRECTORY && stat.type !== 'dir') return ERRNO.NOTDIR;
        let entry;
        if (stat?.type === 'dir') {
          if (writes) return ERRNO.ISDIR;
          entry = {kind: 'dir', path};
        } else {
          let data = stat && !(oflags & OFLAGS.TRUNC) ? store.read(inner) : new Uint8Array();
          if (!data) return ERRNO.NOENT;
          if (!stat) {
            const parent = inner.slice(0, inner.lastIndexOf('/')) || '/';
            if (store.stat(parent)?.type !== 'dir') return ERRNO.NOENT;
          }
          data = new Uint8Array(data);
          entry = {kind: 'file', path, data, length: data.length, position: 0, writable: !!writes,
            append: !!(fdflags & 1), dirty: writes && (!stat || !!(oflags & OFLAGS.TRUNC)), mtime: stat?.mtime};
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
      path_create_directory(fd, pointer, length) {
        const path = wasi.resolve(fd, pointer, length);
        if (!path) return ERRNO.BADF;
        const {store, path: inner, writable} = wasi.backend(path);
        if (!writable) return ERRNO.ROFS;
        if (wasi.stat(path)) return ERRNO.EXIST;
        return store.mkdir(inner) ? ERRNO.SUCCESS : ERRNO.NOENT;
      },
      path_remove_directory(fd, pointer, length) {
        const path = wasi.resolve(fd, pointer, length);
        if (!path) return ERRNO.BADF;
        const {store, path: inner, writable} = wasi.backend(path);
        if (!writable) return ERRNO.ROFS;
        const stat = wasi.stat(path);
        if (!stat) return ERRNO.NOENT;
        if (stat.type !== 'dir') return ERRNO.NOTDIR;
        return store.rmdir(inner) ? ERRNO.SUCCESS : 55; // ENOTEMPTY
      },
      path_unlink_file(fd, pointer, length) {
        const path = wasi.resolve(fd, pointer, length);
        if (!path) return ERRNO.BADF;
        const {store, path: inner, writable} = wasi.backend(path);
        if (!writable) return ERRNO.ROFS;
        const stat = wasi.stat(path);
        if (!stat) return ERRNO.NOENT;
        if (stat.type === 'dir') return ERRNO.ISDIR;
        store.unlink(inner);
        return ERRNO.SUCCESS;
      },
      path_rename(fd, pointer, length, newFd, newPointer, newLength) {
        const from = wasi.resolve(fd, pointer, length), to = wasi.resolve(newFd, newPointer, newLength);
        if (!from || !to) return ERRNO.BADF;
        const a = wasi.backend(from), b = wasi.backend(to);
        if (!a.writable || !b.writable) return ERRNO.ROFS;
        if (!wasi.stat(from)) return ERRNO.NOENT;
        return a.store.rename(a.path, b.path) ? ERRNO.SUCCESS : ERRNO.NOENT;
      },
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

// A writable folder in memory, for the "/user" preopen: path -> {type, data, mtime}.
export function memoryFiles(initial = {}) {
  const entries = new Map([['/', {type: 'dir', mtime: Date.now()}]]);
  const parentOf = p => p.slice(0, p.lastIndexOf('/')) || '/';
  const store = {
    entries,
    stat(p) { const e = entries.get(p); return e ? {type: e.type, size: e.data?.length ?? 0, mtime: e.mtime} : null; },
    read(p) { const e = entries.get(p); return e?.type === 'file' ? e.data : null; },
    list(p) {
      const prefix = p === '/' ? '/' : p + '/';
      return [...entries.keys()].filter(k => k !== p && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map(k => k.slice(prefix.length)).sort();
    },
    write(p, data) {
      if (entries.get(parentOf(p))?.type !== 'dir') return false;
      entries.set(p, {type: 'file', data: new Uint8Array(data), mtime: Date.now()});
      return true;
    },
    mkdir(p) {
      if (entries.get(parentOf(p))?.type !== 'dir' || entries.has(p)) return false;
      entries.set(p, {type: 'dir', mtime: Date.now()});
      return true;
    },
    unlink(p) { return entries.get(p)?.type === 'file' && entries.delete(p); },
    rmdir(p) { return entries.get(p)?.type === 'dir' && store.list(p).length === 0 && entries.delete(p); },
    rename(from, to) {
      const e = entries.get(from);
      if (!e || entries.get(parentOf(to))?.type !== 'dir') return false;
      if (e.type === 'dir') {
        for (const key of [...entries.keys()].filter(k => k.startsWith(from + '/'))) {
          entries.set(to + key.slice(from.length), entries.get(key));
          entries.delete(key);
        }
      }
      entries.delete(from);
      entries.set(to, {...e, mtime: Date.now()});
      return true;
    },
  };
  for (const [p, data] of Object.entries(initial)) {
    const parts = p.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; ++i) store.mkdir('/' + parts.slice(0, i).join('/'));
    store.write('/' + parts.join('/'), typeof data === 'string' ? utf8Encode(data) : data);
  }
  return store;
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
