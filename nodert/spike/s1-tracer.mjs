#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Spike S1 — binding tracer bootstrap (risk R1 of the nodert plan).
 *
 * Boots the VENDORED node v25.4.0 lib/ (vendor/node-lib bundle) on the host
 * engine with a Proxy-based internalBinding registry that LOGS every
 * (binding, property) access and answers with permissive smart stubs.
 * The deliverable is the ordered access trace — the empirical
 * bootstrap-critical binding surface — plus how far bootstrap gets before
 * the first hard failure.
 *
 * Usage: node spike/s1-tracer.mjs [--json]
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, "..", "vendor", "node-lib");
const index = JSON.parse(readFileSync(join(libDir, "index.json"), "utf8"));
const raw = brotliDecompressSync(readFileSync(join(libDir, `node-lib-${index.version}.bundle.br`)), {
  maxOutputLength: 1 << 30,
});
const srcOf = (id) => {
  const e = index.modules[id];
  if (!e) return null;
  return raw.subarray(e[0], e[0] + e[1]).toString("utf8");
};

// ------------------------------------------------------------
// Access trace
// ------------------------------------------------------------
const trace = [];
const seen = new Set();
function record(binding, prop) {
  const key = `${binding}.${String(prop)}`;
  if (!seen.has(key)) {
    seen.add(key);
    trace.push(key);
  }
}

const privateSymbols = new Proxy({ __proto__: null }, {
  get(t, prop) {
    if (typeof prop !== "string") return undefined;
    if (!(prop in t)) t[prop] = Symbol(prop);
    return t[prop];
  },
});

// ------------------------------------------------------------
// Smart stubs: enough shape to keep bootstrap moving while tracing.
// Real implementations replace these per Appendix-B classification in M0.
// ------------------------------------------------------------
const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

function makeSmartStub(binding, prop) {
  // Functions that must return something callable/iterable get tailored
  // stubs; everything else gets a logging function returning undefined.
  const fn = (...args) => {
    record(binding, `${String(prop)}()`);
    switch (`${binding}.${String(prop)}`) {
      case "options.getCLIOptionsValues":
        return {};
      case "options.getCLIOptionsInfo":
        return { options: new Map(), aliases: new Map() };
      case "options.getEmbedderOptions":
        return { shouldNotRegisterESMLoader: false, noGlobalSearchPaths: false, noBrowserGlobals: false, hasEmbedderPreload: false };
      case "options.getEnvOptionsInputType":
      case "options.getNamespaceOptionsInputType":
        return new Map();
      case "builtins.getNatives":
        return {};
      case "util.getOwnNonIndexProperties":
        return Object.getOwnPropertyNames(args[0] ?? {});
      case "util.createPrivateSymbol":
        return Symbol(args[0]);
      case "uv.getErrorMap":
        return new Map([[-2, ["ENOENT", "no such file or directory"]]]);
      case "icu.getStringWidth":
        return String(args[0] ?? "").length;
      default:
        return undefined;
    }
  };
  return fn;
}

const bindingOverrides = {
  config: {
    isDebugBuild: false, openSSLIsBoringSSL: false, hasOpenSSL: true, fipsMode: false,
    hasIntl: true, hasTracing: false, hasNodeOptions: true, hasInspector: false,
    noBrowserGlobals: false, bits: 64,
  },
  constants: null, // built below
  task_queue: null,
  timers: null,
  async_wrap: null,
  trace_events: { isTraceCategoryEnabled: () => false, trace: () => {}, getCategoryEnabledBuffer: () => new Uint8Array(1) },
  process_methods: null,
  symbols: null,
};

// Typed-array-bearing bindings need real arrays, not proxies.
function concreteBindings() {
  const kTickInfoFields = 2;
  return {
    task_queue: {
      tickInfo: new Uint8Array(kTickInfoFields),
      promiseRejectEvents: { kPromiseRejectWithNoHandler: 0, kPromiseHandlerAddedAfterReject: 1, kPromiseResolveAfterResolved: 2, kPromiseRejectAfterResolved: 3 },
      setTickCallback: (cb) => { hostState.tickCallback = cb; },
      enqueueMicrotask: (cb) => queueMicrotask(cb),
      runMicrotasks: () => {},
      setPromiseRejectCallback: () => {},
    },
    timers: {
      immediateInfo: new Uint32Array(3),
      timeoutInfo: new Int32Array(1),
      getLibuvNow: () => Math.floor(performance.now()),
      setupTimers: (...cbs) => { hostState.timerCallbacks = cbs; },
      scheduleTimer: () => {},
      toggleTimerRef: () => {},
      toggleImmediateRef: () => {},
    },
    async_wrap: {
      async_hook_fields: new Uint32Array(8),
      async_id_fields: new Float64Array(8),
      execution_async_resources: [],
      constants: { kInit: 0, kBefore: 1, kAfter: 2, kDestroy: 3, kPromiseResolve: 4, kTotals: 5, kCheck: 6, kStackLength: 7, kUsesExecutionAsyncResource: 8, kExecutionAsyncId: 0, kTriggerAsyncId: 1, kAsyncIdCounter: 2, kDefaultTriggerAsyncId: 3 },
      setCallbackTrampoline: () => {},
      pushAsyncContext: () => {},
      popAsyncContext: () => {},
      queueDestroyAsyncId: () => {},
    },
    symbols: {
      owner_symbol: Symbol("owner_symbol"),
      onpipe: Symbol("onpipe"),
      oninit: Symbol("oninit"),
      no_message_symbol: Symbol("no_message_symbol"),
      messaging_deserialize_symbol: Symbol("messaging_deserialize_symbol"),
      messaging_transfer_symbol: Symbol("messaging_transfer_symbol"),
      messaging_clone_symbol: Symbol("messaging_clone_symbol"),
      messaging_transfer_list_symbol: Symbol("messaging_transfer_list_symbol"),
      trigger_async_id_symbol: Symbol("trigger_async_id_symbol"),
      async_id_symbol: Symbol("async_id_symbol"),
      handle_onclose: Symbol("handle_onclose"),
    },
    constants: {
      os: { UV_UDP_REUSEADDR: 4, dlopen: {}, errno: { E2BIG: 7, EACCES: 13, ENOENT: 2 }, signals: { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }, priority: {} },
      fs: { UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4, UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
      crypto: {},
      zlib: {},
      trace: { CHAR0: 48, CHAR1: 49 },
      internal: {},
    },
    process_methods: {
      cwd: () => "/",
      chdir: () => {},
      umask: () => 0o22,
      availableMemory: () => 1 << 30,
      constrainedMemory: () => 0,
      rss: () => 1 << 24,
      memoryUsage: () => new Float64Array(5),
      hrtimeBigInt: () => process.hrtime.bigint(),
      hrtime: () => {},
      kill: () => 0,
      exitCodes: {},
      loadEnvFile: () => {},
      patchProcessObject: (proc) => {},
    },
  };
}

const hostState = { tickCallback: null, timerCallbacks: null, loaders: null };
const concrete = concreteBindings();

// builtins/module_wrap are the realm's spine — implement them for real:
// compileFunction(id) is exactly where the lazy bundle eval hooks in (§8.1),
// and setInternalLoaders is realm.js handing its JS loaders back to us.
concrete.builtins = {
  builtinIds: Object.keys(index.modules).filter((id) => !id.startsWith("internal/per_context/")),
  compileFunction: (id) => {
    const src = srcOf(id);
    if (src === null) throw new Error(`unknown builtin ${id}`);
    return new Function(
      "exports", "require", "module", "process", "internalBinding", "primordials",
      `${src}\n//# sourceURL=node:${id}`
    );
  },
  setInternalLoaders: (internalBindingFn, requireFn) => {
    hostState.loaders = { internalBinding: internalBindingFn, require: requireFn };
  },
  getNatives: () => ({}),
  config: JSON.stringify({ variables: { node_builtin_shareable_builtins: [] } }),
};
concrete.util = {
  privateSymbols,
  constants: { kExiting: 0, kExitCode: 1, kHasExitCode: 2, kArrowMessagePrivateSymbolIndex: 0, kDecoratedPrivateSymbolIndex: 1 },
  getOwnNonIndexProperties: (obj) => Object.getOwnPropertyNames(obj ?? {}),
  getConstructorName: (obj) => obj?.constructor?.name ?? "Object",
  createPrivateSymbol: (name) => Symbol(name),
  getHiddenValue: () => undefined,
  setHiddenValue: () => true,
  guessHandleType: () => "FILE",
  WeakReference: class WeakReference {
    constructor(v) { this._ref = new WeakRef(v); }
    get() { return this._ref.deref(); }
    incRef() {}
    decRef() {}
  },
  setPromiseHooks: () => {},
  isInsideNodeModules: () => false,
  // v25 moved defineLazyProperties into the C++ util binding: lazy getters
  // that require(id) on first touch.
  defineLazyProperties: (target, id, keys, enumerable = true) => {
    for (const key of keys) {
      let materialized = false;
      let value;
      Object.defineProperty(target, key, {
        get() {
          if (!materialized) {
            value = (hostState.loaders?.require ?? requireBuiltin)(id)[key];
            materialized = true;
          }
          return value;
        },
        set(v) {
          value = v;
          materialized = true;
        },
        configurable: true,
        enumerable,
      });
    }
    return target;
  },
};
concrete.buffer = {
  kMaxLength: 4294967296,
  kStringMaxLength: (1 << 29) - 24,
  byteLengthUtf8: (str) => {
    const n = utf8.enc.encode(str).length;
    if (process.env.S1_DEBUG) console.error(`[dbg] byteLengthUtf8(len=${str.length}) -> ${n}`);
    return n;
  },
  utf8WriteStatic: (buf, string, offset, length) => {
    if (process.env.S1_DEBUG) console.error(`[dbg] utf8WriteStatic strLen=${string.length} off=${offset} len=${length} bufLen=${buf?.byteLength}`);
    const bytes = utf8.enc.encode(string);
    const n = Math.min(bytes.length, length ?? bytes.length);
    buf.set(bytes.subarray(0, n), offset);
    return n;
  },
  latin1WriteStatic: (buf, string, offset, length) => {
    const n = Math.min(string.length, length ?? string.length);
    for (let i = 0; i < n; i++) buf[offset + i] = string.charCodeAt(i) & 0xff;
    return n;
  },
  asciiWriteStatic: (buf, string, offset, length) => {
    const n = Math.min(string.length, length ?? string.length);
    for (let i = 0; i < n; i++) buf[offset + i] = string.charCodeAt(i) & 0x7f;
    return n;
  },
  copy: (src, dst, dstOff = 0, srcStart = 0, srcEnd = src.length) => {
    const chunk = src.subarray(srcStart, srcEnd);
    dst.set(chunk, dstOff);
    return chunk.length;
  },
  compare: (a, b) => {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  },
  compareOffset: (a, b, aStart, bStart, aEnd, bEnd) =>
    concrete.buffer.compare(a.subarray(aStart, aEnd), b.subarray(bStart, bEnd)),
  fill: () => 0,
  indexOfBuffer: () => -1,
  indexOfNumber: (buf, val, byteOffset, dir) => buf.indexOf(val, byteOffset),
  indexOfString: () => -1,
  swap16: (b) => b, swap32: (b) => b, swap64: (b) => b,
  getZeroFillToggle: () => new Uint32Array(1),
  createUnsafeBuffer: (size) => new Uint8Array(size),
  zeroFill: new Uint32Array(1),
  detachArrayBuffer: () => {},
  copyArrayBuffer: (dest, destOff, src, srcOff, len) =>
    new Uint8Array(dest).set(new Uint8Array(src, srcOff, len), destOff),
  isUtf8: () => true,
  isAscii: () => true,
  transcode: (b) => b,
};
concrete.encoding_binding = {
  encodeUtf8String: (str) => utf8.enc.encode(str),
  encodeIntoResults: new Uint32Array(2),
  encodeInto: (str, dest) => {
    const r = utf8.enc.encodeInto(str, dest);
    concrete.encoding_binding.encodeIntoResults[0] = r.read;
    concrete.encoding_binding.encodeIntoResults[1] = r.written;
  },
  decodeUTF8: (bytes, ignoreBom = false) => utf8.dec.decode(bytes),
  decodeLatin1: (bytes) => {
    let out = "";
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  },
  toASCII: (s) => s,
  toUnicode: (s) => s,
};
concrete.contextify = {
  ContextifyScript: class ContextifyScript {
    runInContext() { throw new Error("nodert: separate contexts deferred (§8.9)"); }
    runInThisContext() { return undefined; }
    createCachedData() { return new Uint8Array(0); }
  },
  ContextifyContext: class ContextifyContext {},
  // Node's wrapper-compile path: host Function with the given params (§9.1).
  compileFunction: (code, filename, ...rest) => {
    const params = Array.isArray(rest[rest.length - 1]) ? rest[rest.length - 1] : [];
    return new Function(...params, `${code}\n//# sourceURL=${filename}`);
  },
  constants: { measureMemory: { mode: { SUMMARY: 0, DETAILED: 1 }, execution: { DEFAULT: 0, EAGER: 1 } } },
  makeContext: () => {},
  isContext: () => false,
  registerImportModuleDynamically: () => {},
};
concrete.messaging = {
  MessageChannel: globalThis.MessageChannel ?? class MessageChannel {},
  MessagePort: globalThis.MessagePort ?? class MessagePort {},
  JSTransferable: class JSTransferable {},
  setDeserializerCreateObjectFunction: () => {},
  broadcastChannel: () => null,
  stopMessagePort: () => {},
  checkMessagePort: () => false,
  drainMessagePort: () => {},
  receiveMessageOnPort: () => undefined,
  moveMessagePortToContext: () => null,
};
concrete.performance = {
  constants: {
    NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8,
    NODE_PERFORMANCE_GC_WEAKCB: 16, NODE_PERFORMANCE_GC_FLAGS_NO: 0,
    NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN: 0, NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP: 1,
    NODE_PERFORMANCE_MILESTONE_ENVIRONMENT: 2, NODE_PERFORMANCE_MILESTONE_NODE_START: 3,
    NODE_PERFORMANCE_MILESTONE_V8_START: 4, NODE_PERFORMANCE_MILESTONE_LOOP_START: 5,
    NODE_PERFORMANCE_MILESTONE_LOOP_EXIT: 6, NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE: 7,
    NODE_PERFORMANCE_ENTRY_TYPE_GC: 0, NODE_PERFORMANCE_ENTRY_TYPE_HTTP: 1,
    NODE_PERFORMANCE_ENTRY_TYPE_HTTP2: 2, NODE_PERFORMANCE_ENTRY_TYPE_NET: 3, NODE_PERFORMANCE_ENTRY_TYPE_DNS: 4,
  },
  milestones: new Float64Array(8),
  timeOrigin: performance.timeOrigin ?? 0,
  timeOriginTimestamp: Date.now(),
  markMilestone: () => {},
  setupObservers: () => {},
  installGarbageCollectionTracking: () => {},
  removeGarbageCollectionTracking: () => {},
  loopIdleTime: () => 0,
  getTimeOrigin: () => performance.timeOrigin ?? 0,
  getTimeOriginTimestamp: () => Date.now(),
  createELDHistogram: () => null,
};
concrete.module_wrap = {
  ModuleWrap: class ModuleWrap {},
  setInitializeImportMetaObjectCallback: () => {},
  setImportModuleDynamicallyCallback: () => {},
};

const bindingCache = new Map();

function getInternalBinding(name) {
  record("<binding>", name);
  if (bindingCache.has(name)) return bindingCache.get(name);
  let b;
  if (concrete[name]) {
    // Wrap concrete objects in a logging proxy that falls back to stubs.
    const base = concrete[name];
    b = new Proxy(base, {
      get(t, prop) {
        record(name, prop);
        if (prop in t) return t[prop];
        if (typeof prop === "string") return makeSmartStub(name, prop);
        return undefined;
      },
    });
  } else if (bindingOverrides[name] && typeof bindingOverrides[name] === "object") {
    const base = bindingOverrides[name];
    b = new Proxy(base, {
      get(t, prop) {
        record(name, prop);
        if (prop in t) return t[prop];
        if (typeof prop === "string") return makeSmartStub(name, prop);
        return undefined;
      },
    });
  } else {
    b = new Proxy({}, {
      get(t, prop) {
        record(name, prop);
        if (prop === Symbol.toPrimitive || prop === "toString") return () => `[binding ${name}]`;
        if (typeof prop !== "string") return undefined;
        if (!(prop in t)) t[prop] = makeSmartStub(name, prop);
        return t[prop];
      },
      set(t, prop, v) {
        t[prop] = v;
        return true;
      },
    });
  }
  bindingCache.set(name, b);
  return b;
}

// ------------------------------------------------------------
// primordials from the vendored per_context scripts (verbatim, R2)
// ------------------------------------------------------------
const primordials = { __proto__: null };
for (const id of ["internal/per_context/primordials", "internal/per_context/domexception", "internal/per_context/messageport"]) {
  const src = srcOf(id);
  if (!src) continue;
  try {
    // per_context scripts reference `primordials`, `exports`, and the
    // C++-provided `privateSymbols` — generate symbols on demand.
    new Function("exports", "primordials", "privateSymbols", src)({}, primordials, privateSymbols);
    console.error(`per_context ok: ${id}`);
  } catch (e) {
    console.error(`per_context FAIL: ${id}: ${e.message}`);
  }
}
console.error(`primordials properties: ${Object.getOwnPropertyNames(primordials).length}`);

// ------------------------------------------------------------
// BuiltinModule host: compile vendored lib modules with Node's wrapper
// ------------------------------------------------------------
const moduleCache = new Map();
let failure = null;

function requireBuiltin(id) {
  const norm = id.replace(/^node:/, "");
  if (moduleCache.has(norm)) return moduleCache.get(norm).exports;
  const src = srcOf(norm);
  if (src === null) throw new Error(`unknown builtin ${norm}`);
  const mod = { exports: {}, id: norm };
  moduleCache.set(norm, mod);
  const fn = new Function(
    "exports", "require", "module", "process", "internalBinding", "primordials",
    `${src}\n//# sourceURL=node:${norm}`
  );
  fn.call(mod.exports, mod.exports, requireBuiltin, mod, processStub, getInternalBinding, primordials);
  return mod.exports;
}

// Minimal process shell — bootstrap/node.js patches and extends this.
// It must sit on a MUTABLE intermediate prototype: setupProcessObject does
// setPrototypeOf(getPrototypeOf(process), EventEmitter.prototype).
const processStub = Object.assign(Object.create(Object.create(Object.prototype)), {
  version: index.version,
  versions: { node: index.version.slice(1) },
  platform: "linux",
  arch: "x64",
  argv: ["node", "spike"],
  execArgv: [],
  env: { NODE_DEBUG: "" },
  pid: 1,
  _exiting: false,
  config: { variables: {} },
  hrtime: process.hrtime,
  moduleLoadList: [],
  binding: (n) => getInternalBinding(n),
  _linkedBinding: (n) => getInternalBinding(n),
  domain: undefined,
  _rawDebug: (...a) => console.error("[rawDebug]", ...a),
  emitWarning: () => {},
  nextTick: (cb, ...args) => queueMicrotask(() => cb(...args)),
  reallyExit: () => {},
});
processStub[privateSymbols.exit_info_private_symbol] = new Uint32Array(3);

// ------------------------------------------------------------
// Attempt the bootstrap sequence
// ------------------------------------------------------------
let phase = "realm";
const phases = [];
try {
  // 1. bootstrap/realm.js — in real Node this is compiled with
  //    (process, getLinkedBinding, getInternalBinding, primordials).
  const realmSrc = srcOf("internal/bootstrap/realm");
  const realmFn = new Function(
    "process", "getLinkedBinding", "getInternalBinding", "primordials",
    `${realmSrc}\n//# sourceURL=node:internal/bootstrap/realm`
  );
  realmFn(processStub, getInternalBinding, getInternalBinding, primordials);
  phases.push("realm: COMPLETED");

  phase = "node";
  // 2. bootstrap/node.js — compiled with (process, require, internalBinding, primordials).
  const nodeSrc = srcOf("internal/bootstrap/node");
  const realmRequire = hostState.loaders?.require ?? requireBuiltin;
  const realmBinding = hostState.loaders?.internalBinding ?? getInternalBinding;
  const nodeFn = new Function(
    "process", "require", "internalBinding", "primordials",
    `${nodeSrc}\n//# sourceURL=node:internal/bootstrap/node`
  );
  nodeFn(processStub, realmRequire, realmBinding, primordials);
  phases.push("node: COMPLETED");

  phase = "switches";
  (hostState.loaders?.require ?? requireBuiltin)("internal/bootstrap/switches/is_main_thread");
  (hostState.loaders?.require ?? requireBuiltin)("internal/bootstrap/switches/does_own_process_state");
  phases.push("switches: COMPLETED");
} catch (e) {
  failure = { phase, message: e.message, stack: (e.stack ?? "").split("\n").slice(0, 14).join("\n") };
  phases.push(`${phase}: FAILED — ${e.message}`);
}

// ------------------------------------------------------------
// Report
// ------------------------------------------------------------
const bindingsTouched = [...new Set(trace.filter((t) => t.startsWith("<binding>.")).map((t) => t.slice(10)))];
const report = {
  vendoredVersion: index.version,
  primordialsProps: Object.getOwnPropertyNames(primordials).length,
  phases,
  bindingsTouchedInOrder: bindingsTouched,
  accessCount: trace.length,
  modulesLoaded: [...moduleCache.keys()],
  failure,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("\n=== S1 binding tracer report ===");
  console.log(`vendored lib: ${report.vendoredVersion}, primordials props: ${report.primordialsProps}`);
  for (const p of phases) console.log("  phase " + p);
  console.log(`bindings touched (${bindingsTouched.length}, in first-touch order):`);
  console.log("  " + bindingsTouched.join(" "));
  console.log(`modules loaded (${report.modulesLoaded.length}):`);
  console.log("  " + report.modulesLoaded.join(" "));
  console.log(`distinct property accesses: ${trace.length}`);
  if (failure) {
    console.log(`\nFIRST HARD FAILURE in phase '${failure.phase}': ${failure.message}`);
    console.log(failure.stack);
  }
}
