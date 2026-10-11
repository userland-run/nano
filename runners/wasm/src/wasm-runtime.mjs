// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/wasm-runtime.mjs — main-thread driver for the wasm tier
// (UL-SPEC/wasm-tier). Registers a kind:"wasm" process, maps caps.fs.scopes to
// WASI preopens (structural capability enforcement, P1), wires stdio pipes,
// and runs a wasip1 module in its own Worker. This is what nano.wasm.run()
// calls and what the router's wasm spawn delegate uses.

import { spawnWorker } from "../../../kernel/platform.mjs";

const workerEntry = new URL("./worker-entry.mjs", import.meta.url).href;

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
 *           onStdout?: (b)=>void, onStderr?: (b)=>void, stdinBytes?: Uint8Array|string,
 *           timeoutMs?: number, _reuseProc?, _stdout?, _stderr?, _stdin? }} opts
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, stdoutBytes:Uint8Array,
 *           stderrBytes:Uint8Array, error?:string, pid:number, cached:boolean, stats?:object}>}
 */
async function runWasm(kernel, opts) {
  const { wasmBytes, argv, env = {}, cwd = "/", caps, ppid = 1 } = opts;

  const stdin = opts._stdin ?? kernel.pipes.create();
  const stdout = opts._stdout ?? kernel.pipes.create();
  const stderr = opts._stderr ?? kernel.pipes.create();

  // Feed a request payload to fd 0 for a per-invoke filter (the WASI service
  // runner): write the bytes and close the write end so fd_read sees EOF.
  // With no payload (and no caller-owned stdin pipe) stdin is EOF right away —
  // nobody else holds this pipe, so a read would otherwise block forever.
  if (!opts._stdin) {
    if (opts.stdinBytes != null) {
      const b = typeof opts.stdinBytes === "string" ? new TextEncoder().encode(opts.stdinBytes) : opts.stdinBytes;
      stdin.write(b);
    }
    stdin.closeWrite();
  }

  const proc = opts._reuseProc ?? kernel.registerProcess({
    kind: "wasm", argv, cwd, env: { ...env }, caps, ppid,
    stdio: [stdin.id, stdout.id, stderr.id],
  });

  // caps.fs.scopes → preopens (P1). Absent scopes → preopen "/" (trusted-dev).
  const preopens = opts.preopens ?? scopesToPreopens(proc.caps);

  const chan = kernel.allocChannel(proc.pid);

  // stdout/stderr are collected as raw bytes (binary-safe: an app may write a
  // PNG to stdout); the string forms are decoded once at the end.
  const outChunks = [], errChunks = [];
  const drains = [];
  const hostDrains = !opts._reuseProc;
  const drain = (pipe, onData, chunks) => drains.push((async () => {
    for (;;) { const r = pipe.read(1 << 16); if (r === "eof") break; if (r) { chunks.push(r); onData?.(r); } else await pipe.waitReadable(); }
  })());
  if (hostDrains) { drain(stdout, opts.onStdout, outChunks); drain(stderr, opts.onStderr, errChunks); }

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

  const stdoutBytes = joinChunks(outChunks), stderrBytes = joinChunks(errChunks);
  const dec = new TextDecoder();
  return {
    exitCode: exit.exitCode, stdout: dec.decode(stdoutBytes), stderr: dec.decode(stderrBytes),
    stdoutBytes, stderrBytes, error: exit.error, pid: proc.pid, cached, stats: exit.stats,
  };
}

function joinChunks(chunks) {
  if (chunks.length === 1) return chunks[0];
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Uint8Array(n); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function scopesToPreopens(caps) {
  const readonly = caps.fs.mode === "readonly";
  if (caps.fs.mode === "none") return [];
  const scopes = caps.fs.scopes ?? ["/"];
  return scopes.map((s) => ({ guestPath: s === "/" ? "/" : s.replace(/\/$/, ""), hostPath: s, readonly }));
}

export { runWasm, scopesToPreopens, moduleCacheStats, compileCached };
