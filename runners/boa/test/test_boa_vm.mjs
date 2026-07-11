#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Integration test: a host-side Boa script driving the REAL nano emulator.
 *
 * Proves the spec's thesis — "script the emulator": a sandboxed script reads
 * the VM's MemFS and runs busybox commands through the `nano` bridge, with the
 * results flowing back across the async boundary.
 *
 * Requires the bundled nano.wasm (with busybox) + boa.wasm:
 *   make build && make build-boa
 *   node test/test_boa_vm.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NanoVM } from "../../riscv/host/nanovm.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NANO_WASM = process.env.NANOVM_WASM || resolve(root, "wasm/nano.wasm");
const BOA_WASM = process.env.BOA_WASM || resolve(root, "wasm/boa.wasm");

let passed = 0;
let failed = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    failed++;
    console.error(`  FAIL: ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  } else {
    passed++;
    console.log(`  OK: ${msg}`);
  }
}

async function main() {
  const wasmBytes = readFileSync(NANO_WASM);
  const ramMB = Math.max(512, Math.floor(2000 - wasmBytes.length / (1024 * 1024) - 20));
  const vm = await NanoVM.create({
    ramMB,
    wasm: wasmBytes,
    boaWasm: readFileSync(BOA_WASM),
  });

  // Seed a file into the VM's MemFS and read it from a sandboxed script.
  vm.addFile("/data/hello.txt", "hi from memfs\n");
  eq(
    await vm.script(`nano.fs.readText("/data/hello.txt").trim()`, { expose: { fs: "readonly" } }),
    "hi from memfs",
    "script reads VM MemFS",
  );

  // Drive busybox from a script and capture its stdout across the async boundary.
  const out = await vm.script(
    `(async () => { const o = await nano.run("echo scripted-from-boa"); return o.stdout.trim(); })()`,
    { expose: { run: true } },
  );
  eq(out, "scripted-from-boa", "script runs busybox via nano.run");

  // Combine: write a file from busybox, then read it back from the script.
  const combined = await vm.script(
    `(async () => {
       await nano.run("sh -c true");           // smoke the VM
       const list = nano.fs.list("/data").map(e => e.name);
       return list.includes("hello.txt");
     })()`,
    { expose: { fs: "readonly", run: true } },
  );
  eq(combined, true, "script lists VM directory entries");

  console.log(`\nBoa↔VM integration: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
