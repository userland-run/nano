// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Boa scripting loader — instantiates `boa.wasm` (the bundled Boa JavaScript
 * engine), manages contexts, marshals values across the host boundary, and
 * exposes the nano VM bridge to sandboxed scripts.
 *
 * This is the "core capability" layer described in specs/nano/scripting-layer.md
 * §8.2. The SDK's `ScriptEngine` sits on top of it.
 *
 * Usage:
 *   import { BoaRuntime } from "@container/boa.mjs";
 *   const boa = await BoaRuntime.load("/boa.wasm");
 *   const result = await boa.script(`1 + 2`);            // one-shot
 *
 *   // Long-lived sandbox driving a NanoVM:
 *   const engine = boa.createEngine({
 *     host,                                  // { fs, run, exec, sh, node }
 *     expose: { fs: "readonly", run: true },
 *     globalName: "nano",
 *   });
 *   await engine.eval(`nano.fs.list("/").map(e => e.name).join(" ")`);
 *
 * boa.wasm imports (env): host_random, host_now_millis, host_tz_offset,
 * host_call, host_call_async, host_write. boa.wasm exports the C-style ABI
 * (boa_eval, boa_context_create, ...) — see boa/src/lib.rs.
 */

/** ABI the loader speaks; must match `ABI_VERSION` in boa/src/lib.rs. */
const ABI_VERSION = 1;

const STREAM_STDERR = 2;

const _decoder = new TextDecoder();
const _encoder = new TextEncoder();

/** Best available CSPRNG (browser/Node `globalThis.crypto`). */
const _crypto =
  typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.getRandomValues
    ? globalThis.crypto
    : null;

function errMsg(e) {
  if (e == null) return "error";
  if (typeof e === "string") return e;
  return e.message ? String(e.message) : String(e);
}

/** Normalize script-supplied file data (Uint8Array | number[] | string) to bytes. */
function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data);
  if (typeof data === "string") return _encoder.encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

/** Resolve a wasm source (bytes | ArrayBuffer | URL/path string) to bytes. */
async function resolveWasmBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof source !== "string") {
    throw new TypeError("BoaRuntime: wasm source must be bytes, ArrayBuffer, or URL/path string");
  }
  const isNode =
    typeof process !== "undefined" && process.versions && process.versions.node;
  const isHttp = /^https?:|^file:|^data:/.test(source);
  if (isNode && !isHttp) {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(source));
  }
  const resp = await fetch(source);
  if (!resp.ok) throw new Error(`BoaRuntime: failed to fetch ${source}: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

/** Error thrown when a script throws or rejects. */
export class ScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScriptError";
  }
}

// ============================================================
// BoaRuntime — one wasm instance, many engines/contexts
// ============================================================

export class BoaRuntime {
  /** Compile + instantiate boa.wasm. `source` is bytes, ArrayBuffer, or URL/path. */
  static async load(source) {
    const rt = new BoaRuntime();
    await rt._init(source);
    return rt;
  }

  constructor() {
    /** @type {WebAssembly.Exports} */
    this._exports = null;
    /** Global host-function table (fn_id -> JS callback) shared across engines. */
    this._hostFns = [];
    /** The engine whose context is currently executing (set around every wasm call). */
    this._active = null;
  }

  async _init(source) {
    const bytes = await resolveWasmBytes(source);
    const rt = this;
    const imports = {
      env: {
        host_random(ptr, len) {
          const view = new Uint8Array(rt._exports.memory.buffer, ptr, len);
          if (_crypto) _crypto.getRandomValues(view);
          else for (let i = 0; i < len; i++) view[i] = (Math.random() * 256) | 0;
        },
        host_now_millis() {
          return Date.now();
        },
        host_tz_offset(unixSecs) {
          // getTimezoneOffset is minutes WEST of UTC; we want seconds EAST.
          return -new Date(unixSecs * 1000).getTimezoneOffset() * 60;
        },
        host_write(stream, ptr, len) {
          const text = rt._readStr(ptr, len);
          const eng = rt._active;
          const sink = stream === STREAM_STDERR ? eng && eng._onStderr : eng && eng._onStdout;
          if (sink) sink(text);
          else if (stream === STREAM_STDERR) (globalThis.process?.stderr?.write?.bind(globalThis.process.stderr) ?? ((t) => console.error(t.replace(/\n$/, ""))))(text);
          else (globalThis.process?.stdout?.write?.bind(globalThis.process.stdout) ?? ((t) => console.log(t.replace(/\n$/, ""))))(text);
        },
        host_call(fnId, argsPtr, argsLen) {
          const fn = rt._hostFns[fnId];
          let reply;
          try {
            const args = rt._parseArgs(argsPtr, argsLen);
            const value = fn ? fn(...args) : null;
            reply = JSON.stringify({ value: value === undefined ? null : value });
          } catch (e) {
            reply = JSON.stringify({ error: errMsg(e) });
          }
          // Rust takes ownership of this buffer and frees it.
          const { ptr, len } = rt._alloc(reply);
          return rt._pack(ptr, len);
        },
        host_call_async(fnId, argsPtr, argsLen, promiseId) {
          const eng = rt._active;
          const fn = rt._hostFns[fnId];
          let args;
          try {
            args = rt._parseArgs(argsPtr, argsLen);
          } catch (e) {
            eng._inflight.set(promiseId, Promise.resolve({ id: promiseId, ok: false, error: errMsg(e) }));
            return;
          }
          const p = Promise.resolve()
            .then(() => (fn ? fn(...args) : null))
            .then((value) => ({ id: promiseId, ok: true, value: value === undefined ? null : value }))
            .catch((e) => ({ id: promiseId, ok: false, error: errMsg(e) }));
          eng._inflight.set(promiseId, p);
        },
      },
    };
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    this._exports = instance.exports;

    const v = this.version();
    if (v.abi !== ABI_VERSION) {
      throw new Error(`BoaRuntime: boa.wasm ABI ${v.abi} != loader ABI ${ABI_VERSION}`);
    }
    this._info = v;
  }

  // ---- memory helpers (re-read buffer each time; it detaches on growth) ----

  _readStr(ptr, len) {
    if (!ptr || !len) return "";
    return _decoder.decode(new Uint8Array(this._exports.memory.buffer, ptr, len));
  }

  _parseArgs(ptr, len) {
    const s = this._readStr(ptr, len);
    return s ? JSON.parse(s) : [];
  }

  /** Allocate a wasm buffer and copy `s` in. Returns {ptr,len}. */
  _alloc(s) {
    const bytes = _encoder.encode(s);
    const len = bytes.length;
    if (len === 0) return { ptr: 0, len: 0 };
    const ptr = this._exports.boa_alloc(len);
    new Uint8Array(this._exports.memory.buffer, ptr, len).set(bytes);
    return { ptr, len };
  }

  _free(ptr, len) {
    if (ptr && len) this._exports.boa_free(ptr, len);
  }

  /** Pack a (ptr,len) pair as the i64 the host_call import must return. */
  _pack(ptr, len) {
    return (BigInt(ptr >>> 0) << 32n) | BigInt(len >>> 0);
  }

  /** Read a packed-string export return, free it, and JSON-parse it. */
  _takeJson(packed) {
    const big = BigInt(packed);
    const ptr = Number(big >> 32n);
    const len = Number(big & 0xffffffffn);
    if (!ptr || !len) return {};
    const s = this._readStr(ptr, len);
    this._free(ptr, len);
    return JSON.parse(s);
  }

  /** Run `fn` (which calls a wasm export) with this engine marked active. */
  _withActive(engine, fn) {
    const prev = this._active;
    this._active = engine;
    try {
      return fn();
    } finally {
      this._active = prev;
    }
  }

  // ---- public API ----

  /** `{ engine, wrapper, abi }` reported by boa.wasm. */
  version() {
    return this._takeJson(this._exports.boa_version());
  }

  /**
   * Create a scripting engine (one Boa context).
   *
   * @param {object} [opts]
   * @param {object} [opts.host]        Driver: { fs:{readText,readFile,list,exists,writeFile}, run, exec, sh, node, log }
   * @param {object} [opts.expose]      Capabilities: { fs:"none"|"readonly"|"readwrite", run, node }
   * @param {string} [opts.globalName]  Bridge global (default "nano")
   * @param {object} [opts.env]         Read-only key/value bag injected as `<global>.env`
   * @param {string[]} [opts.webapis]   boa_runtime globals: console|encoding|url|timers (default ["console"])
   * @param {object} [opts.limits]      { loopIterations, recursion }
   * @param {number} [opts.timeoutMs]   Host watchdog (0 = none)
   * @param {boolean} [opts.syncOnly]   Expose only synchronous bridge members
   */
  createEngine(opts = {}) {
    const {
      host = {},
      expose = {},
      globalName = "nano",
      env = {},
      webapis,
      limits = {},
      timeoutMs = 0,
      syncOnly = false,
    } = opts;

    const cfg = {
      webapis: webapis || ["console"],
      limits: {
        loopIterations: limits.loopIterations,
        recursion: limits.recursion,
      },
    };
    const { ptr, len } = this._alloc(JSON.stringify(cfg));
    let ctx;
    try {
      ctx = this._exports.boa_context_create(ptr, len);
    } finally {
      this._free(ptr, len);
    }
    if (!ctx) throw new Error("BoaRuntime: boa_context_create failed");

    const engine = new BoaEngine(this, ctx, { timeoutMs, syncOnly });
    this._installBridge(engine, { host, expose, globalName, env, syncOnly });
    return engine;
  }

  /** One-shot: create an engine, evaluate `source`, dispose, return the value. */
  async script(source, opts = {}) {
    const engine = this.createEngine(opts);
    try {
      return await engine.eval(source);
    } finally {
      engine.dispose();
    }
  }

  // ---- bridge assembly ----

  /** Register a host callback, returning the internal global name bound to it. */
  _registerFn(engine, fn, isAsync) {
    const fnId = this._hostFns.push(fn) - 1;
    const name = `__nano_h${fnId}`;
    const { ptr, len } = this._alloc(name);
    try {
      const ok = this._exports.boa_register_host_fn(engine._ctx, ptr, len, fnId, isAsync ? 1 : 0);
      if (!ok) throw new Error(`BoaRuntime: failed to register ${name}`);
    } finally {
      this._free(ptr, len);
    }
    return name;
  }

  /**
   * Build the script-facing bridge global from `expose`, then freeze it. The
   * `expose` config is the capability boundary: ungranted members are never
   * registered, so they simply don't exist in the sandbox.
   */
  _installBridge(engine, { host, expose, globalName, env, syncOnly }) {
    const fs = host.fs || {};
    const fsMode = expose.fs || "none";
    const reg = (fn, isAsync) => this._registerFn(engine, fn, isAsync && !syncOnly);

    const members = []; // "key: <expr>" strings assembled into the global

    // Filesystem (synchronous — MemFS is sync).
    if (fsMode === "readonly" || fsMode === "readwrite") {
      const rt = reg((p) => (fs.readText ? fs.readText(p) ?? null : null), false);
      const rf = reg((p) => {
        const u = fs.readFile ? fs.readFile(p) : null;
        return u ? Array.from(toBytes(u)) : null;
      }, false);
      const rl = reg((p) => (fs.list ? fs.list(p) ?? null : null), false);
      const re = reg((p) => (fs.exists ? !!fs.exists(p) : false), false);
      const fsParts = [
        `readText: ${rt}`,
        // re-wrap the byte array the host returns as a Uint8Array for the script
        `readFile: (p) => { const a = ${rf}(p); return a == null ? null : new Uint8Array(a); }`,
        `list: ${rl}`,
        `exists: ${re}`,
      ];
      if (fsMode === "readwrite") {
        const rw = reg((p, data) => {
          if (fs.writeFile) fs.writeFile(p, toBytes(data));
          return null;
        }, false);
        fsParts.push(`writeFile: (p, d) => ${rw}(p, d instanceof Uint8Array ? Array.from(d) : d)`);
      }
      members.push(`fs: Object.freeze({ ${fsParts.join(", ")} })`);
    }

    // Command execution (asynchronous — steps the VM).
    if (expose.run && !syncOnly) {
      const run = reg((cmd) => host.run(cmd), true);
      members.push(`run: ${run}`);
      if (host.sh) members.push(`sh: ${reg((line) => host.sh(line), true)}`);
      if (host.exec) members.push(`exec: ${reg((argv) => host.exec(argv), true)}`);
    }
    if (expose.node && host.node && !syncOnly) {
      members.push(`node: ${reg((args) => host.node(args), true)}`);
    }

    // Host-side logging (synchronous).
    const log = reg((...args) => {
      if (host.log) host.log(...args);
      else console.log(...args);
      return null;
    }, false);
    members.push(`log: ${log}`);

    // Injected env bag (read-only data).
    members.push(`env: Object.freeze(${JSON.stringify(env || {})})`);

    const prelude = `globalThis[${JSON.stringify(globalName)}] = Object.freeze({ ${members.join(", ")} });`;
    const res = this._withActive(engine, () => engine._rawEval(prelude));
    if (!res.ok) throw new Error(`BoaRuntime: bridge install failed: ${res.error}`);
  }
}

// ============================================================
// BoaEngine — one Boa context
// ============================================================

export class BoaEngine {
  constructor(runtime, ctx, { timeoutMs = 0, syncOnly = false } = {}) {
    this._runtime = runtime;
    this._ctx = ctx;
    this._timeoutMs = timeoutMs;
    this._syncOnly = syncOnly;
    this._disposed = false;
    /** promise_id -> Promise<{id,ok,value|error}> for in-flight async host calls. */
    this._inflight = new Map();
    this._onStdout = null;
    this._onStderr = null;
  }

  /** Route console.log/info output (stdout). */
  onStdout(fn) {
    this._onStdout = fn;
    return this;
  }
  /** Route console.warn/error output (stderr). */
  onStderr(fn) {
    this._onStderr = fn;
    return this;
  }

  /** Evaluate `source`; resolves with the (JSON-marshalled) result value. */
  async eval(source) {
    this._assertLive();
    const env = this._runtime._withActive(this, () => this._rawEval(source));
    return this._settle(env);
  }

  /** Evaluate `source` as an ES module. Always async (module eval is a promise). */
  async evalModule(source, specifier = "") {
    this._assertLive();
    const env = this._runtime._withActive(this, () => {
      const s = this._runtime._alloc(source);
      const sp = this._runtime._alloc(specifier);
      try {
        const packed = this._runtime._exports.boa_eval_module(this._ctx, s.ptr, s.len, sp.ptr, sp.len);
        return this._runtime._takeJson(packed);
      } finally {
        this._runtime._free(s.ptr, s.len);
        this._runtime._free(sp.ptr, sp.len);
      }
    });
    return this._settle(env);
  }

  /** Register a host function callable from scripts. Async by default. */
  registerFunction(name, fn, { async: isAsync = true } = {}) {
    this._assertLive();
    const fnId = this._runtime._hostFns.push((...args) => fn(...args)) - 1;
    const a = this._runtime._alloc(name);
    try {
      const ok = this._runtime._exports.boa_register_host_fn(
        this._ctx,
        a.ptr,
        a.len,
        fnId,
        isAsync && !this._syncOnly ? 1 : 0,
      );
      if (!ok) throw new Error(`registerFunction(${name}) failed`);
    } finally {
      this._runtime._free(a.ptr, a.len);
    }
    return this;
  }

  /** Define a plain-data global from a JSON-able value. */
  defineGlobal(name, value) {
    this._assertLive();
    const n = this._runtime._alloc(name);
    const v = this._runtime._alloc(JSON.stringify(value === undefined ? null : value));
    try {
      const ok = this._runtime._exports.boa_define_global(this._ctx, n.ptr, n.len, v.ptr, v.len);
      if (!ok) throw new Error(`defineGlobal(${name}) failed`);
    } finally {
      this._runtime._free(n.ptr, n.len);
      this._runtime._free(v.ptr, v.len);
    }
    return this;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._runtime._exports.boa_context_dispose(this._ctx);
  }

  // ---- internals ----

  _assertLive() {
    if (this._disposed) throw new Error("BoaEngine: context disposed");
  }

  /** Run a raw eval and return the `{ok, pending, value|error}` envelope. */
  _rawEval(source) {
    const { ptr, len } = this._runtime._alloc(source);
    try {
      const packed = this._runtime._exports.boa_eval(this._ctx, ptr, len);
      return this._runtime._takeJson(packed);
    } finally {
      this._runtime._free(ptr, len);
    }
  }

  /** Resolve a settled-or-pending envelope to the final value, driving async work. */
  async _settle(env) {
    if (!env.ok) throw new ScriptError(env.error || "script error");
    if (!env.pending) return env.value;
    return this._pump();
  }

  /** Async tier: pump the job queue and service async host calls until settled. */
  async _pump() {
    const deadline = this._timeoutMs ? Date.now() + this._timeoutMs : Infinity;
    for (;;) {
      // Drain microtasks; settles promises whose host calls already resolved and
      // may issue further async host calls (recorded into _inflight).
      this._runtime._withActive(this, () => this._runtime._exports.boa_run_jobs(this._ctx));

      const r = this._runtime._withActive(this, () => this._readResult());
      if (r.ready) {
        if (r.ok) return r.value;
        throw new ScriptError(r.error || "script rejected");
      }

      if (this._inflight.size === 0) {
        throw new ScriptError("script did not settle (no pending host work)");
      }
      if (Date.now() > deadline) {
        this.dispose();
        throw new ScriptError(`script timed out after ${this._timeoutMs}ms`);
      }

      // Wait for the current batch of async host calls and feed results back in.
      const batch = [...this._inflight.values()];
      this._inflight.clear();
      const settled = await Promise.all(batch);
      this._runtime._withActive(this, () => {
        for (const s of settled) {
          if (s.ok) this._resolve(s.id, { value: s.value });
          else this._reject(s.id, { error: s.error });
        }
      });
    }
  }

  _readResult() {
    return this._runtime._takeJson(this._runtime._exports.boa_take_result(this._ctx));
  }

  _resolve(promiseId, payload) {
    const { ptr, len } = this._runtime._alloc(JSON.stringify(payload));
    try {
      this._runtime._exports.boa_resolve(this._ctx, promiseId, ptr, len);
    } finally {
      this._runtime._free(ptr, len);
    }
  }

  _reject(promiseId, payload) {
    const { ptr, len } = this._runtime._alloc(JSON.stringify(payload));
    try {
      this._runtime._exports.boa_reject(this._ctx, promiseId, ptr, len);
    } finally {
      this._runtime._free(ptr, len);
    }
  }
}

export default BoaRuntime;
