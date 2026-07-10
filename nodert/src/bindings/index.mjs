// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/bindings/index.mjs — the internalBinding registry (spec §8.4).
// Backing sources: the VM-oracle fixtures (options/config/constants/errno,
// removing guesswork per S1), the host engine (buffer/encoding/util/crypto),
// and the Syscall Bus (fs/proc). Lazily instantiated + memoized. This is the
// ONLY nodert-specific code below the internalBinding line (P2).

const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

/**
 * @param {{ fixtures: object, syncCall: (op: string, args: object) => object,
 *           privateSymbols: object, hostState: object }} ctx
 */
function createBindings(ctx) {
  const { fixtures, syncCall, privateSymbols, hostState } = ctx;
  const cache = new Map();

  const factories = {
    config: () => ({
      isDebugBuild: false, openSSLIsBoringSSL: true, hasOpenSSL: true, fipsMode: false,
      hasIntl: true, hasTracing: false, hasNodeOptions: true, hasInspector: false,
      noBrowserGlobals: false, bits: 64, hasCachedBuiltins: false,
      ...(fixtures.config?.config ?? {}),
    }),

    constants: () => fixtures.constants?.constants ?? {},

    options: () => ({
      getCLIOptionsValues: () => ({ ...(fixtures.options?.values ?? {}) }),
      getCLIOptionsInfo: () => ({
        options: toMap(fixtures.options?.info?.options),
        aliases: toMap(fixtures.options?.info?.aliases),
      }),
      getEmbedderOptions: () => ({
        shouldNotRegisterESMLoader: false, noGlobalSearchPaths: false,
        noBrowserGlobals: false, hasEmbedderPreload: false,
        ...(fixtures.options?.embedder ?? {}),
      }),
      getEnvOptionsInputType: () => toMap(fixtures.options?.envOptionsInputType),
      getNamespaceOptionsInputType: () => toMap(fixtures.options?.namespaceOptionsInputType),
      getOptionsAsFlags: () => [],
      envSettings: fixtures.options?.envSettings ?? { kAllowedInEnvvar: 0, kDisallowedInEnvvar: 1 },
      types: fixtures.options?.types ?? {},
    }),

    uv: () => ({
      errname: (n) => (errMap().get(n) ?? ["UNKNOWN", ""])[0],
      getErrorMap: () => errMap(),
      UV_EOF: -4095,
    }),

    // --- host-backed primitives ---
    buffer: () => makeBufferBinding(),
    encoding_binding: () => makeEncodingBinding(),
    util: () => makeUtilBinding(privateSymbols),
    types: () => makeTypesBinding(),
    string_decoder: () => makeStringDecoderBinding(),
    icu: () => ({
      getStringWidth: (s) => String(s).length,
      icuErrName: () => "",
      toUnicode: (s) => s, toASCII: (s) => s,
      getConverter: () => null, transcode: (b) => b,
    }),

    // --- typed-array / loop bindings (real arrays; JS mutates in place) ---
    task_queue: () => ({
      tickInfo: hostState.tickInfo,
      promiseRejectEvents: { kPromiseRejectWithNoHandler: 0, kPromiseHandlerAddedAfterReject: 1, kPromiseResolveAfterResolved: 2, kPromiseRejectAfterResolved: 3 },
      setTickCallback: (cb) => { hostState.tickCallback = cb; },
      enqueueMicrotask: (cb) => queueMicrotask(cb),
      runMicrotasks: () => {},
      setPromiseRejectCallback: () => {},
    }),
    // async_wrap: enough async-hooks state for streams/AsyncResource. The two
    // typed arrays have separate index namespaces (hook fields vs id fields).
    async_wrap: () => {
      if (!hostState.asyncIdFields) {
        hostState.asyncHookFields = new Uint32Array(9);
        hostState.asyncIdFields = new Float64Array(4);
        hostState.asyncIdFields[0] = 1; // kExecutionAsyncId = 1 (main)
        hostState.asyncIdFields[2] = 1; // kAsyncIdCounter
        // The JS async-hooks layer pushes/pops execution+trigger ids here.
        hostState.asyncIdsStack = new Float64Array(1024);
      }
      return {
        async_hook_fields: hostState.asyncHookFields,
        async_id_fields: hostState.asyncIdFields,
        async_ids_stack: hostState.asyncIdsStack,
        execution_async_resources: [],
        constants: {
          kInit: 0, kBefore: 1, kAfter: 2, kDestroy: 3, kPromiseResolve: 4, kTotals: 5,
          kCheck: 6, kStackLength: 7, kUsesExecutionAsyncResource: 8,
          kExecutionAsyncId: 0, kTriggerAsyncId: 1, kAsyncIdCounter: 2, kDefaultTriggerAsyncId: 3,
        },
        setCallbackTrampoline: () => {},
        pushAsyncContext: () => {},
        popAsyncContext: () => true,
        clearAsyncIdStack: () => {},
        queueDestroyAsyncId: () => {},
        setPromiseHooks: () => {},
        registerDestroyHook: () => {},
        enablePromiseHook: () => {},
        disablePromiseHook: () => {},
      };
    },
    timers: () => ({
      immediateInfo: hostState.immediateInfo,
      timeoutInfo: hostState.timeoutInfo,
      getLibuvNow: () => hostState.uvNow(),
      setupTimers: (immediateCb, timerCb) => { hostState.immediateCallback = immediateCb; hostState.timerCallback = timerCb; },
      scheduleTimer: (ms) => hostState.scheduleTimer(ms),
      toggleTimerRef: (ref) => hostState.toggleTimerRef(ref),
      toggleImmediateRef: (ref) => hostState.toggleImmediateRef(ref),
    }),

    // --- process methods over the bus / host ---
    process_methods: () => ({
      cwd: () => hostState.cwd(),
      chdir: (d) => hostState.chdir(d),
      umask: () => 0o22,
      availableMemory: () => 1 << 30,
      constrainedMemory: () => 0,
      rss: () => 1 << 24,
      memoryUsage: () => new Float64Array(5),
      resourceUsage: () => new Float64Array(16),
      cpuUsage: () => new Float64Array(2),
      hrtime: () => {},
      hrtimeBigInt: () => hostState.hrtimeBigInt(),
      kill: (pid, sig) => hostState.kill(pid, sig),
      _debugProcess: () => {}, _debugEnd: () => {},
      reallyExit: (code) => hostState.exit(code),
      exitCodes: { kNoFailure: 0, kGenericUserError: 1, kInternalJSParseError: 3 },
      loadEnvFile: () => {},
      patchProcessObject: () => {},
    }),
    credentials: () => ({
      getuid: () => 0, geteuid: () => 0, getgid: () => 0, getegid: () => 0,
      getgroups: () => [0], safeGetenv: (k) => hostState.env()[k],
    }),

    // --- fs over the Syscall Bus (sync plane) ---
    fs: () => makeFsBinding(syncCall),

    // --- present-but-inert stubs (spec §8.4) ---
    trace_events: () => ({ isTraceCategoryEnabled: () => false, trace: () => {}, getCategoryEnabledBuffer: () => new Uint8Array(1), categoryGroupEnabled: () => false }),
    inspector: () => ({ consoleCall: () => {}, isEnabled: () => false, open: () => {}, close: () => {}, url: () => undefined }),
    report: () => ({ getReport: () => "{}", writeReport: () => "", shouldReportOnSignal: () => false }),
    contextify: () => makeContextifyBinding(),
    module_wrap: () => ({ ModuleWrap: class ModuleWrap {}, setImportModuleDynamicallyCallback: () => {}, setInitializeImportMetaObjectCallback: () => {} }),
    messaging: () => ({
      MessageChannel: globalThis.MessageChannel, MessagePort: globalThis.MessagePort,
      DOMException: globalThis.DOMException, // internal/util reads it from here
      setDeserializerCreateObjectFunction: () => {}, stopMessagePort: () => {}, checkMessagePort: () => false,
    }),
    worker: () => ({ threadId: hostState.pid ?? 0, isMainThread: true, ownsProcessState: true, getEnvMessagePort: () => null, Worker: class Worker {} }),
    symbols: () => makeSymbols(),
  };

  function errMap() {
    if (!cache.has("__errmap")) {
      const m = new Map();
      for (const [name, [errno, msg]] of Object.entries(fixtures.errno?.errno ?? {})) {
        m.set(errno, [name, msg]);
      }
      cache.set("__errmap", m);
    }
    return cache.get("__errmap");
  }

  const registry = (name) => {
    if (cache.has(name)) return cache.get(name);
    const factory = factories[name];
    const b = factory ? factory() : makeLoggingStub(name);
    cache.set(name, b);
    return b;
  };
  registry.has = (name) => name in factories;
  return registry;
}

function toMap(obj) {
  const m = new Map();
  if (obj) for (const [k, v] of Object.entries(obj)) m.set(k, v);
  return m;
}

function makeLoggingStub(name) {
  return new Proxy({}, {
    get(t, prop) {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => `[binding ${name}]`;
      if (typeof prop !== "string") return undefined;
      if (!(prop in t)) t[prop] = () => undefined;
      return t[prop];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

// ---- host-backed buffer / encoding ----
function makeBufferBinding() {
  return {
    kMaxLength: 4294967296,
    kStringMaxLength: (1 << 29) - 24,
    byteLengthUtf8: (str) => utf8.enc.encode(str).length,
    utf8WriteStatic: (buf, str, offset = 0, len) => {
      const bytes = utf8.enc.encode(str);
      const n = Math.min(bytes.length, len ?? bytes.length, buf.length - offset);
      buf.set(bytes.subarray(0, n), offset);
      return n;
    },
    latin1WriteStatic: (buf, str, offset = 0, len) => {
      const n = Math.min(str.length, len ?? str.length, buf.length - offset);
      for (let i = 0; i < n; i++) buf[offset + i] = str.charCodeAt(i) & 0xff;
      return n;
    },
    asciiWriteStatic: (buf, str, offset = 0, len) => {
      const n = Math.min(str.length, len ?? str.length, buf.length - offset);
      for (let i = 0; i < n; i++) buf[offset + i] = str.charCodeAt(i) & 0x7f;
      return n;
    },
    copy: (src, dst, dstOff = 0, srcStart = 0, srcEnd = src.length) => {
      const chunk = src.subarray(srcStart, srcEnd);
      const n = Math.min(chunk.length, dst.length - dstOff);
      dst.set(chunk.subarray(0, n), dstOff);
      return n;
    },
    compare: cmp,
    compareOffset: (a, b, aStart, bStart, aEnd, bEnd) => cmp(a.subarray(aStart, aEnd), b.subarray(bStart, bEnd)),
    fill: () => 0,
    indexOfBuffer: (haystack, needle, off, enc, dir) => bufIndexOf(haystack, needle, off, dir),
    indexOfNumber: (buf, val, off, dir) => (dir ? buf.indexOf(val, off) : buf.lastIndexOf(val, off < 0 ? buf.length + off : off)),
    indexOfString: () => -1,
    swap16: swapN(2), swap32: swapN(4), swap64: swapN(8),
    getZeroFillToggle: () => new Uint32Array(1),
    createUnsafeBuffer: (size) => new Uint8Array(size),
    zeroFill: new Uint32Array(1),
    detachArrayBuffer: () => {},
    copyArrayBuffer: (dest, destOff, src, srcOff, len) => new Uint8Array(dest).set(new Uint8Array(src, srcOff, len), destOff),
    isUtf8: () => true, isAscii: () => true, transcode: (b) => b,
    atob: (s) => globalThis.atob(s), btoa: (s) => globalThis.btoa(s),
  };
  function cmp(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  function bufIndexOf(hay, needle, off, dir) {
    if (needle.length === 0) return off <= hay.length ? off : hay.length;
    const start = off < 0 ? Math.max(0, hay.length + off) : off;
    if (dir) {
      outer: for (let i = start; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return i;
      }
    } else {
      outer: for (let i = Math.min(start, hay.length - needle.length); i >= 0; i--) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return i;
      }
    }
    return -1;
  }
  function swapN(n) {
    return (buf) => {
      for (let i = 0; i < buf.length; i += n) buf.subarray(i, i + n).reverse();
      return buf;
    };
  }
}

function makeEncodingBinding() {
  const b = {
    encodeUtf8String: (str) => utf8.enc.encode(str),
    encodeIntoResults: new Uint32Array(2),
    encodeInto: (str, dest) => {
      const r = utf8.enc.encodeInto(str, dest);
      b.encodeIntoResults[0] = r.read;
      b.encodeIntoResults[1] = r.written;
    },
    decodeUTF8: (bytes) => utf8.dec.decode(bytes),
    decodeLatin1: (bytes) => { let o = ""; for (const x of bytes) o += String.fromCharCode(x); return o; },
    toASCII: (s) => s, toUnicode: (s) => s,
  };
  return b;
}

function makeUtilBinding(privateSymbols) {
  return {
    privateSymbols,
    constants: {
      kExiting: 0, kExitCode: 1, kHasExitCode: 2, kArrowMessagePrivateSymbolIndex: 0, kDecoratedPrivateSymbolIndex: 1,
      // util.inspect destructures these from `util.constants`.
      ALL_PROPERTIES: 0, ONLY_WRITABLE: 1, ONLY_ENUMERABLE: 2, ONLY_CONFIGURABLE: 4, ONLY_ENUM_WRITABLE: 3, SKIP_STRINGS: 8, SKIP_SYMBOLS: 16,
      kPending: 0, kFulfilled: 1, kRejected: 2,
    },
    // Property filter constants match Node's util binding (bit flags).
    propertyFilter: { ALL_PROPERTIES: 0, ONLY_WRITABLE: 1, ONLY_ENUMERABLE: 2, ONLY_CONFIGURABLE: 4, ONLY_WRITABLE_AND_ENUMERABLE: 3, SKIP_STRINGS: 8, SKIP_SYMBOLS: 16 },
    // Own properties EXCLUDING array-index keys (so util.inspect doesn't
    // double-print array elements as properties). Respects the enumerable bit.
    getOwnNonIndexProperties: (o, filter = 0) => {
      const isIndex = (k) => { const n = +k; return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === k; };
      let names = Object.getOwnPropertyNames(o ?? {}).filter((k) => !isIndex(k));
      if (filter & 2) names = names.filter((k) => Object.getOwnPropertyDescriptor(o, k)?.enumerable);
      if (filter & 1) names = names.filter((k) => Object.getOwnPropertyDescriptor(o, k)?.writable);
      return names;
    },
    getConstructorName: (o) => o?.constructor?.name ?? "Object",
    getExternalValue: () => 0n,
    getPromiseDetails: () => [0, undefined], // host gap → util.inspect degradation (divergence)
    getProxyDetails: () => undefined,
    previewEntries: (o) => [[...o], false],
    createPrivateSymbol: (n) => Symbol(n),
    getHiddenValue: () => undefined, setHiddenValue: () => true,
    guessHandleType: () => "FILE",
    WeakReference: class WeakReference {
      constructor(v) { this._r = new WeakRef(v); }
      get() { return this._r.deref(); } incRef() {} decRef() {}
    },
    setPromiseHooks: () => {}, isInsideNodeModules: () => false,
    defineLazyProperties: (target, id, keys, enumerable = true) => {
      for (const key of keys) {
        let done = false, val;
        Object.defineProperty(target, key, {
          get() { if (!done) { val = globalThis.__nodert_require(id)[key]; done = true; } return val; },
          set(v) { val = v; done = true; },
          configurable: true, enumerable,
        });
      }
      return target;
    },
    sleep: () => {},
    toUSVString: (s) => s.toWellFormed?.() ?? s,
  };
}

// Native string_decoder binding: the state Buffer holds up to 4 pending bytes
// of an incomplete multibyte char plus bookkeeping. Field offsets are supplied
// to the upstream module, so nodert owns the layout. UTF-8 correct (the common
// case); latin1/ascii are trivial; utf16le buffers on odd byte counts.
function makeStringDecoderBinding() {
  const F = { kIncompleteChars: 0, kIncompleteEnd: 4, kMissingBytes: 4, kBufferedBytes: 5, kEncodingField: 6, kSize: 7 };
  const ENCODINGS = ["utf8", "ucs2", "utf16le", "latin1", "base64", "base64url", "ascii", "hex", "binary"];
  const dec = new TextDecoder("utf-8");

  const utf8SeqLen = (byte) => byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 0;

  return {
    kSize: F.kSize,
    kIncompleteCharactersStart: F.kIncompleteChars,
    kIncompleteCharactersEnd: F.kIncompleteEnd,
    kMissingBytes: F.kMissingBytes,
    kBufferedBytes: F.kBufferedBytes,
    kEncodingField: F.kEncodingField,
    encodings: ENCODINGS,
    decode(state, buf) {
      const enc = ENCODINGS[state[F.kEncodingField]] ?? "utf8";
      if (enc === "latin1" || enc === "binary" || enc === "ascii") {
        let s = ""; for (const b of buf) s += String.fromCharCode(enc === "ascii" ? b & 0x7f : b); return s;
      }
      if (enc === "utf16le" || enc === "ucs2") {
        const buffered = state[F.kBufferedBytes];
        let all = buffered ? concat(state.subarray(F.kIncompleteChars, F.kIncompleteChars + buffered), buf) : buf;
        const complete = all.length - (all.length % 2);
        let s = ""; for (let i = 0; i + 1 < complete; i += 2) s += String.fromCharCode(all[i] | (all[i + 1] << 8));
        const rem = all.length - complete;
        state[F.kBufferedBytes] = rem; if (rem) state[F.kIncompleteChars] = all[complete];
        return s;
      }
      // utf8
      const buffered = state[F.kBufferedBytes];
      let all = buffered ? concat(state.subarray(F.kIncompleteChars, F.kIncompleteChars + buffered), buf) : buf;
      // How many trailing bytes are an incomplete sequence?
      let incomplete = 0;
      for (let i = all.length - 1; i >= 0 && i >= all.length - 4; i--) {
        const need = utf8SeqLen(all[i]);
        if (need === 0) continue; // continuation byte
        if (i + need > all.length) incomplete = all.length - i;
        break;
      }
      const completeLen = all.length - incomplete;
      const out = dec.decode(all.subarray(0, completeLen));
      state[F.kBufferedBytes] = incomplete;
      for (let i = 0; i < incomplete; i++) state[F.kIncompleteChars + i] = all[completeLen + i];
      return out;
    },
    flush(state) {
      const buffered = state[F.kBufferedBytes];
      state[F.kBufferedBytes] = 0; state[F.kMissingBytes] = 0;
      if (!buffered) return "";
      const enc = ENCODINGS[state[F.kEncodingField]] ?? "utf8";
      const bytes = state.subarray(F.kIncompleteChars, F.kIncompleteChars + buffered);
      if (enc === "utf16le" || enc === "ucs2") return "";
      return dec.decode(bytes); // replacement char for a dangling utf8 sequence
    },
  };
  function concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
}

function makeTypesBinding() {
  const tag = (o) => Object.prototype.toString.call(o);
  return {
    isAnyArrayBuffer: (o) => o instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && o instanceof SharedArrayBuffer),
    isArrayBuffer: (o) => o instanceof ArrayBuffer,
    isSharedArrayBuffer: (o) => typeof SharedArrayBuffer !== "undefined" && o instanceof SharedArrayBuffer,
    isDate: (o) => tag(o) === "[object Date]",
    isMap: (o) => tag(o) === "[object Map]",
    isSet: (o) => tag(o) === "[object Set]",
    isRegExp: (o) => tag(o) === "[object RegExp]",
    isPromise: (o) => tag(o) === "[object Promise]",
    isTypedArray: (o) => ArrayBuffer.isView(o) && !(o instanceof DataView),
    isUint8Array: (o) => o instanceof Uint8Array,
    isDataView: (o) => o instanceof DataView,
    isNativeError: (o) => o instanceof Error,
    isProxy: () => false, isExternal: () => false,
    isModuleNamespaceObject: (o) => tag(o) === "[object Module]",
    isArgumentsObject: (o) => tag(o) === "[object Arguments]",
    isBoxedPrimitive: (o) => ["[object Number]", "[object String]", "[object Boolean]", "[object Symbol]", "[object BigInt]"].includes(tag(o)),
    isGeneratorObject: (o) => tag(o) === "[object Generator]",
    isAsyncFunction: (o) => tag(o) === "[object AsyncFunction]",
    isNumberObject: (o) => tag(o) === "[object Number]",
    isStringObject: (o) => tag(o) === "[object String]",
    isBooleanObject: (o) => tag(o) === "[object Boolean]",
  };
}

function makeContextifyBinding() {
  return {
    ContextifyScript: class ContextifyScript {
      constructor(code, filename, ...rest) { this._code = code; this._filename = filename; }
      runInThisContext() { return (0, eval)(this._code); }
      runInContext() { throw new Error("nodert: createContext deferred (§8.9)"); }
      createCachedData() { return new Uint8Array(0); }
    },
    ContextifyContext: class ContextifyContext {},
    compileFunction: (code, filename, lineOffset, colOffset, cachedData, produceCached, parsingContext, contextExtensions, params = []) => {
      const fn = new Function(...(Array.isArray(params) ? params : []), `${code}\n//# sourceURL=${filename}`);
      return { function: fn, cachedData: null, cachedDataProduced: false };
    },
    constants: { measureMemory: { mode: { SUMMARY: 0, DETAILED: 1 }, execution: { DEFAULT: 0, EAGER: 1 } }, contextify: {} },
    makeContext: () => {}, isContext: () => false, startSigintWatchdog: () => {}, stopSigintWatchdog: () => false,
  };
}

function makeSymbols() {
  const s = (n) => Symbol(n);
  return {
    owner_symbol: s("owner_symbol"), onpipe: s("onpipe"), oninit: s("oninit"),
    no_message_symbol: s("no_message_symbol"), handle_onclose: s("handle_onclose"),
    async_id_symbol: s("async_id_symbol"), trigger_async_id_symbol: s("trigger_async_id_symbol"),
    messaging_deserialize_symbol: s("messaging_deserialize_symbol"),
    messaging_transfer_symbol: s("messaging_transfer_symbol"),
    messaging_clone_symbol: s("messaging_clone_symbol"),
    messaging_transfer_list_symbol: s("messaging_transfer_list_symbol"),
  };
}

// fs binding over the sync bus plane — the subset internal/fs uses at load
// and the M0 corpus exercises.
function makeFsBinding(syncCall) {
  const open = (path, flags, mode) => syncCall("fs.open", { path, flags, mode }).fd;
  const close = (fd) => syncCall("fs.close", { fd });
  return {
    open, close,
    read: (fd, buffer, offset, length, position) => {
      const r = syncCall("fs.read", { fd, len: length, pos: position < 0 ? 0 : position });
      if (r.bytes > 0) buffer.set(new Uint8Array(r.data), offset);
      return r.bytes;
    },
    writeBuffer: (fd, buffer, offset, length, position) =>
      syncCall("fs.write", { fd, data: buffer.subarray(offset, offset + length), pos: position < 0 ? 0 : position }).bytes,
    writeString: (fd, string, position, encoding) =>
      syncCall("fs.write", { fd, data: utf8.enc.encode(string), pos: position < 0 ? 0 : position }).bytes,
    fstat: (fd) => { throw new Error("fstat by path only in M0"); },
    stat: (path) => toStat(syncCall("fs.stat", { path })),
    lstat: (path) => toStat(syncCall("fs.lstat", { path })),
    mkdir: (path, mode) => syncCall("fs.mkdir", { path, mode }),
    rmdir: (path) => syncCall("fs.unlink", { path, flags: 0x200 }),
    unlink: (path) => syncCall("fs.unlink", { path }),
    rename: (oldPath, newPath) => syncCall("fs.rename", { path: oldPath, path2: newPath }),
    readdir: (path) => syncCall("fs.readdir", { path }).names,
    realpath: (path) => syncCall("fs.realpath", { path }).path,
    readlink: (path) => syncCall("fs.readlink", { path }).target,
    symlink: (target, path) => syncCall("fs.symlink", { target, path }),
    link: (a, b) => syncCall("fs.link", { path: a, path2: b }),
    chmod: (path, mode) => syncCall("fs.chmod", { path, mode }),
    access: (path) => syncCall("fs.access", { path }),
    // Convenience fast-paths internal/fs uses:
    readFileUtf8: (path) => {
      const fd = open(path, 0, 0);
      try {
        const st = toStat(syncCall("fs.stat", { path }));
        const r = syncCall("fs.read", { fd, len: Number(st[8]), pos: 0 });
        return utf8.dec.decode(new Uint8Array(r.data));
      } finally { close(fd); }
    },
    internalModuleStat: (path) => {
      try { const st = toStat(syncCall("fs.stat", { path })); return isDirMode(st[1]) ? 1 : 0; }
      catch { return -2; }
    },
  };
  function toStat(o) {
    // Node's fs binding returns a Float64Array/BigUint64Array stat buffer;
    // internal/fs/utils builds Stats from it. Layout: [dev, mode, nlink, uid,
    // gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs].
    const a = new Float64Array(14);
    a[0] = 1; a[1] = o.mode; a[2] = o.nlink; a[6] = 4096; a[7] = o.ino;
    a[8] = o.size; a[9] = Math.ceil(o.size / 512);
    a[10] = a[11] = a[12] = a[13] = o.mtime * 1000;
    return a;
  }
  function isDirMode(mode) { return (mode & 0o170000) === 0o040000; }
}

export { createBindings };
