// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/wasm/worker-entry.mjs — the wasm-tier worker (UL-SPEC/wasm-tier
// §4.1). Connects the Syscall Bus (hello + sync SAB), instantiates the
// wasip1 module with the WASI shim bound to the Kernel, and calls _start.

import { workerContext, spawnWorker } from "../../../kernel/platform.mjs";
import { BusClient } from "../../../kernel/bus/client.mjs";
import { SyncCaller } from "../../../kernel/bus/sab-channel.mjs";
import { createWasiShim } from "./wasi-shim.mjs";

const threadEntry = new URL("./thread-entry.mjs", import.meta.url).href;

const ctx = await workerContext();
const init = ctx.workerData;

try {
  const async = new BusClient({ pid: init.pid, token: init.token, asyncPort: init.asyncPort });
  await async.hello();
  const caller = new SyncCaller(init.channelSAB);
  const sync = (op, args) => caller.callSync(op, args);

  let instance = null;
  let exitCode = 0;
  // Syscall counters (UL-SPEC/wasm-tier §7 M3) — cheap, the only profiling
  // signal available without instrumenting the module.
  const counts = Object.create(null);
  const { shim, WasiExit } = createWasiShim({
    argv: init.argv,
    env: init.env,
    preopens: init.preopens ?? [],
    sync,
    getMemory: () => instance.exports.memory,
    onExit: (c) => { exitCode = c; },
    trace: init.wasiTrace ? (msg) => { try { sync("proc.stdio_write", { fd: 2, data: new TextEncoder().encode("[wasi] " + msg + "\n").buffer }); } catch {} } : null,
  });
  // Compiled module comes from the host cache (X5); fall back to compiling
  // bytes if only bytes were provided.
  const module = init.module ?? await WebAssembly.compile(new Uint8Array(init.wasmBytes));

  // wasip1-threads (X4): if the module imports a shared memory, create a
  // SAB-backed WebAssembly.Memory and share it with sibling thread workers.
  const memImport = WebAssembly.Module.imports(module).find((i) => i.kind === "memory");
  let sharedMemory = null;
  const threadWorkers = [];
  let nextTid = 1;
  if (memImport) {
    const desc = memoryDescriptor(new Uint8Array(init.wasmBytes ?? []), module);
    sharedMemory = new WebAssembly.Memory({ initial: desc.min, maximum: desc.max ?? desc.min, shared: true });
  }

  // wasi_thread_spawn(startArg) → tid: spawn a sibling worker that shares the
  // memory + module and runs wasi_thread_start(tid, startArg).
  shim.thread_spawn = shim["thread-spawn"] = (startArg) => {
    if (!sharedMemory) return -1; // ENOSYS-ish for a non-threaded module
    const tid = nextTid++;
    const w = spawnWorker(threadEntry, { module, memory: sharedMemory, tid, startArg }, []);
    threadWorkers.push(w);
    return tid;
  };

  // Wrap each shim fn to count invocations.
  const countedShim = {};
  for (const [k, v] of Object.entries(shim)) countedShim[k] = typeof v === "function" ? (...a) => { counts[k] = (counts[k] ?? 0) + 1; return v(...a); } : v;

  const imports = { wasi_snapshot_preview1: countedShim, wasi_unstable: countedShim };
  if (memImport) imports.env = { memory: sharedMemory };
  instance = await WebAssembly.instantiate(module, imports);

  try {
    if (typeof instance.exports._start === "function") instance.exports._start();
    else if (typeof instance.exports.main === "function") instance.exports.main();
  } catch (e) {
    if (e instanceof WasiExit) exitCode = e.code;
    else {
      // A wasm trap (unreachable/OOB) → exit 134 with the message on stderr (§4.1 X3).
      try { sync("proc.stdio_write", { fd: 2, data: new TextEncoder().encode(String(e?.message ?? e) + "\n").buffer }); } catch {}
      exitCode = 134;
    }
  }
  for (const w of threadWorkers) try { w.terminate(); } catch {}
  try { sync("proc.exit", { code: exitCode }); } catch {}
  const syscalls = Object.values(counts).reduce((a, b) => a + b, 0);
  const mem = instance?.exports?.memory ?? sharedMemory;
  ctx.post({ type: "exit", code: exitCode, stats: { syscalls, counts, threads: nextTid - 1, memoryPages: mem?.buffer ? mem.buffer.byteLength >> 16 : 0 } });
} catch (e) {
  ctx.post({ type: "fatal", error: (e && e.stack) ? e.stack : String(e) });
}

// Parse the imported memory's declared limits (min/max pages) from the module.
function memoryDescriptor(bytes, module) {
  const imp = WebAssembly.Module.imports(module).find((i) => i.kind === "memory");
  if (!imp) return { min: 1, max: 1 };
  // Walk the import section for the memory limits (shared modules → has-max).
  let i = 8;
  const readU32 = () => { let r = 0, s = 0, b; do { b = bytes[i++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  const skipName = () => { const n = readU32(); i += n; };
  while (i < bytes.length) {
    const id = bytes[i++]; const len = readU32(); const end = i + len;
    if (id === 2) {
      const count = readU32();
      for (let k = 0; k < count; k++) {
        skipName(); skipName(); const kind = bytes[i++];
        if (kind === 0) { readU32(); } // func: typeidx
        else if (kind === 1) { const f = bytes[i++]; readU32(); if (f & 1) readU32(); } // table
        else if (kind === 2) { const f = bytes[i++]; const min = readU32(); const max = (f & 0x01) ? readU32() : min; return { min, max }; } // memory
        else if (kind === 3) { i++; bytes[i - 1]; i++; } // global: valtype + mut
      }
    }
    i = end;
  }
  return { min: 1, max: 1 };
}
