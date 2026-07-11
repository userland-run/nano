// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/wasm/wasi-shim.mjs — a wasi_snapshot_preview1 shim (UL-SPEC/
// wasm-tier §4.2) implementing wasip1 syscalls against the Kernel over the
// Syscall Bus sync plane. Capabilities are STRUCTURAL via preopens (§5, P1/P2):
// the module receives preopened directory fds mapped from caps.fs.scopes and
// CANNOT express a path outside them — enforcement is by construction, not a
// checked ambient root.

const WASI_ESUCCESS = 0, WASI_EBADF = 8, WASI_EINVAL = 28, WASI_ENOENT = 44,
  WASI_ENOTDIR = 54, WASI_ENOTSUP = 58, WASI_EACCES = 2, WASI_EEXIST = 20, WASI_ENOTCAPABLE = 76;
const WASI_FILETYPE_DIRECTORY = 3, WASI_FILETYPE_REGULAR_FILE = 4, WASI_FILETYPE_SYMBOLIC_LINK = 7, WASI_FILETYPE_CHARACTER_DEVICE = 2;
const WASI_PREOPENTYPE_DIR = 0;
const WASI_RIGHTS_ALL = 0xffffffffffffffffn;
const WASI_RIGHTS_RO = 0x000000000600002fn; // read/seek/tell/filestat/readdir-ish

class WasiExit extends Error { constructor(code) { super("wasi exit"); this.code = code; } }

/**
 * @param {{ argv: string[], env: Record<string,string>, preopens: Array<{guestPath:string, hostPath:string, readonly:boolean}>,
 *           sync: (op:string,args?:object)=>object, getMemory: ()=>WebAssembly.Memory,
 *           onExit: (code:number)=>void }} ctx
 */
function createWasiShim(ctx) {
  const { argv, env, preopens, sync, getMemory, onExit } = ctx;
  const dec = new TextDecoder();
  const encoder = new TextEncoder();

  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);
  const readStr = (ptr, len) => dec.decode(bytes().subarray(ptr, ptr + len));

  // fd table: 0/1/2 stdio; 3.. preopens; higher = opened files/dirs.
  const fds = new Map();
  fds.set(0, { type: "stdin" });
  fds.set(1, { type: "stdout" });
  fds.set(2, { type: "stderr" });
  let nextFd = 3;
  const preopenFds = [];
  for (const po of preopens) {
    const fd = nextFd++;
    fds.set(fd, { type: "preopen", guestPath: po.guestPath, hostPath: po.hostPath, readonly: po.readonly });
    preopenFds.push(fd);
  }

  // Resolve a path RELATIVE to a preopen dir fd — the structural boundary.
  function resolveAt(dirFd, path) {
    const dir = fds.get(dirFd);
    if (!dir || (dir.type !== "preopen" && dir.type !== "dir")) return null;
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

  const fdWrite = (fd, iovsPtr, iovsLen, nwrittenPtr) => {
    const dv = view();
    let total = 0;
    const chunks = [];
    for (let i = 0; i < iovsLen; i++) {
      const p = dv.getUint32(iovsPtr + i * 8, true);
      const l = dv.getUint32(iovsPtr + i * 8 + 4, true);
      chunks.push(bytes().slice(p, p + l));
      total += l;
    }
    const buf = concat(chunks);
    const e = fds.get(fd);
    if (!e) return WASI_EBADF;
    if (e.type === "stdout" || e.type === "stderr") {
      sync("proc.stdio_write", { fd: e.type === "stdout" ? 1 : 2, data: buf.buffer.slice(0) });
    } else if (e.type === "file") {
      const n = sync("fs.write", { fd: e.kfd, data: buf.buffer.slice(0), pos: e.pos }).bytes;
      e.pos += n;
    } else return WASI_EBADF;
    dv.setUint32(nwrittenPtr, total, true);
    return WASI_ESUCCESS;
  };

  const fdRead = (fd, iovsPtr, iovsLen, nreadPtr) => {
    const dv = view();
    const e = fds.get(fd);
    if (!e) return WASI_EBADF;
    let totalRead = 0;
    for (let i = 0; i < iovsLen; i++) {
      const p = dv.getUint32(iovsPtr + i * 8, true);
      const l = dv.getUint32(iovsPtr + i * 8 + 4, true);
      let chunk;
      if (e.type === "stdin") {
        const r = sync("proc.stdio_read", { fd: 0, len: l });
        if (r.eof || r.bytes === 0) break;
        chunk = new Uint8Array(r.data);
      } else if (e.type === "file") {
        const r = sync("fs.read", { fd: e.kfd, len: l, pos: e.pos });
        if (r.bytes === 0) break;
        chunk = new Uint8Array(r.data);
        e.pos += r.bytes;
      } else return WASI_EBADF;
      bytes().set(chunk, p);
      totalRead += chunk.length;
      if (chunk.length < l) break;
    }
    dv.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  };

  const pathOpen = (dirFd, dirflags, pathPtr, pathLen, oflags, fsRightsBase, fsRightsInher, fdflags, openedFdPtr) => {
    const path = readStr(pathPtr, pathLen);
    const res = resolveAt(dirFd, path);
    if (!res) return WASI_EBADF;
    if (res.escape) return WASI_ENOTCAPABLE; // preopen escape — structural denial (W2)
    if (ctx.trace) ctx.trace(`path_open dirFd=${dirFd} path=${path} res=${JSON.stringify(res)}`);
    const O_CREAT = 0x40, O_TRUNC = 0x200, O_DIRECTORY = 0x10000;
    let flags = 0;
    const wantWrite = (BigInt(fsRightsBase) & 0x40n) !== 0n || (oflags & 0x1) !== 0; // FD_WRITE or O_CREAT-ish
    if (oflags & 0x1) flags |= O_CREAT;
    if (oflags & 0x8) flags |= O_TRUNC;
    if (oflags & 0x2) flags |= O_DIRECTORY;
    if (res.readonly && wantWrite) return WASI_EACCES;
    try {
      const st = tryStat(res.hostPath);
      if (st && st.isDir) {
        const fd = nextFd++;
        fds.set(fd, { type: "dir", hostPath: res.hostPath, readonly: res.readonly });
        view().setUint32(openedFdPtr, fd, true);
        return WASI_ESUCCESS;
      }
      const kfd = sync("fs.open", { path: res.hostPath, flags: flags | (wantWrite ? 1 : 0), mode: 0o644 }).fd;
      const fd = nextFd++;
      fds.set(fd, { type: "file", kfd, hostPath: res.hostPath, pos: 0, readonly: res.readonly });
      view().setUint32(openedFdPtr, fd, true);
      if (ctx.trace) ctx.trace(`path_open OK guestFd=${fd} kfd=${kfd}`);
      return WASI_ESUCCESS;
    } catch (err) {
      if (ctx.trace) ctx.trace(`path_open ERR ${err?.errno} ${err?.message}`);
      return err?.errno === 2 ? WASI_ENOENT : WASI_EINVAL;
    }
  };

  function tryStat(hostPath) {
    try { return sync("fs.stat", { path: hostPath }); } catch { return null; }
  }

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
      const ms = sync("sys.clock", {}).ms;
      view().setBigUint64(timePtr, BigInt(Math.round(ms * 1e6)), true);
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
    fd_close: (fd) => { const e = fds.get(fd); if (e?.type === "file") { try { sync("fs.close", { fd: e.kfd }); } catch {} } fds.delete(fd); return WASI_ESUCCESS; },
    fd_seek: (fd, offset, whence, newOffsetPtr) => {
      const e = fds.get(fd);
      if (!e || e.type !== "file") return WASI_EBADF;
      if (whence === 0) e.pos = Number(offset);
      else if (whence === 1) e.pos += Number(offset);
      else if (whence === 2) { const st = tryStat(e.hostPath); e.pos = (st?.size ?? 0) + Number(offset); }
      view().setBigUint64(newOffsetPtr, BigInt(e.pos), true);
      return WASI_ESUCCESS;
    },
    fd_fdstat_get: (fd, statPtr) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      const dv = view();
      let ft = WASI_FILETYPE_REGULAR_FILE;
      if (e.type === "stdin" || e.type === "stdout" || e.type === "stderr") ft = WASI_FILETYPE_CHARACTER_DEVICE;
      else if (e.type === "dir" || e.type === "preopen") ft = WASI_FILETYPE_DIRECTORY;
      dv.setUint8(statPtr, ft);
      dv.setUint16(statPtr + 2, 0, true); // fs_flags
      dv.setBigUint64(statPtr + 8, e.readonly ? WASI_RIGHTS_RO : WASI_RIGHTS_ALL, true);
      dv.setBigUint64(statPtr + 16, WASI_RIGHTS_ALL, true);
      return WASI_ESUCCESS;
    },
    fd_fdstat_set_flags: () => WASI_ESUCCESS,
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
      const res = resolveAt(dirFd, readStr(pathPtr, pathLen));
      if (!res) return WASI_EBADF;
      if (res.escape) return WASI_ENOTCAPABLE;
      const st = tryStat(res.hostPath);
      if (!st) return WASI_ENOENT;
      writeFilestat(view(), statPtr, st);
      return WASI_ESUCCESS;
    },
    fd_filestat_get: (fd, statPtr) => {
      const e = fds.get(fd);
      if (!e) return WASI_EBADF;
      const st = e.hostPath ? tryStat(e.hostPath) : { size: 0, mode: 0o100644, ino: 0, mtime: 0, isDir: false, isFile: true, isSymlink: false };
      if (!st) return WASI_ENOENT;
      writeFilestat(view(), statPtr, st);
      return WASI_ESUCCESS;
    },
    path_create_directory: (dirFd, pathPtr, pathLen) => {
      const res = resolveAt(dirFd, readStr(pathPtr, pathLen));
      if (!res) return WASI_EBADF; if (res.escape) return WASI_ENOTCAPABLE;
      if (res.readonly) return WASI_EACCES;
      try { sync("fs.mkdir", { path: res.hostPath, mode: 0o755 }); return WASI_ESUCCESS; } catch (e) { return e?.errno === 17 ? WASI_EEXIST : WASI_EINVAL; }
    },
    path_unlink_file: (dirFd, pathPtr, pathLen) => {
      const res = resolveAt(dirFd, readStr(pathPtr, pathLen));
      if (!res) return WASI_EBADF; if (res.escape) return WASI_ENOTCAPABLE;
      if (res.readonly) return WASI_EACCES;
      try { sync("fs.unlink", { path: res.hostPath }); return WASI_ESUCCESS; } catch { return WASI_ENOENT; }
    },
    fd_readdir: () => WASI_ENOTSUP, // W-2 refinement
    poll_oneoff: (subsPtr, eventsPtr, nsubs, neventsPtr) => { view().setUint32(neventsPtr, 0, true); return WASI_ESUCCESS; },
    sched_yield: () => WASI_ESUCCESS,
    proc_exit: (code) => { onExit(code); throw new WasiExit(code); },
    // wasip1 has no sockets (P3) — sock_* return ENOTSUP.
    sock_recv: () => WASI_ENOTSUP, sock_send: () => WASI_ENOTSUP, sock_shutdown: () => WASI_ENOTSUP,
    fd_fdstat_set_rights: () => WASI_ESUCCESS,
    fd_sync: () => WASI_ESUCCESS, fd_datasync: () => WASI_ESUCCESS, fd_advise: () => WASI_ESUCCESS,
    fd_allocate: () => WASI_ESUCCESS, fd_tell: (fd, ptr) => { const e = fds.get(fd); view().setBigUint64(ptr, BigInt(e?.pos ?? 0), true); return WASI_ESUCCESS; },
    fd_renumber: () => WASI_ESUCCESS,
    path_rename: () => WASI_ENOTSUP, path_symlink: () => WASI_ENOTSUP, path_link: () => WASI_ENOTSUP,
    path_readlink: () => WASI_ENOTSUP, path_remove_directory: () => WASI_ENOTSUP,
    path_filestat_set_times: () => WASI_ESUCCESS,
  };

  return { shim, WasiExit };
}

function writeFilestat(dv, ptr, st) {
  dv.setBigUint64(ptr, 0n, true); // dev
  dv.setBigUint64(ptr + 8, BigInt(st.ino ?? 0), true); // ino
  dv.setUint8(ptr + 16, st.isDir ? WASI_FILETYPE_DIRECTORY : st.isSymlink ? WASI_FILETYPE_SYMBOLIC_LINK : WASI_FILETYPE_REGULAR_FILE);
  dv.setBigUint64(ptr + 24, 1n, true); // nlink
  dv.setBigUint64(ptr + 32, BigInt(st.size ?? 0), true); // size
  const t = BigInt(Math.round((st.mtime ?? 0) * 1e9));
  dv.setBigUint64(ptr + 40, t, true); dv.setBigUint64(ptr + 48, t, true); dv.setBigUint64(ptr + 56, t, true);
}

function concat(chunks) {
  let len = 0; for (const c of chunks) len += c.length;
  const out = new Uint8Array(len); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export { createWasiShim, WasiExit };
