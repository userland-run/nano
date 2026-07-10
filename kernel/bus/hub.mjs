// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/bus/hub.mjs — the Syscall Bus hub (spec §5): decodes requests,
// enforces capabilities at dispatch (P4), and routes to Kernel subsystems.
// Transport-neutral: the same dispatch() serves the local (in-thread) path,
// the async MessagePort plane (port-channel.mjs), and the sync SAB plane
// (sab-channel.mjs). Every opcode has identical request/response schemas on
// all transports.

import { ERRNO, KernelError } from "../errno.mjs";
import { OP, OP_NAMES } from "./opcodes.mjs";
import { checkCap } from "../caps/caps.mjs";

class SyscallBusHub {
  /** @param {import("../kernel.mjs").Kernel} kernel */
  constructor(kernel) {
    this.kernel = kernel;
    /** @type {Map<number, { pid: number, registryId: number }>} watchId → owner */
    this._watches = new Map();
    this._nextWatchId = 1;
    /** @type {Map<number, (ev: object, transfers?: any[]) => void>} pid → event sink */
    this._eventSinks = new Map();
    /** @type {Map<number, { pid: number, st: object }>} fetch streamId → owner+stream */
    this._netStreams = new Map();
    this._nextStreamId = 1;
    this._handlers = buildHandlers(this);
  }

  /** Attach the unsolicited-event sink for a process (async plane only). */
  setEventSink(pid, sink) {
    if (sink) this._eventSinks.set(pid, sink);
    else this._eventSinks.delete(pid);
  }

  sendEvent(pid, ev, transfers) {
    const sink = this._eventSinks.get(pid);
    if (sink) sink(ev, transfers);
  }

  /** Drop all state owned by an exited/disconnected process. */
  releaseProcess(pid) {
    this._eventSinks.delete(pid);
    for (const [watchId, w] of this._watches) {
      if (w.pid === pid) {
        this.kernel.vfs.watch.unwatch(w.registryId);
        this._watches.delete(watchId);
      }
    }
    for (const [streamId, e] of this._netStreams) {
      if (e.pid === pid) {
        this.kernel.fetchBridge.cancelStream(e.st);
        this._netStreams.delete(streamId);
      }
    }
    this.kernel.ports?.closeAllFor(pid);
  }

  /**
   * The single dispatch chokepoint (P4): capability check, then handler.
   * @param {import("../types.d.mts").Process} proc
   * @param {number} op numeric opcode
   * @param {any} args request per the opcode schema
   * @returns {any | Promise<any>} result object (never undefined)
   * @throws {KernelError}
   */
  dispatch(proc, op, args) {
    if (!proc || proc.state !== "running") {
      throw new KernelError(ERRNO.ESRCH, undefined, `pid not running`);
    }
    const handler = this._handlers.get(op);
    if (!handler) {
      throw new KernelError(ERRNO.ENOSYS, undefined, `${OP_NAMES[op] ?? op} not implemented`);
    }
    checkCap(op, args, proc.caps);
    return handler(proc, args ?? {});
  }
}

function buildHandlers(hub) {
  const vfs = () => hub.kernel.vfs;
  /** @type {Map<number, (proc: any, args: any) => any>} */
  const h = new Map();

  // --- fs.* ---
  h.set(OP["fs.open"], (p, a) => ({ fd: vfs().open(a.path, a.flags ?? 0, a.mode ?? 0o644) }));
  h.set(OP["fs.close"], (p, a) => (vfs().close(a.fd), {}));
  h.set(OP["fs.read"], (p, a) => {
    const buf = new Uint8Array(a.len);
    const bytes = vfs().read(a.fd, buf, 0, a.len, a.pos ?? 0);
    // Transfer just the filled prefix; the plane transfers the buffer.
    return { bytes, data: buf.buffer.slice(0, bytes) };
  });
  h.set(OP["fs.write"], (p, a) => ({
    bytes: vfs().write(a.fd, new Uint8Array(a.data), a.pos ?? 0),
  }));
  h.set(OP["fs.stat"], (p, a) => vfs().stat(a.path, true));
  h.set(OP["fs.lstat"], (p, a) => vfs().stat(a.path, false));
  h.set(OP["fs.readdir"], (p, a) => ({ names: vfs().readdir(a.path) }));
  h.set(OP["fs.mkdir"], (p, a) => (vfs().mkdir(a.path, a.mode ?? 0o755), {}));
  h.set(OP["fs.unlink"], (p, a) => (vfs().unlink(a.path, a.flags ?? 0), {}));
  h.set(OP["fs.rename"], (p, a) => (vfs().rename(a.path, a.path2), {}));
  h.set(OP["fs.link"], (p, a) => (vfs().link(a.path, a.path2), {}));
  h.set(OP["fs.symlink"], (p, a) => (vfs().symlink(a.target, a.path), {}));
  h.set(OP["fs.readlink"], (p, a) => ({ target: vfs().readlinkString(a.path) }));
  h.set(OP["fs.realpath"], (p, a) => ({ path: vfs().realpath(a.path) }));
  h.set(OP["fs.truncate"], (p, a) => (vfs().truncate(a.path, a.length ?? 0), {}));
  h.set(OP["fs.chmod"], (p, a) => (vfs().chmod(a.path, a.mode), {}));
  h.set(OP["fs.utimes"], (p, a) => (vfs().utimes(a.path, a.mtime), {}));
  h.set(OP["fs.access"], (p, a) => {
    vfs().stat(a.path, true); // throws ENOENT if absent
    return {};
  });
  h.set(OP["fs.watch"], (p, a) => {
    const watchId = hub._nextWatchId++;
    const registryId = vfs().watch.watch(a.path, (ev) => {
      hub.sendEvent(p.pid, { ev: "watch", watchId, path: ev.path, kind: ev.kind, filename: ev.filename });
    });
    hub._watches.set(watchId, { pid: p.pid, registryId });
    return { watchId };
  });
  h.set(OP["fs.unwatch"], (p, a) => {
    const w = hub._watches.get(a.watchId);
    if (!w || w.pid !== p.pid) throw new KernelError(ERRNO.EINVAL, undefined, "unknown watch");
    vfs().watch.unwatch(w.registryId);
    hub._watches.delete(a.watchId);
    return {};
  });

  // --- net.* (K6: listen registration + host-fetch; socket data flow is M1) ---
  h.set(OP["net.listen"], (p, a) => ({
    port: hub.kernel.ports.listen(p.pid, a.port ?? 0, a.acceptor ?? { kind: p.kind }),
  }));
  h.set(OP["net.close_listener"], (p, a) => (hub.kernel.ports.close(p.pid, a.port), {}));
  h.set(OP["net.fetch_open"], async (p, a) => {
    const st = await hub.kernel.fetchBridge.open(a);
    const streamId = hub._nextStreamId++;
    hub._netStreams.set(streamId, { pid: p.pid, st });
    return { streamId };
  });
  h.set(OP["net.fetch_read"], async (p, a) => {
    const e = hub._netStreams.get(a.streamId);
    if (!e || e.pid !== p.pid) throw new KernelError(ERRNO.EBADF, undefined, "unknown stream");
    const dest = new Uint8Array(Math.min(a.len ?? 65536, 1 << 20));
    for (;;) {
      const r = hub.kernel.fetchBridge.readFromStream(e.st, dest);
      if (r.copied > 0) return { bytes: r.copied, data: dest.buffer.slice(0, r.copied), eof: false };
      if (r.eof) {
        hub._netStreams.delete(a.streamId);
        return { bytes: 0, eof: true };
      }
      if (r.error) {
        hub._netStreams.delete(a.streamId);
        throw new KernelError(ERRNO.EIO, undefined, String(r.error?.message ?? r.error));
      }
      await hub.kernel.fetchBridge.parkStream(e.st);
    }
  });
  h.set(OP["net.fetch_abort"], (p, a) => {
    const e = hub._netStreams.get(a.streamId);
    if (e && e.pid === p.pid) {
      hub.kernel.fetchBridge.cancelStream(e.st);
      hub._netStreams.delete(a.streamId);
    }
    return {};
  });

  // --- proc.* (K4 subset; spawn/kill/pipes land in K7) ---
  h.set(OP["proc.list"], () => ({ procs: hub.kernel.proc.list() }));
  h.set(OP["proc.getcwd"], (p) => ({ cwd: p.cwd }));
  h.set(OP["proc.chdir"], (p, a) => {
    const st = vfs().stat(a.path, true);
    if (!st.isDir) throw new KernelError(ERRNO.ENOTDIR, undefined, a.path);
    p.cwd = a.path;
    return {};
  });
  h.set(OP["proc.exit"], (p, a) => {
    hub.kernel.proc.exit(p.pid, a.code ?? 0);
    hub.releaseProcess(p.pid);
    return {};
  });
  h.set(OP["proc.waitpid"], async (p, a) => hub.kernel.proc.waitpid(a.pid, p.pid));

  // --- env.* ---
  h.set(OP["env.get_all"], (p) => ({ env: { ...p.env } }));
  h.set(OP["env.get"], (p, a) => ({ value: p.env[a.key] ?? null }));
  h.set(OP["env.set"], (p, a) => {
    p.env[a.key] = a.value; // scoped to the process (spec §5.2)
    return {};
  });

  // --- sys.* ---
  h.set(OP["sys.clock"], () => ({ ms: Date.now() }));
  h.set(OP["sys.hrtime"], () => {
    const ms = (globalThis.performance ?? { now: () => Date.now() }).now();
    return { sec: Math.floor(ms / 1000), nsec: Math.round((ms % 1000) * 1e6) };
  });
  h.set(OP["sys.random"], (p, a) => {
    const len = Math.min(a.len ?? 32, 65536);
    const buf = new Uint8Array(len);
    globalThis.crypto.getRandomValues(buf);
    return { data: buf.buffer };
  });
  h.set(OP["sys.log"], (p, a) => {
    console.log(`[pid ${p.pid}]`, a.msg);
    return {};
  });
  h.set(OP["sys.caps_query"], (p) => ({
    caps: structuredClone(p.caps),
    protocol: hub.kernel.protocol,
  }));

  return h;
}

export { SyscallBusHub };
