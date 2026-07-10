// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/wasm-runtime.mjs — main-thread driver for the wasm tier
// (UL-SPEC/wasm-tier). Registers a kind:"wasm" process, maps caps.fs.scopes to
// WASI preopens (structural capability enforcement, P1), wires stdio pipes,
// and runs a wasip1 module in its own Worker. This is what nano.wasm.run()
// calls and what the router's wasm spawn delegate uses.

import { spawnWorker } from "../platform.mjs";

const workerEntry = new URL("../wasm/worker-entry.mjs", import.meta.url).href;

// Compiled-Module cache keyed by content hash (UL-SPEC/wasm-tier §4.1 X5):
// repeat launches of the same artifact skip compilation. WebAssembly.Module is
// structured-cloneable, so the compiled module is handed to the worker.
const moduleCache = new Map();
function fnv1a(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h.toString(16); }
async function compileCached(bytes, key) {
  const k = key ?? "fnv:" + bytes.length + ":" + fnv1a(bytes);
  let entry = moduleCache.get(k);
  if (!entry) { entry = { module: await WebAssembly.compile(bytes), hits: 0 }; moduleCache.set(k, entry); }
  else entry.hits++;
  return { module: entry.module, cached: entry.hits > 0 };
}
function moduleCacheStats() { return { size: moduleCache.size, keys: [...moduleCache.keys()] }; }

/**
 * @param {import("../../../kernel/kernel.mjs").Kernel} kernel
 * @param {{ wasmBytes: Uint8Array, argv: string[], env?: object, cwd?: string,
 *           caps?: object, ppid?: number, preopens?: Array<{guestPath,hostPath,readonly}>,
 *           onStdout?: (b)=>void, timeoutMs?: number, _reuseProc?, _stdout?, _stderr?, _stdin? }} opts
 */
async function runWasm(kernel, opts) {
  const { wasmBytes, argv, env = {}, cwd = "/", caps, ppid = 1 } = opts;

  const stdin = opts._stdin ?? kernel.pipes.create();
  const stdout = opts._stdout ?? kernel.pipes.create();
  const stderr = opts._stderr ?? kernel.pipes.create();

  const proc = opts._reuseProc ?? kernel.registerProcess({
    kind: "wasm", argv, cwd, env: { ...env }, caps, ppid,
    stdio: [stdin.id, stdout.id, stderr.id],
  });

  // caps.fs.scopes → preopens (P1). Absent scopes → preopen "/" (trusted-dev).
  const preopens = opts.preopens ?? scopesToPreopens(proc.caps);

  const chan = kernel.allocChannel(proc.pid);

  let outBuf = "", errBuf = "";
  const dec = new TextDecoder();
  const drains = [];
  const hostDrains = !opts._reuseProc;
  const drain = (pipe, onData, append) => drains.push((async () => {
    for (;;) { const r = pipe.read(1 << 16); if (r === "eof") break; if (r) { append(dec.decode(r, { stream: true })); onData?.(r); } else await pipe.waitReadable(); }
  })());
  if (hostDrains) { drain(stdout, opts.onStdout, (s) => { outBuf += s; }); drain(stderr, null, (s) => { errBuf += s; }); }

  // Compile once, cache, and hand the compiled Module to the worker (X5).
  const { module, cached } = await compileCached(wasmBytes, opts.moduleKey);
  const init = {
    pid: chan.pid, token: chan.token, asyncPort: chan.port, channelSAB: chan.sab,
    argv, env: proc.env, preopens, wasiTrace: !!opts.trace,
    module,
    // Bytes are also sent for the memory-limit parse (threads); cheap.
    wasmBytes: wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength),
  };
  const worker = spawnWorker(workerEntry, init, [chan.port]);
  kernel.signals.registerTerminator(proc.pid, () => worker.terminate());

  const exit = await new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    worker.onMessage((m) => { if (m?.type === "exit") finish({ exitCode: m.code ?? 0, stats: m.stats }); else if (m?.type === "fatal") finish({ exitCode: 1, error: m.error }); });
    worker.onError((e) => finish({ exitCode: 1, error: String(e?.message ?? e) }));
    if (opts.timeoutMs) { const t = setTimeout(() => finish({ exitCode: 124, error: "timeout" }), opts.timeoutMs); if (t.unref) t.unref(); }
  });
  worker.terminate();
  if (hostDrains) { stdout.closeWrite(); stderr.closeWrite(); await Promise.all(drains); }
  if (!opts._reuseProc) kernel.proc.exit(proc.pid, exit.exitCode);
  kernel.releaseChannel(proc.pid);

  return { exitCode: exit.exitCode, stdout: outBuf + dec.decode(), stderr: errBuf, error: exit.error, pid: proc.pid, cached, stats: exit.stats };
}

function scopesToPreopens(caps) {
  const readonly = caps.fs.mode === "readonly";
  if (caps.fs.mode === "none") return [];
  const scopes = caps.fs.scopes ?? ["/"];
  return scopes.map((s) => ({ guestPath: s === "/" ? "/" : s.replace(/\/$/, ""), hostPath: s, readonly }));
}

export { runWasm, scopesToPreopens, moduleCacheStats, compileCached };
