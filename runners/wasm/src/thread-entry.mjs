// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/wasm/thread-entry.mjs — a wasip1-threads sibling thread
// (UL-SPEC/wasm-tier §4.1 X4). Receives the compiled module + the SHARED
// WebAssembly.Memory + { tid, startArg }, re-instantiates the module against
// the same shared memory, and calls the module's exported
// wasi_thread_start(tid, startArg). Threads share the process's memory (true
// parallelism via the SAB); their own WASI syscalls are minimal here — a
// sibling that needs fs/stdio would carry its own bus client (deferred).

import { workerContext } from "../../../kernel/platform.mjs";

const ctx = await workerContext();
const init = ctx.workerData;

try {
  // A minimal shim for the thread: proc_exit/thread ops are no-ops; the thread
  // touches shared memory directly. (fd_* etc. would need a bus client — the
  // minimal threads model has the thread do memory work only.)
  const shim = new Proxy({}, { get: () => (() => 0) });
  const imports = {
    wasi_snapshot_preview1: shim,
    wasi_unstable: shim,
    env: { memory: init.memory },
  };
  const instance = await WebAssembly.instantiate(init.module, imports);
  instance.exports.wasi_thread_start?.(init.tid, init.startArg);
  ctx.post({ type: "thread-done", tid: init.tid });
} catch (e) {
  ctx.post({ type: "thread-error", tid: init.tid, error: String(e?.message ?? e) });
}
