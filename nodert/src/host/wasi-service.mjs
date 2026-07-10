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

function toBytes(payload) {
  if (payload == null) return new Uint8Array(0);
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  if (typeof payload.body === "string") return new TextEncoder().encode(payload.body);
  if (payload.body instanceof Uint8Array) return payload.body;
  return new TextEncoder().encode(JSON.stringify(payload));
}

export { createWasiService, registerWasmServiceFromManifest };
