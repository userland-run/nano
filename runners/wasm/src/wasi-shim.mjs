// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/wasm/wasi-shim.mjs — a wasi_snapshot_preview1 shim (UL-SPEC/
// wasm-tier §4.2) implementing wasip1 syscalls against the Kernel over the
// Syscall Bus sync plane. Capabilities are STRUCTURAL via preopens (§5, P1/P2):
// the module receives preopened directory fds mapped from caps.fs.scopes and
// CANNOT express a path outside them — enforcement is by construction, not a
// checked ambient root. (The Kernel additionally checks caps.fs.scopes on every
// fs.* op at dispatch, P4.)
//
// Every wasi_snapshot_preview1 import is provided (sockets/proc_raise answer
// ENOTSUP/ENOSYS), so modules built by Go (GOOS=wasip1), wasi-libc (C/C++) and
// Rust std instantiate without a LinkError.

// WASI errno values (wasi_snapshot_preview1 `errno` enum).
const WASI_ESUCCESS = 0, WASI_E2BIG = 1, WASI_EACCES = 2, WASI_EAGAIN = 6, WASI_EBADF = 8, WASI_EEXIST = 20,
  WASI_EFBIG = 22, WASI_EINVAL = 28, WASI_EIO = 29, WASI_EISDIR = 31, WASI_ELOOP = 32, WASI_EMLINK = 34,
  WASI_ENAMETOOLONG = 37, WASI_ENOENT = 44, WASI_ENOMEM = 48, WASI_ENOSPC = 51, WASI_ENOSYS = 52,
  WASI_ENOTDIR = 54, WASI_ENOTEMPTY = 55, WASI_ENOTSUP = 58, WASI_EPERM = 63, WASI_ERANGE = 68,
  WASI_EROFS = 69, WASI_ESPIPE = 70, WASI_ETIMEDOUT = 73, WASI_EXDEV = 75, WASI_ENOTCAPABLE = 76;
const WASI_FILETYPE_CHARACTER_DEVICE = 2, WASI_FILETYPE_DIRECTORY = 3, WASI_FILETYPE_REGULAR_FILE = 4,
  WASI_FILETYPE_SYMBOLIC_LINK = 7;
const WASI_PREOPENTYPE_DIR = 0;
const WASI_RIGHTS_ALL = 0xffffffffffffffffn;
// read/seek/fdstat/tell/advise/readdir/filestat_get/path_open/… — no write-ish rights.
const WASI_RIGHTS_RO = 0x000000000600002fn | (1n << 13n) | (1n << 14n) | (1n << 18n) | (1n << 21n);
const RIGHT_FD_READ = 1n << 1n, RIGHT_FD_WRITE = 1n << 6n;
const OFLAG_CREAT = 1, OFLAG_DIRECTORY = 2, OFLAG_EXCL = 4, OFLAG_TRUNC = 8;
const FDFLAG_APPEND = 1;
const LOOKUP_SYMLINK_FOLLOW = 1;
const FSTFLAG_MTIM = 4, FSTFLAG_MTIM_NOW = 8;
const EVENTTYPE_CLOCK = 0, EVENTTYPE_FD_READ = 1, EVENTTYPE_FD_WRITE = 2;
const CLOCK_MONOTONIC = 1, SUBCLOCK_ABSTIME = 1;

// Linux open(2) flags the Kernel VFS speaks.
const L_O_WRONLY = 1, L_O_RDWR = 2, L_O_CREAT = 0x40, L_O_EXCL = 0x80, L_O_TRUNC = 0x200,
  L_O_APPEND = 0x400, L_O_DIRECTORY = 0x10000;
const AT_REMOVEDIR = 0x200;

// Linux errno (KernelError.errno) → WASI errno.
const LINUX_TO_WASI = {
  1: WASI_EPERM, 2: WASI_ENOENT, 5: WASI_EIO, 7: WASI_E2BIG, 9: WASI_EBADF, 11: WASI_EAGAIN,
  12: WASI_ENOMEM, 13: WASI_EACCES, 17: WASI_EEXIST, 18: WASI_EXDEV, 20: WASI_ENOTDIR, 21: WASI_EISDIR,
  22: WASI_EINVAL, 27: WASI_EFBIG, 28: WASI_ENOSPC, 29: WASI_ESPIPE, 30: WASI_EROFS, 31: WASI_EMLINK,
  34: WASI_ERANGE, 36: WASI_ENAMETOOLONG, 38: WASI_ENOSYS, 39: WASI_ENOTEMPTY, 40: WASI_ELOOP,
  95: WASI_ENOTSUP, 110: WASI_ETIMEDOUT,
};
const toWasiErrno = (err, fallback = WASI_EIO) => LINUX_TO_WASI[err?.errno] ?? fallback;

class WasiExit extends Error { constructor(code) { super("wasi exit"); this.code = code; } }

/** Lexically normalize an absolute path ("." dropped, ".." clamped at "/"). */
function normAbs(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return "/" + out.join("/");
}
const parentOf = (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };

/**
 * @param {{ argv: string[], env: Record<string,string>,
 *           preopens: Array<{guestPath:string, hostPath:string, readonly:boolean, rootFallback?:boolean}>,
 *           sync: (op:string,args?:object)=>object, getMemory: ()=>WebAssembly.Memory,
 *           onExit: (code:number)=>void, trace?: (msg:string)=>void }} ctx
 *
 * A preopen with `rootFallback` is the process CWD exposed as "." next to a
 * "/" preopen of the VFS root. wasi-libc (C, Rust std) maps BOTH "/" and "." to
 * the empty prefix and picks the most recently registered one ("." here), so an
 * absolute path reaches this fd with its leading "/" stripped and is
 * indistinguishable from a relative one. Resolution therefore prefers
 * cwd-relative and falls back to the root when only the root reading exists
 * (or can be created) — so `in.png`, `./in.png` and `/work/in.png` (cwd /work)
 * all reach /work/in.png, and `/etc/x` still reaches /etc/x. Go's wasip1
 * runtime joins paths with $PWD itself and always picks the "/" preopen.
 */
function createWasiShim(ctx) {
  const { argv, env, preopens, sync, getMemory, onExit } = ctx;
  const dec = new TextDecoder();
  const encoder = new TextEncoder();

  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);
  // `.slice()` (not `.subarray()`): a wasip1-threads module's memory is a
  // shared WebAssembly.Memory, and the browser's TextDecoder rejects views
  // backed by a SharedArrayBuffer (Node's is lenient).
  const readStr = (ptr, len) => dec.decode(bytes().slice(ptr, ptr + len));

  // fd table: 0/1/2 stdio; 3.. preopens; higher = opened files/dirs.
  const fds = new Map();
  fds.set(0, { type: "stdin" });
  fds.set(1, { type: "stdout" });
  fds.set(2, { type: "stderr" });
  let nextFd = 3;
  for (const po of preopens) {
    fds.set(nextFd++, { type: "preopen", guestPath: po.guestPath, hostPath: po.hostPath, readonly: po.readonly, rootFallback: !!po.rootFallback });
  }
  const allocFd = () => { while (fds.has(nextFd)) nextFd++; return nextFd++; };

  function tryStat(hostPath, follow = true) {
    try { return sync(follow ? "fs.stat" : "fs.lstat", { path: hostPath }); } catch { return null; }
  }

  // Resolve a path RELATIVE to a dir fd — the structural boundary.
  // → { hostPath, readonly } | { escape: true } | null (bad fd)
  function resolveAt(dirFd, path) {
    const dir = fds.get(dirFd);
    if (!dir || (dir.type !== "preopen" && dir.type !== "dir")) return null;
    if (dir.rootFallback) {
      // cwd-as-"." over a "/" root preopen: '..' may climb to "/" (still under
      // the root preopen + Kernel scope checks), never above it.
      const a = normAbs(dir.hostPath + "/" + path);
      const b = normAbs("/" + path);
      let pick = a;
      if (a !== b && !tryStat(a, false)) {
        if (tryStat(b, false)) pick = b;
        else if (!tryStat(parentOf(a)) && tryStat(parentOf(b))) pick = b;
      }
      return { hostPath: pick, readonly: dir.readonly };
    }
    const base = dir.hostPath.replace(/\/$/, "");
    // Normalize and reject escapes ('..' crossing the preopen root — P1/W2).
    const parts = [];
    for (const seg of path.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") { if (parts.length === 0) return { escape: true }; parts.pop(); continue; }
      parts.push(seg);
    }
    const full = base + (parts.length ? "/" + parts.join("/") : "");
    return { hostPath: full || "/", readonly: dir.readonly };
  }
  // Resolve + standard error mapping; returns a WASI errno (number) or the result.
  function resolvePath(dirFd, ptr, len) {
    const res = resolveAt(dirFd, readStr(ptr, len));
    if (!res) return WASI_EBADF;
    if (res.escape) return WASI_ENOTCAPABLE; // preopen escape — structural denial (W2)
    return res;
  }

  const gatherIovs = (iovsPtr, iovsLen) => {
    const dv = view();
    const chunks = [];
    for (let i = 0; i < iovsLen; i++) {
      const p = dv.getUint32(iovsPtr + i * 8, true);
      const l = dv.getUint32(iovsPtr + i * 8 + 4, true);
      chunks.push(bytes().slice(p, p + l));
    }
    return concat(chunks);
  };

  // Write `buf` to a file entry at `pos` (append → current EOF); returns bytes written.
  const fileWrite = (e, buf, pos) => {
    if (buf.length === 0) return 0;
    return sync("fs.write", { fd: e.kfd, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), pos }).bytes;
  };

  const fdWrite = (fd, iovsPtr, iovsLen, nwrittenPtr) => {
    const e = fds.get(fd);
    if (!e) return WASI_EBADF;
    const buf = gatherIovs(iovsPtr, iovsLen);
    let n = buf.length;
    try {
      if (e.type === "stdout" || e.type === "stderr") {
        if (buf.length) sync("proc.stdio_write", { fd: e.type === "stdout" ? 1 : 2, data: buf.buffer });
      } else if (e.type === "file") {
        if (e.readonly) return WASI_EBADF;
        const pos = e.append ? (tryStat(e.hostPath)?.size ?? e.pos) : e.pos;
        n = fileWrite(e, buf, pos);
        e.pos = pos + n;
      } else if (e.type === "stdin") return WASI_EBADF;
      else return WASI_EISDIR;
    } catch (err) { return toWasiErrno(err); }
    view().setUint32(nwrittenPtr, n, true);
    return WASI_ESUCCESS;
  };

  const fdPwrite = (fd, iovsPtr, iovsLen, offset, nwrittenPtr) => {
    const e = fds.get(fd);
    if (!e) return WASI_EBADF;
    if (e.type !== "file") return e.type === "dir" || e.type === "preopen" ? WASI_EISDIR : WASI_ESPIPE;
    if (e.readonly) return WASI_EBADF;
    try {
      const n = fileWrite(e, gatherIovs(iovsPtr, iovsLen), Number(offset));
      view().setUint32(nwrittenPtr, n, true);
      return WASI_ESUCCESS;
    } catch (err) { return toWasiErrno(err); }
  };

  const stdinRead = (len) => {
    // A blocking stdin read can outlast the sync plane's call timeout
    // (interactive input): retry on ETIMEDOUT instead of trapping.
    for (;;) {
      try { return sync("proc.stdio_read", { fd: 0, len }); }
      catch (err) { if (err?.errno !== 110) throw err; }
    }
  };

  // Scatter-read: fill iovecs from `readChunk(len, offsetSoFar)` until short.
  const scatterRead = (iovsPtr, iovsLen, readChunk) => {
    const dv = view();
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const p = dv.getUint32(iovsPtr + i * 8, true);
      const l = dv.getUint32(iovsPtr + i * 8 + 4, true);
      if (l === 0) continue;
      const chunk = readChunk(l, total);
      if (!chunk || chunk.length === 0) break;
      bytes().set(chunk, p);
      total += chunk.length;
      if (chunk.length < l) break;
    }
    return total;
  };

  const fdRead = (fd, iovsPtr, iovsLen, nreadPtr) => {
    const e = fds.get(fd);
    if (!e) return WASI_EBADF;
    let total;
    try {
      if (e.type === "stdin") {
        let done = false;
        total = scatterRead(iovsPtr, iovsLen, (l, soFar) => {
          if (done) return null;
          // Don't block for more once some bytes arrived (POSIX read semantics).
          const r = stdinRead(l);
          done = true;
          if (r.eof || !r.bytes) return null;
          return new Uint8Array(r.data);
        });
      } else if (e.type === "file") {
        total = scatterRead(iovsPtr, iovsLen, (l) => {
          const r = sync("fs.read", { fd: e.kfd, len: l, pos: e.pos });
          if (!r.bytes) return null;
          e.pos += r.bytes;
          return new Uint8Array(r.data);
        });
      } else if (e.type === "dir" || e.type === "preopen") return WASI_EISDIR;
      else return WASI_EBADF;
    } catch (err) { return toWasiErrno(err); }
    view().setUint32(nreadPtr, total, true);
    return WASI_ESUCCESS;
  };

  const fdPread = (fd, iovsPtr, iovsLen, offset, nreadPtr) => {
    const e = fds.get(fd);
    if (!e) return WASI_EBADF;
    if (e.type !== "file") return e.type === "dir" || e.type === "preopen" ? WASI_EISDIR : WASI_ESPIPE;
    let pos = Number(offset);
    try {
      const total = scatterRead(iovsPtr, iovsLen, (l) => {
        const r = sync("fs.read", { fd: e.kfd, len: l, pos });
        if (!r.bytes) return null;
        pos += r.bytes;
        return new Uint8Array(r.data);
      });
      view().setUint32(nreadPtr, total, true);
      return WASI_ESUCCESS;
    } catch (err) { return toWasiErrno(err); }
  };

  const pathOpen = (dirFd, dirflags, pathPtr, pathLen, oflags, fsRightsBase, fsRightsInher, fdflags, openedFdPtr) => {
    const res = resolvePath(dirFd, pathPtr, pathLen);
    if (typeof res === "number") return res;
    if (ctx.trace) ctx.trace(`path_open dirFd=${dirFd} res=${JSON.stringify(res)} oflags=${oflags} fdflags=${fdflags}`);
    const rights = BigInt(fsRightsBase);
    const wantWrite = (rights & RIGHT_FD_WRITE) !== 0n || (oflags & OFLAG_TRUNC) !== 0 || (fdflags & FDFLAG_APPEND) !== 0;
    const wantRead = (rights & RIGHT_FD_READ) !== 0n;
    if (res.readonly && (wantWrite || (oflags & OFLAG_CREAT))) return WASI_EACCES;
    const follow = (dirflags & LOOKUP_SYMLINK_FOLLOW) !== 0;
    try {
      const st = tryStat(res.hostPath, true);
      if (st && (oflags & OFLAG_CREAT) && (oflags & OFLAG_EXCL)) return WASI_EEXIST;
      if (!st && !follow) {
        // O_NOFOLLOW on a symlink: Linux returns ELOOP.
        const lst = tryStat(res.hostPath, false);
        if (lst?.isSymlink) return WASI_ELOOP;
      }
      if (st && st.isDir) {
        if (wantWrite) return WASI_EISDIR;
        const fd = allocFd();
        fds.set(fd, { type: "dir", hostPath: res.hostPath, readonly: res.readonly });
        view().setUint32(openedFdPtr, fd, true);
        return WASI_ESUCCESS;
      }
      if (oflags & OFLAG_DIRECTORY) return st ? WASI_ENOTDIR : WASI_ENOENT;
      let flags = wantWrite ? (wantRead ? L_O_RDWR : L_O_WRONLY) : 0;
      if (oflags & OFLAG_CREAT) flags |= L_O_CREAT;
      if (oflags & OFLAG_EXCL) flags |= L_O_EXCL;
      if (oflags & OFLAG_TRUNC) flags |= L_O_TRUNC;
      if (fdflags & FDFLAG_APPEND) flags |= L_O_APPEND;
      const kfd = sync("fs.open", { path: res.hostPath, flags, mode: 0o644 }).fd;
      const fd = allocFd();
      fds.set(fd, { type: "file", kfd, hostPath: res.hostPath, pos: 0, readonly: res.readonly || !wantWrite, append: (fdflags & FDFLAG_APPEND) !== 0 });
      view().setUint32(openedFdPtr, fd, true);
      if (ctx.trace) ctx.trace(`path_open OK guestFd=${fd} kfd=${kfd}`);
      return WASI_ESUCCESS;
    } catch (err) {
      if (ctx.trace) ctx.trace(`path_open ERR ${err?.errno} ${err?.message}`);
      return toWasiErrno(err, WASI_EINVAL);
    }
  };

  // Run a path-mutating Kernel op on a resolved, writable path.
  const mutatePath = (dirFd, pathPtr, pathLen, fn) => {
    const res = resolvePath(dirFd, pathPtr, pathLen);
    if (typeof res === "number") return res;
    if (res.readonly) return WASI_EACCES;
    try { fn(res.hostPath); return WASI_ESUCCESS; } catch (err) { return toWasiErrno(err); }
  };

  const setTimes = (hostPath, mtim, fstFlags) => {
    let sec = null;
    if (fstFlags & FSTFLAG_MTIM_NOW) sec = Math.floor(Date.now() / 1000);
    else if (fstFlags & FSTFLAG_MTIM) sec = Number(BigInt(mtim) / 1000000000n);
    if (sec !== null) sync("fs.utimes", { path: hostPath, mtime: sec });
  };

  // poll_oneoff: clock subscriptions sleep (Atomics.wait — we're in a worker);
  // fd subscriptions report ready immediately (reads then block/EOF as usual).
  let sleepCell = null;
  const pollOneoff = (inPtr, outPtr, nsubs, neventsPtr) => {
    if (nsubs === 0) return WASI_EINVAL;
    const dv = view();
    const events = [];
    let minTimeoutNs = null;
    const clocks = [];
    for (let i = 0; i < nsubs; i++) {
      const s = inPtr + i * 48;
      const userdata = dv.getBigUint64(s, true);
      const tag = dv.getUint8(s + 8);
      if (tag === EVENTTYPE_CLOCK) {
        const clockId = dv.getUint32(s + 16, true);
        let timeout = dv.getBigUint64(s + 24, true);
        const flags = dv.getUint16(s + 40, true);
        if (flags & SUBCLOCK_ABSTIME) {
          const now = clockNowNs(clockId);
          timeout = timeout > now ? timeout - now : 0n;
        }
        clocks.push({ userdata, timeout });
        if (minTimeoutNs === null || timeout < minTimeoutNs) minTimeoutNs = timeout;
      } else if (tag === EVENTTYPE_FD_READ || tag === EVENTTYPE_FD_WRITE) {
        const fd = dv.getUint32(s + 16, true);
        events.push({ userdata, type: tag, error: fds.has(fd) ? WASI_ESUCCESS : WASI_EBADF, nbytes: 1n });
      } else {
        events.push({ userdata, type: tag, error: WASI_EINVAL, nbytes: 0n });
      }
    }
    if (events.length === 0 && minTimeoutNs !== null) {
      const ms = Number(minTimeoutNs / 1000000n);
      if (ms > 0) {
        try {
          sleepCell ??= new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(sleepCell, 0, 0, ms);
        } catch { /* Atomics.wait unavailable: return without sleeping */ }
      }
      for (const c of clocks) if (c.timeout <= minTimeoutNs) events.push({ userdata: c.userdata, type: EVENTTYPE_CLOCK, error: WASI_ESUCCESS, nbytes: 0n });
    } else {
      for (const c of clocks) if (c.timeout === 0n) events.push({ userdata: c.userdata, type: EVENTTYPE_CLOCK, error: WASI_ESUCCESS, nbytes: 0n });
    }
    events.forEach((ev, i) => {
      const o = outPtr + i * 32;
      dv.setBigUint64(o, ev.userdata, true);
      dv.setUint16(o + 8, ev.error, true);
      dv.setUint8(o + 10, ev.type);
      dv.setBigUint64(o + 16, ev.nbytes, true);
      dv.setUint16(o + 24, 0, true);
    });
    dv.setUint32(neventsPtr, events.length, true);
    return WASI_ESUCCESS;
  };

  // Monotonic time is read locally (Go's runtime reads it constantly; a bus
  // round trip each time is needlessly slow); wall-clock time comes from the Kernel.
  const monoBase = typeof performance !== "undefined" ? performance.timeOrigin ?? Date.now() : Date.now();
  function clockNowNs(id) {
    if (id === CLOCK_MONOTONIC && typeof performance !== "undefined") {
      return BigInt(Math.round((monoBase + performance.now()) * 1e6));
    }
    const ms = sync("sys.clock", {}).ms;
    return BigInt(Math.round(ms * 1e6));
  }

  const isStdio = (e) => e.type === "stdin" || e.type === "stdout" || e.type === "stderr";

  const shim = {
    args_sizes_get: (argcPtr, argvBufSizePtr) => {
      const dv = view();
      dv.setUint32(argcPtr, argv.length, true);
      dv.setUint32(argvBufSizePtr, argv.reduce((n, a) => n + encoder.encode(a).length + 1, 0), true);
      return WASI_ESUCCESS;
    },
    args_get: (argvPtr, argvBufPtr) => {
      const dv = view(); const mem = bytes();
      let buf = argvBufPtr;
      for (let i = 0; i < argv.length; i++) {
        dv.setUint32(argvPtr + i * 4, buf, true);
        const b = encoder.encode(argv[i]); mem.set(b, buf); mem[buf + b.length] = 0; buf += b.length + 1;
      }
      return WASI_ESUCCESS;
    },
    environ_sizes_get: (countPtr, bufSizePtr) => {
      const dv = view();
      const entries = Object.entries(env);
      dv.setUint32(countPtr, entries.length, true);
      dv.setUint32(bufSizePtr, entries.reduce((n, [k, v]) => n + encoder.encode(`${k}=${v}`).length + 1, 0), true);
      return WASI_ESUCCESS;
    },
    environ_get: (environPtr, bufPtr) => {
      const dv = view(); const mem = bytes(); let buf = bufPtr; let i = 0;
      for (const [k, v] of Object.entries(env)) {
        dv.setUint32(environPtr + i * 4, buf, true);
        const b = encoder.encode(`${k}=${v}`); mem.set(b, buf); mem[buf + b.length] = 0; buf += b.length + 1; i++;
      }
      return WASI_ESUCCESS;
    },
    clock_time_get: (id, precision, timePtr) => {
      view().setBigUint64(timePtr, clockNowNs(id), true);
      return WASI_ESUCCESS;
    },
    clock_res_get: (id, resPtr) => { view().setBigUint64(resPtr, 1000n, true); return WASI_ESUCCESS; },
    random_get: (bufPtr, bufLen) => {
      const r = sync("sys.random", { len: bufLen });
      bytes().set(new Uint8Array(r.data), bufPtr);
      return WASI_ESUCCESS;
    },
    fd_write: fdWrite,
    fd_read: fdRead,
    fd_pwrite: fdPwrite,
    fd_pread: fdPread,
    fd_close: (fd) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      if (e.type === "file") { try { sync("fs.close", { fd: e.kfd }); } catch {} }
      fds.delete(fd);
      return WASI_ESUCCESS;
    },
    fd_seek: (fd, offset, whence, newOffsetPtr) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      if (e.type !== "file") return isStdio(e) ? WASI_ESPIPE : WASI_EISDIR;
      let pos;
      const off = Number(offset);
      if (whence === 0) pos = off;
      else if (whence === 1) pos = e.pos + off;
      else if (whence === 2) { const st = tryStat(e.hostPath); pos = (st?.size ?? 0) + off; }
      else return WASI_EINVAL;
      if (pos < 0) return WASI_EINVAL;
      e.pos = pos;
      view().setBigUint64(newOffsetPtr, BigInt(e.pos), true);
      return WASI_ESUCCESS;
    },
    fd_tell: (fd, ptr) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      if (e.type !== "file") return WASI_ESPIPE;
      view().setBigUint64(ptr, BigInt(e.pos), true);
      return WASI_ESUCCESS;
    },
    fd_fdstat_get: (fd, statPtr) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      const dv = view();
      let ft = WASI_FILETYPE_REGULAR_FILE;
      if (isStdio(e)) ft = WASI_FILETYPE_CHARACTER_DEVICE;
      else if (e.type === "dir" || e.type === "preopen") ft = WASI_FILETYPE_DIRECTORY;
      dv.setUint8(statPtr, ft);
      dv.setUint16(statPtr + 2, e.append ? FDFLAG_APPEND : 0, true); // fs_flags
      dv.setBigUint64(statPtr + 8, e.readonly ? WASI_RIGHTS_RO : WASI_RIGHTS_ALL, true);
      dv.setBigUint64(statPtr + 16, WASI_RIGHTS_ALL, true);
      return WASI_ESUCCESS;
    },
    fd_fdstat_set_flags: (fd, flags) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      if (e.type === "file") e.append = (flags & FDFLAG_APPEND) !== 0;
      return WASI_ESUCCESS;
    },
    fd_fdstat_set_rights: (fd) => (fds.has(fd) ? WASI_ESUCCESS : WASI_EBADF),
    fd_prestat_get: (fd, prestatPtr) => {
      const e = fds.get(fd);
      if (!e || e.type !== "preopen") return WASI_EBADF;
      const dv = view();
      dv.setUint8(prestatPtr, WASI_PREOPENTYPE_DIR);
      dv.setUint32(prestatPtr + 4, encoder.encode(e.guestPath).length, true);
      return WASI_ESUCCESS;
    },
    fd_prestat_dir_name: (fd, pathPtr, pathLen) => {
      const e = fds.get(fd);
      if (!e || e.type !== "preopen") return WASI_EBADF;
      bytes().set(encoder.encode(e.guestPath).subarray(0, pathLen), pathPtr);
      return WASI_ESUCCESS;
    },
    path_open: pathOpen,
    path_filestat_get: (dirFd, flags, pathPtr, pathLen, statPtr) => {
      const res = resolvePath(dirFd, pathPtr, pathLen);
      if (typeof res === "number") return res;
      const st = tryStat(res.hostPath, (flags & LOOKUP_SYMLINK_FOLLOW) !== 0);
      if (!st) return WASI_ENOENT;
      writeFilestat(view(), statPtr, st);
      return WASI_ESUCCESS;
    },
    fd_filestat_get: (fd, statPtr) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      if (isStdio(e)) {
        writeFilestat(view(), statPtr, { size: 0, ino: 0, mtime: 0, isDir: false, isSymlink: false }, WASI_FILETYPE_CHARACTER_DEVICE);
        return WASI_ESUCCESS;
      }
      const st = tryStat(e.hostPath);
      if (!st) return WASI_ENOENT;
      writeFilestat(view(), statPtr, st);
      return WASI_ESUCCESS;
    },
    fd_filestat_set_size: (fd, size) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      if (e.type !== "file") return isStdio(e) ? WASI_EINVAL : WASI_EISDIR;
      if (e.readonly) return WASI_EBADF;
      try { sync("fs.truncate", { path: e.hostPath, length: Number(size) }); return WASI_ESUCCESS; }
      catch (err) { return toWasiErrno(err); }
    },
    fd_filestat_set_times: (fd, atim, mtim, fstFlags) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      if (isStdio(e)) return WASI_ESUCCESS;
      if (e.readonly && e.type !== "file") return WASI_EACCES;
      try { setTimes(e.hostPath, mtim, fstFlags); return WASI_ESUCCESS; } catch (err) { return toWasiErrno(err); }
    },
    path_filestat_set_times: (dirFd, flags, pathPtr, pathLen, atim, mtim, fstFlags) =>
      mutatePath(dirFd, pathPtr, pathLen, (p) => setTimes(p, mtim, fstFlags)),
    path_create_directory: (dirFd, pathPtr, pathLen) =>
      mutatePath(dirFd, pathPtr, pathLen, (p) => sync("fs.mkdir", { path: p, mode: 0o755 })),
    path_unlink_file: (dirFd, pathPtr, pathLen) =>
      mutatePath(dirFd, pathPtr, pathLen, (p) => sync("fs.unlink", { path: p, flags: 0 })),
    path_remove_directory: (dirFd, pathPtr, pathLen) =>
      mutatePath(dirFd, pathPtr, pathLen, (p) => sync("fs.unlink", { path: p, flags: AT_REMOVEDIR })),
    path_rename: (oldFd, oldPtr, oldLen, newFd, newPtr, newLen) => {
      const a = resolvePath(oldFd, oldPtr, oldLen);
      if (typeof a === "number") return a;
      const b = resolvePath(newFd, newPtr, newLen);
      if (typeof b === "number") return b;
      if (a.readonly || b.readonly) return WASI_EACCES;
      try { sync("fs.rename", { path: a.hostPath, path2: b.hostPath }); return WASI_ESUCCESS; }
      catch (err) { return toWasiErrno(err); }
    },
    path_link: (oldFd, oldFlags, oldPtr, oldLen, newFd, newPtr, newLen) => {
      const a = resolvePath(oldFd, oldPtr, oldLen);
      if (typeof a === "number") return a;
      const b = resolvePath(newFd, newPtr, newLen);
      if (typeof b === "number") return b;
      if (b.readonly) return WASI_EACCES;
      try { sync("fs.link", { path: a.hostPath, path2: b.hostPath }); return WASI_ESUCCESS; }
      catch (err) { return toWasiErrno(err); }
    },
    path_symlink: (oldPtr, oldLen, dirFd, newPtr, newLen) => {
      const target = readStr(oldPtr, oldLen);
      return mutatePath(dirFd, newPtr, newLen, (p) => sync("fs.symlink", { target, path: p }));
    },
    path_readlink: (dirFd, pathPtr, pathLen, bufPtr, bufLen, bufusedPtr) => {
      const res = resolvePath(dirFd, pathPtr, pathLen);
      if (typeof res === "number") return res;
      try {
        const t = encoder.encode(sync("fs.readlink", { path: res.hostPath }).target);
        const n = Math.min(t.length, bufLen);
        bytes().set(t.subarray(0, n), bufPtr);
        view().setUint32(bufusedPtr, n, true);
        return WASI_ESUCCESS;
      } catch (err) { return toWasiErrno(err); }
    },
    // fd_readdir(fd, buf, buf_len, cookie:u64, bufused) — enumerate a directory
    // fd's entries as WASI dirents. The cookie is an index into a per-fd
    // snapshot (taken in ONE typed fs.readdir call, refreshed on cookie 0);
    // d_next carries the resume cookie, so a caller re-reads with a bigger
    // buffer until bufused < buf_len. "." and ".." are emitted first.
    fd_readdir: (fd, bufPtr, bufLen, cookie, bufusedPtr) => {
      const e = fds.get(fd);
      if (!e || (e.type !== "dir" && e.type !== "preopen")) return WASI_EBADF;
      if (!e._dirents || BigInt(cookie) === 0n) {
        e._dirents = [
          { name: ".", type: WASI_FILETYPE_DIRECTORY, ino: 0 },
          { name: "..", type: WASI_FILETYPE_DIRECTORY, ino: 0 },
        ];
        let r = null;
        try { r = sync("fs.readdir", { path: e.hostPath, types: true }); } catch { r = null; }
        if (r && Array.isArray(r.types)) {
          r.names.forEach((nm, i) => e._dirents.push({
            name: nm,
            type: r.types[i] === "d" ? WASI_FILETYPE_DIRECTORY : r.types[i] === "l" ? WASI_FILETYPE_SYMBOLIC_LINK : WASI_FILETYPE_REGULAR_FILE,
            ino: r.inos?.[i] ?? 0,
          }));
        } else if (r) {
          // Older Kernel without typed readdir: stat each entry.
          const base = e.hostPath === "/" ? "" : e.hostPath;
          for (const nm of r.names ?? []) {
            const st = tryStat(base + "/" + nm, false);
            e._dirents.push({ name: nm, type: st?.isDir ? WASI_FILETYPE_DIRECTORY : st?.isSymlink ? WASI_FILETYPE_SYMBOLIC_LINK : WASI_FILETYPE_REGULAR_FILE, ino: st?.ino ?? 0 });
          }
        }
      }
      const dv = view(), mem = bytes();
      const DIRENT = 24; // d_next(u64) d_ino(u64) d_namlen(u32) d_type(u8)+pad
      let offset = 0;
      for (let i = Number(cookie); i < e._dirents.length; i++) {
        if (offset + DIRENT > bufLen) { offset = bufLen; break; }
        const ent = e._dirents[i];
        const nameBytes = encoder.encode(ent.name);
        dv.setBigUint64(bufPtr + offset, BigInt(i + 1), true);
        dv.setBigUint64(bufPtr + offset + 8, BigInt(ent.ino), true);
        dv.setUint32(bufPtr + offset + 16, nameBytes.length, true);
        dv.setUint8(bufPtr + offset + 20, ent.type);
        offset += DIRENT;
        const copyLen = Math.min(nameBytes.length, bufLen - offset);
        mem.set(nameBytes.subarray(0, copyLen), bufPtr + offset);
        offset += copyLen;
        if (copyLen < nameBytes.length) { offset = bufLen; break; }
      }
      dv.setUint32(bufusedPtr, offset, true);
      return WASI_ESUCCESS;
    },
    fd_renumber: (from, to) => {
      const e = fds.get(from);
      if (!e || !fds.has(to)) return WASI_EBADF;
      if (from === to) return WASI_ESUCCESS;
      const old = fds.get(to);
      if (old.type === "file") { try { sync("fs.close", { fd: old.kfd }); } catch {} }
      fds.set(to, e);
      fds.delete(from);
      return WASI_ESUCCESS;
    },
    poll_oneoff: pollOneoff,
    sched_yield: () => WASI_ESUCCESS,
    proc_exit: (code) => { onExit(code); throw new WasiExit(code); },
    proc_raise: () => WASI_ENOSYS,
    // wasip1 has no sockets (P3) — sock_* return ENOTSUP.
    sock_accept: () => WASI_ENOTSUP, sock_recv: () => WASI_ENOTSUP, sock_send: () => WASI_ENOTSUP,
    sock_shutdown: () => WASI_ENOTSUP,
    fd_sync: (fd) => (fds.has(fd) ? WASI_ESUCCESS : WASI_EBADF),
    fd_datasync: (fd) => (fds.has(fd) ? WASI_ESUCCESS : WASI_EBADF),
    fd_advise: (fd) => (fds.has(fd) ? WASI_ESUCCESS : WASI_EBADF),
    fd_allocate: (fd, offset, len) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      if (e.type !== "file") return WASI_EBADF;
      const want = Number(offset) + Number(len);
      const st = tryStat(e.hostPath);
      if (st && st.size < want) { try { sync("fs.truncate", { path: e.hostPath, length: want }); } catch (err) { return toWasiErrno(err); } }
      return WASI_ESUCCESS;
    },
  };

  return { shim, WasiExit };
}

function writeFilestat(dv, ptr, st, filetype) {
  dv.setBigUint64(ptr, 0n, true); // dev
  dv.setBigUint64(ptr + 8, BigInt(st.ino ?? 0), true); // ino
  dv.setUint8(ptr + 16, filetype ?? (st.isDir ? WASI_FILETYPE_DIRECTORY : st.isSymlink ? WASI_FILETYPE_SYMBOLIC_LINK : WASI_FILETYPE_REGULAR_FILE));
  dv.setBigUint64(ptr + 24, BigInt(st.nlink ?? 1), true); // nlink
  dv.setBigUint64(ptr + 32, BigInt(st.size ?? 0), true); // size
  const t = BigInt(Math.round((st.mtime ?? 0) * 1e9));
  dv.setBigUint64(ptr + 40, t, true); dv.setBigUint64(ptr + 48, t, true); dv.setBigUint64(ptr + 56, t, true);
}

function concat(chunks) {
  if (chunks.length === 1) return chunks[0];
  let len = 0; for (const c of chunks) len += c.length;
  const out = new Uint8Array(len); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export { createWasiShim, WasiExit };
