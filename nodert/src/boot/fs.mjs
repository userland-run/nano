// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/fs.mjs — a bus-backed `fs` module (M0). Covers the sync +
// promise + simple callback surface the M0 corpus and module resolution use.
// Upstream lib/fs.js runs verbatim in M1 (needs the full fs binding + streams).
// All I/O flows through the sync Syscall Bus plane. Divergence: DIV-FS-M0.

const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0x40, O_TRUNC = 0x200, O_APPEND = 0x400, O_EXCL = 0x80;

function makeFsModule({ sync, busAsync, Buffer, EventEmitter }) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // fs.watch over the Kernel watch events (async plane). Returns an FSWatcher
  // (EventEmitter) emitting ('rename'|'change', filename). Coalescing happens
  // in the Kernel WatchRegistry (spec §6.1).
  const Emitter = EventEmitter;
  function watch(path, options, listener) {
    if (typeof options === "function") { listener = options; options = {}; }
    const w = new (Emitter || Object)();
    if (!Emitter) { w._l = []; w.on = (ev, fn) => (w._l.push([ev, fn]), w); w.emit = (ev, ...a) => w._l.forEach(([e, fn]) => e === ev && fn(...a)); w.close = () => {}; }
    if (listener) w.on("change", listener);
    let watchId = null, unsub = null, closed = false;
    if (busAsync) {
      globalThis.__nodert_ref?.(); // an FSWatcher keeps the loop alive (§10.4)
      busAsync.call("fs.watch", { path: String(path) }).then((r) => { watchId = r.watchId; }).catch((e) => w.emit("error", e));
      unsub = busAsync.onEvent((msg) => {
        if (msg.ev === "watch") {
          if (watchId != null && msg.watchId !== watchId) return;
          w.emit("change", msg.kind, msg.filename);
        }
      });
    }
    w.close = () => { if (closed) return; closed = true; globalThis.__nodert_unref?.(); unsub?.(); if (watchId != null && busAsync) busAsync.call("fs.unwatch", { watchId }).catch(() => {}); };
    return w;
  }
  function watchFile(path, options, listener) {
    // Poll-based watchFile over stat (M2 lean). Returns a no-op stopper via unwatchFile.
    const cb = typeof options === "function" ? options : listener;
    let prev = null;
    const timer = globalThis.setInterval(() => {
      let cur; try { cur = statSync(path); } catch { cur = { mtimeMs: 0, size: 0 }; }
      if (prev && (prev.mtimeMs !== cur.mtimeMs || prev.size !== cur.size)) cb?.(cur, prev);
      prev = cur;
    }, (typeof options === "object" ? options.interval : 0) || 100);
    if (timer.unref) timer.unref();
    watchFile._timers = watchFile._timers || new Map();
    watchFile._timers.set(String(path), timer);
  }
  function unwatchFile(path) { const t = watchFile._timers?.get(String(path)); if (t) globalThis.clearInterval(t); }

  const flagToInt = (flag) => {
    if (typeof flag === "number") return flag;
    switch (flag) {
      case "r": return O_RDONLY;
      case "r+": return O_RDWR;
      case "w": return O_WRONLY | O_CREAT | O_TRUNC;
      case "wx": return O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
      case "w+": return O_RDWR | O_CREAT | O_TRUNC;
      case "a": return O_WRONLY | O_CREAT | O_APPEND;
      case "a+": return O_RDWR | O_CREAT | O_APPEND;
      default: return O_RDONLY;
    }
  };

  const makeStats = (o) => ({
    dev: 1, ino: o.ino, mode: o.mode, nlink: o.nlink, uid: 0, gid: 0, rdev: 0,
    size: o.size, blksize: 4096, blocks: Math.ceil(o.size / 512),
    atimeMs: o.mtime * 1000, mtimeMs: o.mtime * 1000, ctimeMs: o.mtime * 1000, birthtimeMs: o.mtime * 1000,
    atime: new Date(o.mtime * 1000), mtime: new Date(o.mtime * 1000), ctime: new Date(o.mtime * 1000), birthtime: new Date(o.mtime * 1000),
    isFile: () => o.isFile, isDirectory: () => o.isDir, isSymbolicLink: () => o.isSymlink,
    isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
  });

  const readFileSync = (path, options) => {
    const encoding = typeof options === "string" ? options : options?.encoding;
    const fd = sync("fs.open", { path: String(path), flags: O_RDONLY }).fd;
    try {
      const st = sync("fs.stat", { path: String(path) });
      const out = new Uint8Array(st.size);
      let pos = 0;
      while (pos < st.size) {
        const r = sync("fs.read", { fd, len: st.size - pos, pos });
        if (r.bytes === 0) break;
        out.set(new Uint8Array(r.data), pos);
        pos += r.bytes;
      }
      return encoding ? dec.decode(out) : Buffer.from(out.buffer);
    } finally { sync("fs.close", { fd }); }
  };

  const writeFileSync = (path, data, options) => {
    const flags = flagToInt(typeof options === "object" ? options?.flag : "w");
    const bytes = typeof data === "string" ? enc.encode(data) : (data instanceof Uint8Array ? data : new Uint8Array(data));
    const fd = sync("fs.open", { path: String(path), flags, mode: 0o644 }).fd;
    try {
      let pos = 0;
      while (pos < bytes.length) { const r = sync("fs.write", { fd, data: bytes.subarray(pos), pos }); pos += r.bytes; if (r.bytes === 0) break; }
    } finally { sync("fs.close", { fd }); }
  };

  const appendFileSync = (path, data, options) =>
    writeFileSync(path, data, { flag: "a", ...(typeof options === "object" ? options : {}) });

  const existsSync = (path) => { try { sync("fs.access", { path: String(path) }); return true; } catch { return false; } };
  const statSync = (path) => makeStats(sync("fs.stat", { path: String(path) }));
  const lstatSync = (path) => makeStats(sync("fs.lstat", { path: String(path) }));
  const mkdirSync = (path, options) => {
    const recursive = options?.recursive;
    const p = String(path);
    if (recursive) {
      const parts = p.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) { cur += "/" + part; try { sync("fs.mkdir", { path: cur, mode: options?.mode ?? 0o777 }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
      return p;
    }
    sync("fs.mkdir", { path: p, mode: options?.mode ?? 0o777 });
  };
  const rmdirSync = (path) => sync("fs.unlink", { path: String(path), flags: 0x200 });
  const unlinkSync = (path) => sync("fs.unlink", { path: String(path) });
  const rmSync = (path, options) => { try { const st = statSync(path); if (st.isDirectory()) { for (const e of readdirSync(path)) rmSync(String(path) + "/" + e, options); rmdirSync(path); } else unlinkSync(path); } catch (e) { if (!options?.force) throw e; } };
  const renameSync = (a, b) => sync("fs.rename", { path: String(a), path2: String(b) });
  const readdirSync = (path, options) => {
    const names = sync("fs.readdir", { path: String(path) }).names;
    if (options?.withFileTypes) return names.map((n) => ({ name: n, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }));
    return names;
  };
  const realpathSync = (path) => sync("fs.realpath", { path: String(path) }).path;
  const readlinkSync = (path) => sync("fs.readlink", { path: String(path) }).target;
  const symlinkSync = (target, path) => sync("fs.symlink", { target: String(target), path: String(path) });
  const linkSync = (a, b) => sync("fs.link", { path: String(a), path2: String(b) });
  const chmodSync = (path, mode) => sync("fs.chmod", { path: String(path), mode });
  const copyFileSync = (src, dest) => writeFileSync(dest, readFileSync(src));

  // --- fd-based sync ops (open/read/write/close/fstat/ftruncate/fsync) ---
  // Real tools (tsc, esbuild) write output through an fd, not writeFileSync.
  // Backed by the Kernel fs.* fd ops; the shim tracks the current offset per fd
  // (the bus ops take an explicit position) and the path for fstat.
  const openFds = new Map(); // fd -> { path, flags, pos } | net device
  let netDevSeq = 0x40000000;
  const openSync = (path, flags = "r", mode = 0o666) => {
    const p = String(path);
    // /dev/__net__ — the host-brokered outbound HTTP device (Tier 1). Write the
    // "METHOD url\nHeaders\n\nbody" wire form, then read the framed HTTP/1.1
    // response until EOF; routed to the Kernel fetch bridge (incl.
    // nanoinfer.internal → the LLM bridge). Lets the nano-net-proxy run
    // unchanged on nodert. NOT a VFS file — synthetic fd, no fs.open.
    if (p === "/dev/__net__") {
      const fd = ++netDevSeq;
      openFds.set(fd, { device: "net", reqChunks: [], streamId: null, eof: false });
      return fd;
    }
    const fl = typeof flags === "number" ? flags : flagToInt(flags);
    const fd = sync("fs.open", { path: p, flags: fl, mode }).fd;
    let pos = 0;
    if (fl & O_APPEND) { try { pos = sync("fs.stat", { path: p }).size ?? 0; } catch { pos = 0; } }
    openFds.set(fd, { path: p, flags: fl, pos });
    return fd;
  };
  const closeSync = (fd) => {
    const e = openFds.get(fd);
    if (e && e.device === "net") { if (e.streamId != null && !e.eof) { try { sync("net.fetch_abort", { streamId: e.streamId }); } catch {} } openFds.delete(fd); return; }
    sync("fs.close", { fd }); openFds.delete(fd);
  };
  const writeSync = (fd, data, a, b, c) => {
    const e = openFds.get(fd);
    if (e && e.device === "net") {
      const u8 = typeof data === "string" ? enc.encode(data) : (data instanceof Uint8Array ? data : new Uint8Array(data.buffer ?? data));
      e.reqChunks.push(u8.slice()); // copy — the caller may reuse the buffer
      return u8.length;
    }
    let bytes, position;
    if (typeof data === "string") {
      // writeSync(fd, string[, position[, encoding]])
      bytes = enc.encode(data);
      position = typeof a === "number" ? a : null;
    } else {
      // writeSync(fd, buffer[, offset[, length[, position]]])
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data.buffer ?? data);
      const offset = typeof a === "number" ? a : 0;
      const length = typeof b === "number" ? b : u8.length - offset;
      bytes = u8.subarray(offset, offset + length);
      position = typeof c === "number" ? c : null;
    }
    const pos = position != null ? position : (e ? e.pos : 0);
    let written = 0;
    while (written < bytes.length) { const r = sync("fs.write", { fd, data: bytes.subarray(written), pos: pos + written }); if (!r.bytes) break; written += r.bytes; }
    if (position == null && e) e.pos += written;
    return written;
  };
  const readSync = (fd, buffer, offset = 0, length, position = null) => {
    const e = openFds.get(fd);
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer ?? buffer);
    const len = typeof length === "number" ? length : u8.length - offset;
    if (e && e.device === "net") {
      if (e.eof) return 0;
      if (e.streamId == null) {
        // First read: hand the accumulated request to the fetch bridge (blocks
        // on the sync plane until the response head is ready, like the VM).
        let total = 0; for (const c of e.reqChunks) total += c.length;
        const req = new Uint8Array(total); let o = 0; for (const c of e.reqChunks) { req.set(c, o); o += c.length; }
        e.streamId = sync("net.fetch_open_raw", { data: req.buffer.slice(req.byteOffset, req.byteOffset + req.byteLength) }).streamId;
      }
      const r = sync("net.fetch_read", { streamId: e.streamId, len });
      if (r.eof || !r.bytes) { e.eof = true; return 0; }
      u8.set(new Uint8Array(r.data), offset);
      return r.bytes;
    }
    const pos = position != null ? position : (e ? e.pos : 0);
    const r = sync("fs.read", { fd, len, pos });
    if (r.bytes) u8.set(new Uint8Array(r.data), offset);
    if (position == null && e) e.pos += r.bytes;
    return r.bytes;
  };
  const fstatSync = (fd) => { const e = openFds.get(fd); return makeStats(sync("fs.stat", { path: e ? e.path : "/" })); };
  const ftruncateSync = (fd, len = 0) => { const e = openFds.get(fd); if (e) sync("fs.truncate", { path: e.path, length: len }); };
  const fsyncSync = () => {};
  const fdatasyncSync = () => {};

  // Callback forms delegate to the sync ops on nextTick (M0 — real async I/O
  // over the async plane is M1). Faithful enough for module resolution + tests.
  const cb = (fn) => (...args) => {
    const callback = args.pop();
    queueMicrotask(() => { try { const v = fn(...args); callback(null, v); } catch (e) { callback(e); } });
  };

  const promises = {
    readFile: async (p, o) => readFileSync(p, o),
    writeFile: async (p, d, o) => writeFileSync(p, d, o),
    appendFile: async (p, d, o) => appendFileSync(p, d, o),
    mkdir: async (p, o) => mkdirSync(p, o),
    rmdir: async (p) => rmdirSync(p),
    rm: async (p, o) => rmSync(p, o),
    unlink: async (p) => unlinkSync(p),
    rename: async (a, b) => renameSync(a, b),
    readdir: async (p, o) => readdirSync(p, o),
    stat: async (p) => statSync(p),
    lstat: async (p) => lstatSync(p),
    realpath: async (p) => realpathSync(p),
    readlink: async (p) => readlinkSync(p),
    symlink: async (t, p) => symlinkSync(t, p),
    link: async (a, b) => linkSync(a, b),
    chmod: async (p, m) => chmodSync(p, m),
    copyFile: async (s, d) => copyFileSync(s, d),
    access: async (p) => { sync("fs.access", { path: String(p) }); },
  };

  return {
    readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
    mkdirSync, rmdirSync, rmSync, unlinkSync, renameSync, readdirSync, realpathSync,
    readlinkSync, symlinkSync, linkSync, chmodSync, copyFileSync,
    openSync, closeSync, writeSync, readSync, fstatSync, ftruncateSync, fsyncSync, fdatasyncSync,
    open: cb(openSync), close: cb(closeSync), read: cb(readSync), write: cb(writeSync),
    fstat: cb(fstatSync), ftruncate: cb(ftruncateSync), fsync: cb(fsyncSync),
    readFile: cb(readFileSync), writeFile: cb(writeFileSync), appendFile: cb(appendFileSync),
    exists: (p, callback) => queueMicrotask(() => callback(existsSync(p))),
    stat: cb(statSync), lstat: cb(lstatSync), mkdir: cb(mkdirSync), rmdir: cb(rmdirSync),
    rm: cb(rmSync), unlink: cb(unlinkSync), rename: cb(renameSync), readdir: cb(readdirSync),
    realpath: cb(realpathSync), readlink: cb(readlinkSync), symlink: cb(symlinkSync),
    link: cb(linkSync), chmod: cb(chmodSync), copyFile: cb(copyFileSync),
    access: (p, mode, callback) => { const c = callback ?? mode; queueMicrotask(() => { try { sync("fs.access", { path: String(p) }); c(null); } catch (e) { c(e); } }); },
    watch, watchFile, unwatchFile,
    promises,
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL },
  };
}

export { makeFsModule };
