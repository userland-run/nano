#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Sanity test for the two release wasms used by the app publish pipeline:
//   - wasm/nano.min.wasm   (built --no-default-features)         → NO syscall trace
//   - wasm/nano.trace.wasm (built --no-default-features --features trace) → syscall trace
//
// We run the same tiny ELF on both and assert the trace build emits debug_log
// tag-0x0A events (one per syscall) while the min build emits none. This proves
// the `trace` feature gate works, which is what makes nano.trace.wasm meaningful.
//
// Run via:  make test-trace   (builds both wasms first)
// Skips cleanly if the artifacts are not present.

import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const minPath = resolve(root, "wasm/nano.min.wasm");
const tracePath = resolve(root, "wasm/nano.trace.wasm");
const elfPath = resolve(__dirname, "hello.elf");

if (!existsSync(minPath) || !existsSync(tracePath)) {
  console.log("SKIP test_trace: build the artifacts first → `make build-min build-trace`");
  process.exit(0);
}

const elfBytes = readFileSync(elfPath);

// Run `elf` on the wasm at `wasmPath`; return how many tag-0x0A (syscall) events
// debug_log received during the run.
async function runOnce(wasmPath) {
  const wasmBytes = readFileSync(wasmPath);
  const RAM_MB = 256;
  // The module declares an initial of 3072 pages (192MB); the imported memory
  // must be at least that large.
  const ramPages = Math.max(3072, Math.floor((RAM_MB * 1024 * 1024) / 65536));
  const memory = new WebAssembly.Memory({ initial: ramPages, maximum: 32768, shared: true });

  let syscallEvents = 0;
  const imports = {
    env: {
      memory,
      abort_js() { throw new Error("abort_js() called"); },
      debug_log(v) {
        if (((v >>> 24) & 0xff) === 0x0a) syscallEvents++;
      },
      emscripten_random() { return 0.5; },          // seeded-ish; deterministic
      emscripten_date_now() { return 0; },          // frozen clock
      console_write() { /* swallow guest stdout/stderr */ },
    },
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const X = instance.exports;

  const vmPtr = X.vm_create(RAM_MB * 1024 * 1024);
  if (vmPtr === 0) throw new Error("vm_create failed");
  const ramPtr = X.vm_ram_ptr(vmPtr);

  new Uint8Array(memory.buffer).set(elfBytes, ramPtr);
  if (X.vm_load_elf(vmPtr, 0, elfBytes.length) !== 0) throw new Error("vm_load_elf failed");

  const dv = new DataView(memory.buffer);
  const A0 = vmPtr + 80;      // x[10]
  const STATUS = vmPtr + 528; // vm.status
  const BUDGET = 1_000_000;

  for (let iter = 0; iter < 1000; iter++) {
    X.vm_step(vmPtr, BUDGET);
    const status = X.debug_status(vmPtr);
    if (status === 3) break;             // exited / faulted
    if (status === 6) {                  // FS_PENDING — not expected for hello, fail safe
      dv.setBigInt64(A0, -38n, true);    // ENOSYS
      dv.setInt32(STATUS, 0, true);
      continue;
    }
    if (status === 7) {                  // EPOLL_BLOCKED
      dv.setBigInt64(A0, -4n, true);     // EINTR
      dv.setInt32(STATUS, 0, true);
      continue;
    }
  }
  return syscallEvents;
}

const minEvents = await runOnce(minPath);
const traceEvents = await runOnce(tracePath);

console.log(`min   build: ${minEvents} syscall trace events`);
console.log(`trace build: ${traceEvents} syscall trace events`);

let ok = true;
if (traceEvents <= 0) { console.error("FAIL: trace build emitted no 0x0A events"); ok = false; }
if (minEvents !== 0) { console.error("FAIL: min build emitted 0x0A events (feature gate leaked)"); ok = false; }

if (ok) { console.log("PASS test_trace"); process.exit(0); }
process.exit(1);
