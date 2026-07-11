// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/boot.mjs — the nodert boot orchestrator (spec §8.2). This is
// the nodert-owned "loader shim" (allowed below/around internalBinding, P2).
// It builds primordials from the vendored per_context scripts verbatim, wires
// the internalBinding registry, brings up process/Buffer/console/timers/fs,
// and runs the user program on the host engine over the Syscall Bus.
//
// M0 scope: process identity, Buffer, console, timers, fs (sync+promises),
// CJS require of upstream pure modules (path, punycode, querystring, events,
// string_decoder) + a bus-backed fs. Streams + upstream fs.js/console are M1.

import { ensureInit, sourceOf, hasModule, builtinIds } from "./lib-bundle.mjs";
import { createBindings } from "../bindings/index.mjs";
import { EventLoop } from "../uv/loop.mjs";
import { makeBuffer } from "./buffer.mjs";
import { makeConsole } from "./console.mjs";
import { makeFsModule } from "./fs.mjs";
import { makeCrypto } from "./crypto.mjs";
import { makeNet } from "./net.mjs";
import { makeHttp } from "./http.mjs";
import { createEsmLoader } from "../loader/esm.mjs";
import { makeWorkerThreads } from "./worker_threads.mjs";

// Upstream lib modules we run VERBATIM in M0 (pure or near-pure — their
// dependency closure is satisfied by the bindings + primordials).
const REAL_UPSTREAM = new Set([
  "path", "punycode", "querystring", "events", "string_decoder",
  "internal/util/types", "internal/errors",
]);

/**
 * @param {{ init: object, sync: (op: string, args?: object) => object,
 *           async: import("../../../kernel/bus/client.mjs").BusClient,
 *           fixtures: object }} ctx
 */
async function boot(ctx) {
  const { init, sync, async: busAsync, fixtures } = ctx;
  await ensureInit(init);

  // 1. primordials from per_context (verbatim, R2).
  const primordials = { __proto__: null };
  const privateSymbols = new Proxy({ __proto__: null }, {
    get(t, p) { if (typeof p !== "string") return undefined; if (!(p in t)) t[p] = Symbol(p); return t[p]; },
  });
  for (const id of ["internal/per_context/primordials", "internal/per_context/domexception", "internal/per_context/messageport"]) {
    const src = sourceOf(id);
    if (!src) continue;
    try { new Function("exports", "primordials", "privateSymbols", src)({}, primordials, privateSymbols); }
    catch { /* messageport/domexception may reference host globals — non-fatal in M0 */ }
  }

  // Web-platform globals Node exposes that the vendored lib relies on. The
  // per_context/domexception install is best-effort (§8.2); ensure the global
  // exists for internal/abort_controller etc.
  if (typeof globalThis.DOMException !== "function") {
    globalThis.DOMException = class DOMException extends Error {
      constructor(message = "", name = "Error") { super(message); this.name = name; this.code = 0; }
    };
  }

  // 2. host state feeding the process_methods/timers bindings + the loop.
  const loop = new EventLoop({ now: () => performance.now() });
  let exitCode = 0;
  let exited = false;
  const hostState = {
    pid: init.pid,
    tickInfo: new Uint8Array(2),
    immediateInfo: new Uint32Array(3),
    timeoutInfo: new Int32Array(1),
    uvNow: () => Math.floor(performance.now()),
    hrtimeBigInt: () => BigInt(Math.round(performance.now() * 1e6)),
    cwd: () => process.cwd(),
    chdir: (d) => { proc.cwd = d; try { sync("proc.chdir", { path: d }); } catch {} },
    env: () => proc.env,
    kill: () => 0,
    exit: (code) => doExit(code ?? 0),
    scheduleTimer: () => {}, toggleTimerRef: () => {}, toggleImmediateRef: () => {},
  };

  const internalBinding = createBindings({ fixtures, syncCall: sync, privateSymbols, hostState });

  // 3. CJS loader over the bundle (upstream) + nodert shims.
  const moduleCache = new Map();
  const shimCache = new Map();
  globalThis.__nodert_require = requireModule; // used by util.defineLazyProperties
  // Require a user CJS module by absolute path (ESM→CJS interop in the loader).
  globalThis.__nodert_require_path = (path) => compileUser(path);

  function requireModule(id, fromDir = "/") {
    const norm = id.replace(/^node:/, "");
    if (shimCache.has(norm)) return shimCache.get(norm);

    // nodert-provided modules (the M0 bring-up set).
    const shim = shimFactory(norm);
    if (shim) { const ex = shim(); shimCache.set(norm, ex); return ex; }

    // Relative / absolute / bare user modules resolve over the VFS.
    if (/^\.\.?\//.test(id) || id.startsWith("/") || (!hasModule(norm) && !isNodeBuiltinName(norm))) {
      const resolved = resolveUserModule(id, fromDir);
      if (resolved) return compileUser(resolved);
    }

    if (moduleCache.has(norm)) return moduleCache.get(norm).exports;
    // upstream lib modules run verbatim (builtins + internals).
    if (hasModule(norm)) return compileUpstream(norm);
    throw makeError("MODULE_NOT_FOUND", `Cannot find module '${id}'`);
  }

  function isNodeBuiltinName(n) {
    return ["fs", "path", "os", "util", "events", "stream", "crypto", "net", "http", "https", "url", "querystring", "punycode", "string_decoder", "assert", "buffer", "zlib", "child_process", "process", "worker_threads", "sqlite"].includes(n);
  }

  // Resolve a user module path over the VFS (relative, absolute, or a
  // node_modules walk for bare specifiers). Returns a realpath or null.
  function resolveUserModule(id, fromDir) {
    const exists = (p) => { try { sync("fs.access", { path: p }); return true; } catch { return false; } };
    const isDir = (p) => { try { return sync("fs.stat", { path: p }).isDir; } catch { return false; } };
    const tryFile = (p) => {
      for (const e of ["", ".js", ".cjs", ".mjs", ".json", ".ts"]) if (exists(p + e) && !isDir(p + e)) return p + e;
      if (isDir(p)) {
        if (exists(p + "/package.json")) {
          try { const main = JSON.parse(sync_readFile(p + "/package.json")).main ?? "index.js"; const m = tryFile(joinPath(p, main)); if (m) return m; } catch {}
        }
        for (const idx of ["/index.js", "/index.cjs", "/index.json"]) if (exists(p + idx)) return p + idx;
      }
      return null;
    };
    if (id.startsWith("/")) return tryFile(id);
    if (/^\.\.?\//.test(id)) return tryFile(joinPath(fromDir, id));
    // bare: walk node_modules upward
    let dir = fromDir;
    for (;;) {
      const hit = tryFile(joinPath(dir, "node_modules/" + id));
      if (hit) return hit;
      if (dir === "/" || dir === "") break;
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    }
    return null;
  }

  function compileUser(path) {
    if (moduleCache.has(path)) return moduleCache.get(path).exports;
    const raw = sync_readFile(path);
    if (path.endsWith(".json")) { const ex = JSON.parse(raw); moduleCache.set(path, { exports: ex, loaded: true }); return ex; }
    let src = stripShebang(raw);
    if (/\.ts$/.test(path)) { try { src = sync("svc.invoke", { service: "swc", method: "transform", payload: { code: src } }).result.code; } catch {} }
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const mod = { exports: {}, id: path, filename: path, loaded: false, paths: [] };
    moduleCache.set(path, mod);
    const req = (spec) => requireModule(spec, dir);
    req.resolve = (spec) => resolveUserModule(spec, dir) ?? spec;
    req.cache = {};
    const fn = new Function("exports", "require", "module", "__filename", "__dirname", "process", "Buffer", "console",
      `${src}\n//# sourceURL=${path}`);
    fn.call(mod.exports, mod.exports, req, mod, path, dir, process, Buffer, consoleObj);
    mod.loaded = true;
    return mod.exports;
  }

  function joinPath(a, b) {
    if (b.startsWith("/")) b = b.slice(1), a = "/";
    const parts = (a + "/" + b).split("/"); const out = [];
    for (const s of parts) { if (s === "" || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
    return "/" + out.join("/");
  }

  function compileUpstream(norm) {
    const src = sourceOf(norm);
    const mod = { exports: {}, id: norm, loaded: false };
    moduleCache.set(norm, mod);
    const fn = new Function(
      "exports", "require", "module", "process", "internalBinding", "primordials",
      `${src}\n//# sourceURL=node:${norm}`
    );
    fn.call(mod.exports, mod.exports, requireModule, mod, process, internalBinding, primordials);
    mod.loaded = true;
    return mod.exports;
  }

  // 4. Buffer + process (identity from fixtures/spec §8.3).
  const Buffer = makeBuffer(internalBinding);
  globalThis.Buffer = Buffer;

  const proc = makeProcess();
  globalThis.process = proc;

  // process.stdout/stderr as REAL upstream Writable streams (M1) backed by the
  // stdio pipes over the bus. Falls back to lean writers if `stream` can't load.
  let consoleObj;
  try {
    const { Writable } = requireModule("stream");
    proc.stdout = makeStdioStream(Writable, 1, init.stdio?.isTTY?.[1]);
    proc.stderr = makeStdioStream(Writable, 2, init.stdio?.isTTY?.[2]);
    proc.stdin = makeStdinStream(requireModule("stream").Readable, init.stdio?.isTTY?.[0]);
    consoleObj = makeUpstreamConsole(proc.stdout, proc.stderr);
  } catch {
    proc.stdout = makeStdioWriter(writeStdout, init.stdio?.isTTY?.[1]);
    proc.stderr = makeStdioWriter(writeStderr, init.stdio?.isTTY?.[2]);
    proc.stdin = { isTTY: !!init.stdio?.isTTY?.[0], read: () => null, on: () => proc.stdin, resume: () => {}, pause: () => {}, setEncoding: () => proc.stdin };
  }
  if (!consoleObj) consoleObj = makeConsole({ write: writeStdout, writeErr: writeStderr, Buffer });
  globalThis.console = consoleObj;

  // Timers wired to the loop.
  installTimers();

  // Loop-handle ref API for long-lived async readers (sockets, worker ports,
  // watchers) so they keep the process alive like a libuv handle (§10.4).
  globalThis.__nodert_ref = () => loop.refHandle();
  globalThis.__nodert_unref = () => loop.unrefHandle();

  // child_process.fork IPC child side: process.send / process.on('message').
  if (init.ipcRead != null && !init.isWorker) {
    let sendBuf = "";
    proc.send = (message) => {
      if (init.ipcWrite == null) return false;
      const line = JSON.stringify({ v: message }) + "\n";
      sync("proc.pipe_write", { pipeId: init.ipcWrite, data: new TextEncoder().encode(line).buffer });
      return true;
    };
    proc.connected = true;
    proc.disconnect = () => { proc.connected = false; if (init.ipcWrite != null) { try { sync("proc.pipe_close", { pipeId: init.ipcWrite }); } catch {} } };
    loop.refHandle();
    (async () => {
      try {
        for (;;) {
          const r = await busAsync.call("proc.pipe_read", { pipeId: init.ipcRead });
          if (r.eof) break;
          sendBuf += new TextDecoder().decode(new Uint8Array(r.data));
          let nl;
          while ((nl = sendBuf.indexOf("\n")) >= 0) { const line = sendBuf.slice(0, nl); sendBuf = sendBuf.slice(nl + 1); if (line) try { proc.emit("message", JSON.parse(line).v); } catch {} }
        }
      } catch {} finally { loop.unrefHandle(); proc.connected = false; proc.emit("disconnect"); }
    })();
  }

  // Exit-promise plumbing (declared before the run so a synchronous program
  // that exits during runMain still resolves).
  let resolveExit;
  const exitP = new Promise((r) => { resolveExit = r; });
  loop._onExit = (code) => { try { sync("proc.exit", { code }); } catch {} resolveExit(code); };

  // 4b. Initialize the upstream internal modules that the full bootstrap/node.js
  // normally sets up (we run a lean boot, so do the load-bearing ones here).
  initUpstreamInternals();

  // 5. run the entry program.
  loop.onUncaught = (e) => {
    writeStderr(formatUncaught(e));
    doExit(1);
  };
  if (typeof addEventListener === "function") {
    addEventListener?.("unhandledrejection", (ev) => { writeStderr(formatUncaught(ev.reason)); doExit(1); });
  }

  const entrySource = init.source ?? (init.entryPath ? sync_readFile(init.entryPath) : "");
  const entryPath = init.entryPath ?? "[eval]";
  if (isEsmEntry(entryPath, entrySource)) {
    // ESM entries run through the blob-URL loader (async); errors surface as
    // uncaught → exit 1. The loop still runs for any pending async work.
    runMainEsm(entrySource, entryPath).catch((e) => { writeStderr(formatUncaught(e)); doExit(1); });
    loop.start();
    return waitExit();
  }
  try {
    runMain(entrySource, entryPath);
  } catch (e) {
    writeStderr(formatUncaught(e));
    doExit(1);
    return waitExit();
  }
  // Drain the nextTick queue SYNCHRONOUSLY before yielding, so nextTicks
  // registered by the main script run before any promise microtask (Node's
  // nextTick > microtask priority, §10.1).
  loop._drainTicks();
  loop.start();
  return waitExit();

  // ---- helpers ----
  function isEsmEntry(path, source) {
    if (init.inputType === "module") return true;
    if (init.inputType === "commonjs") return false;
    if (/\.mjs$|\.mts$/.test(path)) return true;
    if (/\.cjs$/.test(path)) return false;
    // -e / .js / .ts: ESM if it uses top-level import/export syntax.
    return /(^|\n)\s*(import\s[\s\S]*?from\s|import\s*[{*'"]|export\s(default|const|let|var|function|class|\{|\*))/.test(source);
  }

  function esmLoaderHost() {
    return {
      cwd: proc.cwd(),
      readFile: (p) => sync_readFile(p),
      exists: (p) => { try { sync("fs.access", { path: p }); return true; } catch { return false; } },
      isDir: (p) => { try { return sync("fs.stat", { path: p }).isDir; } catch { return false; } },
      realpath: (p) => { try { return sync("fs.realpath", { path: p }).path; } catch { return p; } },
      mtime: (p) => { try { return sync("fs.stat", { path: p }).mtime; } catch { return 0; } },
      stripTypes: (code) => {
        try { return sync("svc.invoke", { service: "swc", method: "transform", payload: { code } }).result.code; }
        catch { return code; }
      },
    };
  }

  async function runMainEsm(source, filename) {
    // Make the CJS require reachable to ESM builtin facades.
    globalThis.__nodert_require = requireModule;
    const loader = createEsmLoader(esmLoaderHost());
    if (source != null && filename === "[eval]") {
      await loader.evalModule(source, "/[eval].mjs");
    } else if (init.source != null && init.entryPath == null) {
      await loader.evalModule(source, "/[eval].mjs");
    } else {
      await loader.run(filename);
    }
  }

  function initUpstreamInternals() {
    // debuglog: bootstrap/node.js calls initializeDebugEnv(NODE_DEBUG).
    try { requireModule("internal/util/debuglog").initializeDebugEnv(proc.env.NODE_DEBUG ?? ""); } catch {}
  }

  function computeArgv() {
    // Match Node's argv rules: `-e <code>` → ["node"] (the code is not in
    // argv); a script file → ["node", <path>, ...extraArgs].
    const a = init.argv ?? ["node"];
    const eIdx = a.indexOf("-e");
    if (init.source != null || eIdx >= 0) {
      // eval mode: keep only args AFTER the code (a[eIdx+2] onward).
      const rest = eIdx >= 0 ? a.slice(eIdx + 2) : [];
      return ["node", ...rest];
    }
    if (init.entryPath) return ["node", init.entryPath, ...a.slice(a.indexOf(init.entryPath) + 1 || a.length)];
    return ["node", ...a.slice(1)];
  }

  function makeProcess() {
    const emitter = {};
    const listeners = new Map();
    const p = {
      version: init.nodeLibVersion ?? "v25.4.0",
      versions: { node: (init.nodeLibVersion ?? "v25.4.0").slice(1), v8: "0.0", uv: "1.0", nodert: "0.0.1" },
      platform: "linux", // spec §8.3, DIV-001 (VM is riscv64)
      arch: "x64",
      argv: computeArgv(),
      argv0: "node",
      execArgv: [],
      execPath: "/usr/bin/node",
      pid: init.pid,
      ppid: 0,
      env: { ...init.env },
      cwd: init.cwd ?? "/",
      exitCode: undefined,
      _cwd: init.cwd ?? "/",
      cwd() { return p._cwd; },
      chdir(d) { p._cwd = d; hostState.chdir(d); },
      nextTick: (cb, ...a) => loop.nextTick(cb, ...a),
      hrtime: makeHrtime(),
      exit(code) { doExit(code ?? p.exitCode ?? 0); },
      on(ev, fn) { (listeners.get(ev) ?? listeners.set(ev, []).get(ev)).push(fn); return p; },
      once(ev, fn) { const w = (...a) => { p.off(ev, w); fn(...a); }; return p.on(ev, w); },
      off(ev, fn) { const l = listeners.get(ev); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return p; },
      removeListener(ev, fn) { return p.off(ev, fn); },
      emit(ev, ...a) { const l = listeners.get(ev); if (l) for (const fn of [...l]) fn(...a); return !!l?.length; },
      listeners: (ev) => [...(listeners.get(ev) ?? [])],
      _listeners: listeners,
      binding: (n) => internalBinding(n),
      _rawDebug: (...a) => writeStderr(a.join(" ") + "\n"),
      emitWarning: () => {},
      stdout: null, stderr: null, stdin: null,
      config: { target_defaults: {}, variables: {} },
      features: { inspector: false, cached_builtins: false },
      release: { name: "node" },
      allowedNodeEnvironmentFlags: new Set(),
      title: "node",
      moduleLoadList: [],
      report: { getReport: () => "{}" },
    };
    return p;
  }

  function makeHrtime() {
    const origin = performance.now();
    const hr = (prev) => {
      const nowNs = BigInt(Math.round((performance.now() - 0) * 1e6));
      const sec = nowNs / 1000000000n;
      const nsec = nowNs % 1000000000n;
      if (prev) {
        let s = sec - BigInt(prev[0]); let n = nsec - BigInt(prev[1]);
        if (n < 0n) { s -= 1n; n += 1000000000n; }
        return [Number(s), Number(n)];
      }
      return [Number(sec), Number(nsec)];
    };
    hr.bigint = () => BigInt(Math.round(performance.now() * 1e6));
    return hr;
  }

  function installTimers() {
    globalThis.setTimeout = (cb, ms, ...a) => wrapTimer(loop.setTimer(a.length ? () => cb(...a) : cb, ms || 0, false));
    globalThis.setInterval = (cb, ms, ...a) => wrapTimer(loop.setTimer(a.length ? () => cb(...a) : cb, ms || 0, true));
    globalThis.clearTimeout = (t) => t?.__timer && loop.clearTimer(t.__timer);
    globalThis.clearInterval = (t) => t?.__timer && loop.clearTimer(t.__timer);
    globalThis.setImmediate = (cb, ...a) => wrapImmediate(loop.setImmediate(a.length ? () => cb(...a) : cb));
    globalThis.clearImmediate = (t) => t?.__imm && loop.clearImmediate(t.__imm);
    globalThis.queueMicrotask = globalThis.queueMicrotask ?? ((cb) => Promise.resolve().then(cb));
  }
  function wrapTimer(timer) {
    const h = { __timer: timer, ref() { loop.refTimer(timer); return h; }, unref() { loop.unrefTimer(timer); return h; }, hasRef: () => timer.ref, refresh() { timer.due = loop.now() + timer.ms; return h; }, [Symbol.toPrimitive]: () => timer.__id ?? (timer.__id = ++wrapTimer._n) };
    return h;
  }
  wrapTimer._n = 0;
  function wrapImmediate(imm) {
    return { __imm: imm, ref() { return this; }, unref() { loop.clearImmediate; return this; }, hasRef: () => imm.ref };
  }

  function runMain(source, filename) {
    const mod = { exports: {}, id: ".", filename, loaded: false };
    const dirname = filename.includes("/") ? (filename.slice(0, filename.lastIndexOf("/")) || "/") : proc.cwd();
    const req = (spec) => requireModule(spec, dirname);
    req.resolve = (spec) => resolveUserModule(spec, dirname) ?? spec;
    req.cache = {};
    const fn = new Function(
      "exports", "require", "module", "__filename", "__dirname", "process", "Buffer", "console",
      `${stripShebang(source)}\n//# sourceURL=${filename}`
    );
    fn.call(mod.exports, mod.exports, req, mod, filename, dirname, proc, Buffer, consoleObj);
  }

  // A real upstream Writable whose _write pushes bytes to the Kernel stdio pipe.
  function makeStdioStream(Writable, fd, isTTY) {
    const enc = new TextEncoder();
    const s = new Writable({
      write(chunk, encoding, cb) {
        const bytes = typeof chunk === "string" ? enc.encode(chunk) : new Uint8Array(chunk.buffer ?? chunk, chunk.byteOffset ?? 0, chunk.byteLength ?? chunk.length);
        try { sync("proc.stdio_write", { fd, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); cb(); } catch (e) { cb(e); }
      },
      decodeStrings: false,
    });
    s.fd = fd;
    s.isTTY = !!isTTY;
    if (isTTY) { s.columns = 80; s.rows = 24; s.clearLine = () => true; s.cursorTo = () => true; s.moveCursor = () => true; }
    s._type = isTTY ? "tty" : "pipe";
    return s;
  }
  function makeStdinStream(Readable, isTTY) {
    const s = new Readable({ read() {} });
    s.isTTY = !!isTTY;
    s.fd = 0;
    s.setRawMode = () => s;
    // No stdin data source wired in M0/M1 headless — push EOF so reads end.
    queueMicrotask(() => s.push(null));
    return s;
  }
  function makeUpstreamConsole(stdout, stderr) {
    try {
      const { Console } = requireModule("console");
      return new Console({ stdout, stderr, colorMode: false });
    } catch {
      return makeConsole({ write: (s) => stdout.write(s), writeErr: (s) => stderr.write(s), Buffer });
    }
  }

  function makeStdioWriter(write, isTTY) {
    const w = {
      isTTY: !!isTTY,
      writable: true,
      write(chunk, encOrCb, cb) {
        const s = typeof chunk === "string" ? chunk : (globalThis.Buffer?.isBuffer?.(chunk) ? chunk.toString() : new TextDecoder().decode(chunk));
        write(s);
        const callback = typeof encOrCb === "function" ? encOrCb : cb;
        if (callback) queueMicrotask(callback);
        return true;
      },
      end(chunk) { if (chunk != null) w.write(chunk); return w; },
      on() { return w; }, once() { return w; }, emit() { return false; },
      cork() {}, uncork() {}, setDefaultEncoding() { return w; },
      columns: isTTY ? 80 : undefined, rows: isTTY ? 24 : undefined,
    };
    return w;
  }

  function writeStdout(str) {
    const bytes = new TextEncoder().encode(str);
    sync("proc.stdio_write", { fd: 1, data: bytes });
  }
  function writeStderr(str) {
    const bytes = new TextEncoder().encode(str);
    try { sync("proc.stdio_write", { fd: 2, data: bytes }); } catch {}
  }
  function sync_readFile(path) {
    const fd = sync("fs.open", { path, flags: 0 }).fd;
    try {
      const st = sync("fs.stat", { path });
      const r = sync("fs.read", { fd, len: st.size, pos: 0 });
      return new TextDecoder().decode(new Uint8Array(r.data));
    } finally { sync("fs.close", { fd }); }
  }

  function doExit(code) {
    if (exited) return;
    exited = true;
    exitCode = code | 0;
    try { proc.emit("exit", exitCode); } catch {}
    loop.stop(exitCode);
  }

  function waitExit() {
    return exitP;
  }

  function makeError(code, message) {
    const e = new Error(message); e.code = code; return e;
  }
  function formatUncaught(e) {
    if (e && e.stack) return `${e.stack}\n`;
    return `Uncaught ${String(e)}\n`;
  }

  // nodert-provided module shims (the M0 bring-up set). Hoisted function so
  // requireModule can reach it before the closure vars below are declared;
  // the factories only run at require-time, after everything is initialized.
  function shimFactory(norm) {
    switch (norm) {
      case "fs": return () => makeFsModule({ internalBinding, sync, busAsync, Buffer, EventEmitter: requireModule("events") });
      // fs/promises → the lean fs shim's promise API (avoids the upstream
      // internal/fs/watchers chain, which needs an fs_event_wrap binding).
      case "fs/promises": case "node:fs/promises": return () => requireModule("fs").promises;
      // timers/promises over the host timers (real apps: setTimeout awaits).
      case "timers/promises": case "node:timers/promises": return () => ({
        setTimeout: (ms, val) => new Promise((r) => globalThis.setTimeout(() => r(val), ms)),
        setImmediate: (val) => new Promise((r) => globalThis.setImmediate(() => r(val))),
        setInterval: async function* (ms, val) { while (true) { await new Promise((r) => globalThis.setTimeout(r, ms)); yield val; } },
      });
      case "os": return () => makeOs();
      case "buffer": return () => ({ Buffer, kMaxLength: 4294967296, kStringMaxLength: (1 << 29) - 24, constants: { MAX_LENGTH: 4294967296, MAX_STRING_LENGTH: (1 << 29) - 24 }, atob: (s) => globalThis.atob(s), btoa: (s) => globalThis.btoa(s), Blob: globalThis.Blob });
      // util: prefer upstream lib/util.js (inspect/format now run verbatim);
      // fall back to the lean shim if its dependency closure fails to load.
      case "util": return () => { try { return compileUpstream("util"); } catch { return makeUtil(); } };
      case "assert": return () => makeAssert();
      case "process": return () => proc;
      case "zlib": case "node:zlib": return () => makeZlib();
      case "node:sqlite": case "sqlite": return () => makeSqlite();
      case "child_process": case "node:child_process": return () => makeChildProcess();
      case "crypto": case "node:crypto": return () => makeCrypto(Buffer);
      case "net": case "node:net": return () => makeNet({ sync, busAsync, Buffer, EventEmitter: requireModule("events"), setImmediate: globalThis.setImmediate });
      case "http": case "node:http": return () => makeHttp({ net: requireModule("net"), EventEmitter: requireModule("events"), Buffer });
      case "worker_threads": case "node:worker_threads": return () => makeWorkerThreads({ sync, busAsync, Buffer, EventEmitter: requireModule("events"), init });
      // url: the upstream module needs the ada `url` binding (M2). The host
      // URL/URLSearchParams are WHATWG-standard and present in the worker, so
      // expose them plus the file-URL helpers. DIV-URL-M0.
      case "url": case "node:url": return () => ({
        URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
        fileURLToPath: (u) => { const s = String(u).replace(/^file:\/\//, ""); return decodeURIComponent(s) || "/"; },
        pathToFileURL: (p) => new globalThis.URL("file://" + (p.startsWith("/") ? p : "/" + p)),
        parse: (s) => { try { const u = new globalThis.URL(s); return { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, query: u.search.slice(1) }; } catch { return { href: s, pathname: s }; } },
        format: (u) => (u instanceof globalThis.URL ? u.href : String(u)),
        domainToASCII: (d) => d, domainToUnicode: (d) => d,
      });
      // The bootstrap spine is not a requirable module (it declares
      // internalBinding and would clash with the wrapper param). Upstream
      // modules require it only for BuiltinModule metadata — a minimal shim.
      case "internal/bootstrap/realm": return () => ({
        BuiltinModule: {
          map: new Map(),
          exists: (id) => hasModule(id),
          normalizeRequirableId: (id) => id.replace(/^node:/, ""),
          canBeRequiredByUsers: () => true,
          canBeRequiredWithoutScheme: () => true,
          getSchemeOnlyModuleNames: () => [],
        },
      });
      default: return null;
    }
  }

  // node:zlib mapped onto the zlib Kernel Service (spec §8.8). M0: the *Sync
  // methods over the bus; streaming variants land in M1.
  function makeZlib() {
    const call = (method, buf) => {
      const data = typeof buf === "string" ? new TextEncoder().encode(buf) : (buf instanceof Uint8Array ? buf : new Uint8Array(buf));
      // Binary at top-level `data` — the sync plane's transferable blob slot;
      // the binary result comes back in `data` too.
      const r = sync("svc.invoke", { service: "zlib", method, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
      return Buffer.from(r.data ?? r.result);
    };
    const mk = (m) => (buf) => call(m, buf);
    return {
      gzipSync: mk("gzip"), gunzipSync: mk("gunzip"),
      deflateSync: mk("deflate"), inflateSync: mk("inflate"),
      deflateRawSync: mk("deflateRaw"), inflateRawSync: mk("inflateRaw"),
      brotliCompressSync: mk("brotliCompress"), brotliDecompressSync: mk("brotliDecompress"),
      constants: {},
    };
  }

  // node:sqlite mapped onto the DuckDB Kernel Service + sqlite core extension.
  // Dialect/error differences are DIV-SQLITE-DUCKDB.
  function makeSqlite() {
    class DatabaseSync {
      constructor(path) { this._session = sync("svc.open_session", { service: "duckdb", config: { path: path ?? ":memory:" } }).sessionId; this._open = true; }
      exec(sql) { sync("svc.invoke", { service: "duckdb", sessionId: this._session, method: "exec", payload: { sql } }); }
      prepare(sql) {
        const session = this._session;
        return {
          all: (...params) => sync("svc.invoke", { service: "duckdb", sessionId: session, method: "query", payload: { sql, params } }).result.rows,
          get: (...params) => sync("svc.invoke", { service: "duckdb", sessionId: session, method: "query", payload: { sql, params } }).result.rows[0] ?? undefined,
          run: (...params) => { sync("svc.invoke", { service: "duckdb", sessionId: session, method: "exec", payload: { sql, params } }); return { changes: 0, lastInsertRowid: 0 }; },
        };
      }
      close() { if (this._open) { sync("svc.close_session", { sessionId: this._session }); this._open = false; } }
    }
    return { DatabaseSync };
  }

  // child_process over proc.spawn + Kernel pipes (spec §12). execSync/spawnSync
  // block the parent on the sync plane while the Kernel runs the child (§12.2);
  // spawn is async. Cross-tier: argv[0]==="node" routes to a fresh nodert
  // worker; "sh"/busybox routes to the VM (once its delegate is registered).
  function makeChildProcess() {
    const normArgs = (cmd, args) => (Array.isArray(args) ? [cmd, ...args] : [cmd]);
    const spawnSync = (cmd, args, options = {}) => {
      const opts = Array.isArray(args) ? options : (args ?? {});
      const argv = Array.isArray(args) ? [cmd, ...args] : [cmd];
      const r = sync("proc.spawn", {
        argv, cwd: opts.cwd ?? proc.cwd(), env: opts.env ?? proc.env,
        wait: true, timeoutMs: opts.timeout,
      });
      const res = r.result ?? r;
      const enc = (s) => (opts.encoding && opts.encoding !== "buffer" ? s : Buffer.from(s));
      return {
        pid: res.pid ?? 0, status: res.exitCode ?? 0, signal: res.signal ?? null,
        stdout: enc(res.stdout ?? ""), stderr: enc(res.stderr ?? ""),
        output: [null, enc(res.stdout ?? ""), enc(res.stderr ?? "")],
      };
    };
    const execSync = (command, options = {}) => {
      // Route the whole command line through `sh -c` (the VM), matching Node.
      const r = spawnSync("sh", ["-c", command], options);
      if (r.status !== 0) {
        const e = new Error(`Command failed: ${command}\n${r.stderr}`);
        e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr;
        throw e;
      }
      return options.encoding && options.encoding !== "buffer" ? r.stdout.toString() : r.stdout;
    };
    const execFileSync = (file, args, options) => {
      const r = spawnSync(file, Array.isArray(args) ? args : [], Array.isArray(args) ? options : args);
      if (r.status !== 0) { const e = new Error(`Command failed: ${file}`); e.status = r.status; e.stderr = r.stderr; throw e; }
      return options?.encoding && options.encoding !== "buffer" ? r.stdout.toString() : r.stdout;
    };
    const spawn = (cmd, args, options = {}) => {
      const opts = Array.isArray(args) ? options : (args ?? {});
      const argv = Array.isArray(args) ? [cmd, ...args] : [cmd];
      const ipc = Array.isArray(opts.stdio) ? opts.stdio.includes("ipc") : !!opts.ipc;
      const r = sync("proc.spawn", { argv, cwd: opts.cwd ?? proc.cwd(), env: opts.env ?? proc.env, wait: false, ipc });
      const res = r.result ?? r;
      return makeChildHandle(res, ipc);
    };
    return {
      spawnSync, execSync, execFileSync, spawn,
      exec: (command, options, callback) => {
        const cb = typeof options === "function" ? options : callback;
        queueMicrotask(() => { try { const out = execSync(command, typeof options === "object" ? options : {}); cb?.(null, out.toString(), ""); } catch (e) { cb?.(e, e.stdout?.toString() ?? "", e.stderr ?? ""); } });
        return makeChildHandle({ pid: 0 });
      },
      // fork() → a node child with an IPC channel (process.send / 'message').
      fork: (modulePath, args = [], options = {}) => spawn("node", [modulePath, ...(Array.isArray(args) ? args : [])], { ...(Array.isArray(args) ? options : args), ipc: true }),
    };
  }

  function makeChildHandle(res, ipc) {
    const listeners = new Map();
    const emit = (ev, ...a) => (listeners.get(ev) ?? []).forEach((fn) => fn(...a));
    const readable = (pipeId) => ({
      on(ev, fn) { if (ev === "data" && pipeId != null) drainPipe(pipeId, (b) => fn(Buffer.from(b))); return this; },
      pipe(dest) { if (pipeId != null) drainPipe(pipeId, (b) => dest.write?.(Buffer.from(b))); return dest; },
      setEncoding() { return this; },
    });
    // IPC (fork): JSON-framed messages over the crossed IPC pipe pair.
    let ipcBuf = "";
    const child = {
      pid: res.pid ?? 0,
      connected: !!ipc,
      stdout: readable(res.stdout), stderr: readable(res.stderr),
      stdin: { write: (d) => { if (res.stdin != null) sync("proc.pipe_write", { pipeId: res.stdin, data: typeof d === "string" ? new TextEncoder().encode(d) : d }); }, end: () => { if (res.stdin != null) sync("proc.pipe_close", { pipeId: res.stdin }); } },
      on(ev, fn) { (listeners.get(ev) ?? listeners.set(ev, []).get(ev)).push(fn); return child; },
      once(ev, fn) { const w = (...a) => { child.off?.(ev, w); fn(...a); }; return child.on(ev, w); },
      off(ev, fn) { const l = listeners.get(ev); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return child; },
      send(message) { if (res.ipcWrite != null) { globalThis.__nodert_ref?.(); const line = JSON.stringify({ v: message }) + "\n"; sync("proc.pipe_write", { pipeId: res.ipcWrite, data: new TextEncoder().encode(line).buffer }); globalThis.__nodert_unref?.(); } return true; },
      disconnect() { child.connected = false; if (res.ipcWrite != null) { try { sync("proc.pipe_close", { pipeId: res.ipcWrite }); } catch {} } },
      kill: (sig) => { if (res.pid) sync("proc.kill", { pid: res.pid, signal: sig ?? "SIGTERM" }); },
    };
    // fork() default (silent:false): the child's stdout/stderr flow to the
    // parent's (Node's inherit-ish behavior).
    if (ipc) {
      if (res.stdout != null) drainPipe(res.stdout, (b) => proc.stdout.write(Buffer.from(b)));
      if (res.stderr != null) drainPipe(res.stderr, (b) => proc.stderr.write(Buffer.from(b)));
    }
    if (ipc && res.ipcRead != null) {
      globalThis.__nodert_ref?.();
      (async () => {
        try {
          for (;;) {
            const r = await busAsync.call("proc.pipe_read", { pipeId: res.ipcRead });
            if (r.eof) break;
            ipcBuf += new TextDecoder().decode(new Uint8Array(r.data));
            let nl;
            while ((nl = ipcBuf.indexOf("\n")) >= 0) { const line = ipcBuf.slice(0, nl); ipcBuf = ipcBuf.slice(nl + 1); if (line) try { emit("message", JSON.parse(line).v); } catch {} }
          }
        } catch {} finally { globalThis.__nodert_unref?.(); child.connected = false; emit("disconnect"); }
      })();
    }
    // Bridge child-exit events (async plane) to 'exit'/'close'.
    busAsync?.onEvent?.((msg) => { if (msg.ev === "child-exit" && msg.pid === res.pid) { emit("exit", msg.exitCode, msg.signal); emit("close", msg.exitCode, msg.signal); } });
    return child;
  }

  function drainPipe(pipeId, onData) {
    globalThis.__nodert_ref?.();
    (async () => {
      try {
        for (;;) {
          const r = await busAsync.call("proc.pipe_read", { pipeId });
          if (r.eof) break;
          if (r.bytes > 0) onData(new Uint8Array(r.data));
        }
      } catch {} finally { globalThis.__nodert_unref?.(); }
    })();
  }

  function makeOs() {
    return {
      platform: () => "linux", arch: () => "x64", type: () => "Linux", release: () => "0.0.0",
      hostname: () => "nodert", tmpdir: () => "/tmp", homedir: () => proc.env.HOME ?? "/root",
      EOL: "\n", cpus: () => Array.from({ length: navigator?.hardwareConcurrency ?? 4 }, () => ({ model: "nodert", speed: 0, times: {} })),
      totalmem: () => 1 << 30, freemem: () => 1 << 29, uptime: () => performance.now() / 1000,
      endianness: () => "LE", loadavg: () => [0, 0, 0], networkInterfaces: () => ({}),
      userInfo: () => ({ uid: 0, gid: 0, username: "root", homedir: "/root", shell: "/bin/sh" }),
      constants: { signals: {}, errno: {} },
    };
  }
  function makeUtil() {
    const inspect = (v, opts) => leanInspect(v);
    const u = {
      inspect,
      format: (...args) => leanFormat(args),
      formatWithOptions: (opts, ...args) => leanFormat(args),
      inherits: (ctor, superCtor) => { ctor.super_ = superCtor; Object.setPrototypeOf(ctor.prototype, superCtor.prototype); },
      promisify: (fn) => (...args) => new Promise((res, rej) => fn(...args, (err, v) => err ? rej(err) : res(v))),
      callbackify: (fn) => (...args) => { const cb = args.pop(); fn(...args).then((v) => cb(null, v), cb); },
      deprecate: (fn) => fn,
      types: makeTypesModule(),
      TextEncoder, TextDecoder,
      isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      debuglog: () => (() => {}),
    };
    inspect.custom = Symbol.for("nodejs.util.inspect.custom");
    return u;
  }
  function makeTypesModule() {
    const t = internalBinding("types");
    return { ...t };
  }
  function makeAssert() {
    const assert = (v, msg) => { if (!v) throw new AssertionError(msg ?? "assertion failed"); };
    class AssertionError extends Error { constructor(m) { super(m); this.name = "AssertionError"; this.code = "ERR_ASSERTION"; } }
    assert.ok = assert;
    assert.equal = (a, b, m) => { if (a != b) throw new AssertionError(m ?? `${a} == ${b}`); };
    assert.strictEqual = (a, b, m) => { if (!Object.is(a, b)) throw new AssertionError(m ?? `${leanInspect(a)} === ${leanInspect(b)}`); };
    assert.deepStrictEqual = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new AssertionError(m ?? "deepStrictEqual"); };
    assert.notStrictEqual = (a, b, m) => { if (Object.is(a, b)) throw new AssertionError(m ?? "notStrictEqual"); };
    assert.throws = (fn, m) => { try { fn(); } catch { return; } throw new AssertionError(m ?? "missing expected exception"); };
    assert.fail = (m) => { throw new AssertionError(m ?? "Failed"); };
    assert.AssertionError = AssertionError;
    return assert;
  }
}

// ---- lean inspect/format shared by console + util (M0; upstream in M1) ----
function leanInspect(v, seen = new Set(), depth = 0) {
  if (typeof v === "string") return depth === 0 ? v : `'${v}'`;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "function") return `[Function: ${v.name || "anonymous"}]`;
  if (typeof v === "symbol") return v.toString();
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v !== "object") return String(v);
  if (seen.has(v)) return "[Circular *1]";
  if (v instanceof Error) return v.stack ?? String(v);
  seen.add(v);
  try {
    if (Array.isArray(v)) return `[ ${v.map((x) => leanInspect(x, seen, depth + 1)).join(", ")} ]`;
    if (v instanceof Map) return `Map(${v.size}) { ${[...v].map(([k, val]) => `${leanInspect(k, seen, depth + 1)} => ${leanInspect(val, seen, depth + 1)}`).join(", ")} }`;
    if (v instanceof Set) return `Set(${v.size}) { ${[...v].map((x) => leanInspect(x, seen, depth + 1)).join(", ")} }`;
    if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.length}) [ ${[...v].join(", ")} ]`;
    const entries = Object.entries(v).map(([k, val]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${leanInspect(val, seen, depth + 1)}`);
    const ctor = v.constructor && v.constructor.name !== "Object" ? v.constructor.name + " " : "";
    return entries.length ? `${ctor}{ ${entries.join(", ")} }` : `${ctor}{}`;
  } finally { seen.delete(v); }
}

function leanFormat(args) {
  if (args.length === 0) return "";
  let i = 0;
  let out = "";
  if (typeof args[0] === "string" && /%[sdifjoOc%]/.test(args[0])) {
    i = 1;
    out = args[0].replace(/%[sdifjoOc%]/g, (m) => {
      if (m === "%%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      switch (m) {
        case "%s": return typeof a === "bigint" ? a + "n" : typeof a === "object" && a !== null ? leanInspect(a) : String(a);
        case "%d": case "%i": return typeof a === "bigint" ? a + "n" : String(parseInt(a, 10));
        case "%f": return String(parseFloat(a));
        case "%j": return JSON.stringify(a);
        case "%o": case "%O": return leanInspect(a);
        case "%c": return "";
        default: return m;
      }
    });
  }
  for (; i < args.length; i++) {
    out += (out ? " " : "") + (typeof args[i] === "string" ? args[i] : leanInspect(args[i]));
  }
  return out;
}

// Strip a leading `#!...` shebang line before compiling (Node does this for
// CJS/main modules). Keeps the newline so line numbers are preserved. Real
// tool entrypoints (npm-cli.js, tsc bins, .bin/* scripts) start with one.
function stripShebang(src) {
  return typeof src === "string" && src.charCodeAt(0) === 0x23 && src.charCodeAt(1) === 0x21
    ? src.slice(src.indexOf("\n") === -1 ? src.length : src.indexOf("\n"))
    : src;
}

export { boot, leanInspect, leanFormat };
