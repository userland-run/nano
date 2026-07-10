// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/wasi-service.mjs — the WASI SERVICE RUNNER (UL-SPEC/wasm-tier
// §9 / plan §13: "WASI service runner (fd, ripgrep) … plugs into the routing
// table"). Wraps a wasm32-wasip1 module as a Kernel Service reachable over the
// svc.* bus, so a catalog kind:"wasm-service" artifact (fd, ripgrep, an
// esbuild-style filter) becomes callable by any tier without landing on PATH.
//
// Model: a service invocation runs the module ONCE as a wasip1 filter —
//   request bytes → fd 0 (stdin);  method + params → argv;  fd 1 (stdout) →
//   the response. This reuses the whole wasm tier (caps→preopens, the WASI
//   shim, the module cache) with zero new ABI. Stateless per call, which fits
//   process-per-request CLI tools; a persistent-instance variant (SWC-style)
//   can register under the same contract later.

import { runWasm } from "./wasm-runtime.mjs";

/**
 * Wrap a wasip1 module as a Kernel Service object (id/version/kind/methods/
 * invoke), suitable for kernel.services.register().
 *
 * @param {import("../../../kernel/kernel.mjs").Kernel} kernel
 * @param {{ id: string, wasmBytes: Uint8Array, version?: string, methods?: string[],
 *           argvPrefix?: string[], caps?: object, encoding?: "utf8"|"bytes",
 *           timeoutMs?: number, moduleKey?: string }} cfg
 */
function createWasiService(kernel, cfg) {
  const id = cfg.id;
  const encoding = cfg.encoding ?? "utf8";
  const methods = cfg.methods ?? ["run"];
  const moduleKey = cfg.moduleKey ?? `wasi-svc:${id}@${cfg.version ?? "0"}`;

  return {
    id,
    version: cfg.version ?? "0.0.0",
    kind: "wasm-service",
    methods,
    /**
     * Run the module as a filter. `payload` is the request body (string/bytes/
     * JSON-serializable); `method` and any `payload.args` become argv so a tool
     * can branch (e.g. ripgrep flags). Returns the stdout — a string (utf8) or
     * the raw combined bytes, per `encoding`.
     */
    async invoke(method, payload) {
      const args = Array.isArray(payload?.args) ? payload.args.map(String) : [];
      const argv = [...(cfg.argvPrefix ?? [id]), method, ...args];
      const stdinBytes = toBytes(payload);
      const r = await runWasm(kernel, {
        wasmBytes: cfg.wasmBytes,
        argv,
        caps: cfg.caps,
        stdinBytes,
        moduleKey,
        timeoutMs: cfg.timeoutMs ?? 30000,
      });
      const out = encoding === "bytes" ? r.stdout : r.stdout; // runWasm returns a string
      if (r.exitCode !== 0) {
        return { ok: false, exitCode: r.exitCode, stdout: out, stderr: r.stderr };
      }
      return { ok: true, exitCode: 0, stdout: out };
    },
    available: () => true,
  };
}

/**
 * Register a wasm-service from its signed catalog manifest (wasm-tier D1):
 * kind must be "wasm-service"; the module bytes come from the installed VFS
 * (or are passed in). name → service id, entrypoint.argv[0] → argvPrefix.
 * Returns the unregister fn from the registry.
 *
 * @param {import("../../../kernel/kernel.mjs").Kernel} kernel
 * @param {{ name: string, version?: string, kind?: string, entrypoint?: { argv?: string[] } }} manifest
 * @param {Uint8Array} wasmBytes
 * @param {{ methods?: string[], caps?: object }} [opts]
 */
function registerWasmServiceFromManifest(kernel, manifest, wasmBytes, opts = {}) {
  if ((manifest.kind ?? "elf-app") !== "wasm-service") {
    throw new Error(`registerWasmServiceFromManifest: manifest '${manifest.name}' is not kind:"wasm-service"`);
  }
  const svc = createWasiService(kernel, {
    id: manifest.name,
    version: manifest.version,
    wasmBytes,
    methods: opts.methods ?? manifest.methods ?? ["run"],
    argvPrefix: manifest.entrypoint?.argv ?? [manifest.name],
    caps: opts.caps,
  });
  return kernel.services.register(svc);
}

/**
 * A PERSISTENT / WARM wasm service (W-3 tail; the SWC-style variant). Unlike
 * createWasiService (a fresh per-invoke wasip1 command filter), this
 * instantiates the module ONCE and reuses it, so its memory/state persists
 * across invokes. Intended for pure-compute REACTORS (`_initialize`, no
 * `_start`) — each `svc.invoke(method, payload)` calls the export named
 * `method`. Runs on the calling thread (no WASI I/O); a module that imports
 * wasi gets a minimal no-op shim.
 *
 * @param {import("../../../kernel/kernel.mjs").Kernel} kernel
 * @param {{ id: string, wasmBytes: Uint8Array, version?: string, methods?: string[],
 *           imports?: object, decode?: (result:any, exports:object)=>any }} cfg
 */
function createWarmWasmService(kernel, cfg) {
  let instance = null;
  let initPromise = null;
  async function ensure() {
    if (instance) return instance;
    if (!initPromise) initPromise = (async () => {
      const module = await WebAssembly.compile(cfg.wasmBytes);
      const imports = cfg.imports ?? noopWasiImports(module);
      instance = await WebAssembly.instantiate(module, imports);
      if (typeof instance.exports._initialize === "function") instance.exports._initialize();
      return instance;
    })();
    return initPromise;
  }
  return {
    id: cfg.id,
    version: cfg.version ?? "0.0.0",
    kind: "wasm-service",
    persistent: true,
    methods: cfg.methods ?? ["run"],
    async invoke(method, payload) {
      const inst = await ensure();
      const fn = inst.exports[method];
      if (typeof fn !== "function") {
        throw new KernelErrorLite(`warm service '${cfg.id}' has no export '${method}'`);
      }
      const args = Array.isArray(payload?.args) ? payload.args : (payload == null ? [] : [payload]);
      const result = fn(...args);
      return { ok: true, result: cfg.decode ? cfg.decode(result, inst.exports) : result };
    },
    /** Whether the module has been instantiated (warm). */
    isWarm: () => !!instance,
    /** Drop the instance so the next invoke re-instantiates (cold). */
    reset() { instance = null; initPromise = null; },
    available: () => true,
  };
}

// A wasip1 reactor doing only compute needs no real WASI; give any declared
// wasi import a no-op so instantiation succeeds. (I/O reactors should use the
// worker-backed per-invoke runner instead.)
function noopWasiImports(module) {
  const imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    (imports[imp.module] ??= {});
    if (imp.kind === "function") imports[imp.module][imp.name] = () => 0;
    else if (imp.kind === "memory") imports[imp.module][imp.name] = new WebAssembly.Memory({ initial: 1 });
  }
  return imports;
}

class KernelErrorLite extends Error {}

function toBytes(payload) {
  if (payload == null) return new Uint8Array(0);
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  if (typeof payload.body === "string") return new TextEncoder().encode(payload.body);
  if (payload.body instanceof Uint8Array) return payload.body;
  return new TextEncoder().encode(JSON.stringify(payload));
}

export { createWasiService, createWarmWasmService, registerWasmServiceFromManifest };
