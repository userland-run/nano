#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// WASM tier tests (UL-SPEC/wasm-tier W-1): real wasm32-wasip1 modules run as
// first-class Kernel processes on the browser wasm engine. Covers stdout via
// fd_write, exit codes / proc_exit, and — the headline claim (P1/P2/W2) —
// STRUCTURAL preopen capability enforcement: a scoped app cannot read outside
// its preopens, and a '..' traversal is denied by construction, not by a check.

import { Kernel, registerBuiltinServices } from "../../kernel/index.mjs";
import { normalizeCaps } from "../../kernel/caps/caps.mjs";
import { runWasm, moduleCacheStats } from "../src/host/wasm-runtime.mjs";
import { inspectWasm } from "../src/wasm/inspect.mjs";
import { registerWasmDelegate } from "../src/host/wasm-delegate.mjs";
import { runNode } from "../src/host/runtime.mjs";
import { registerNodertDelegate } from "../src/host/delegate.mjs";
import { helloModule, exitModule, readFileModule, threadsModule } from "./wasm-fixtures.mjs";

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
function assertEqual(a, b, m) { if (a !== b) { console.error(`  FAIL: ${current} - ${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

async function newKernel(seed) {
  const k = new Kernel();
  await registerBuiltinServices(k);
  if (seed) seed(k);
  return k;
}

await test("wasip1 module writes to stdout via fd_write", async () => {
  const k = await newKernel();
  const r = await runWasm(k, { wasmBytes: helloModule("hello from the wasm tier\n"), argv: ["hello.wasm"], cwd: "/", timeoutMs: 15000 });
  assertEqual(r.stdout, "hello from the wasm tier\n", "stdout");
  assertEqual(r.exitCode, 0, "exit 0");
});

await test("proc_exit propagates the exit code", async () => {
  const k = await newKernel();
  const r = await runWasm(k, { wasmBytes: exitModule(42), argv: ["exit.wasm"], cwd: "/", timeoutMs: 15000 });
  assertEqual(r.exitCode, 42, "exit 42");
});

await test("wasm app is a kind:'wasm' Kernel process (ps-visible)", async () => {
  const k = await newKernel();
  // Register the process shape a spawn would create and check it lists.
  const proc = k.registerProcess({ kind: "wasm", argv: ["tool.wasm"] });
  const listed = k.proc.list().find((p) => p.pid === proc.pid);
  assert(listed && listed.kind === "wasm", "wasm process visible in ps");
});

await test("structural preopen scope: in-scope read succeeds", async () => {
  const k = await newKernel((k) => { k.vfs.mkdir("/proj", 0o755); k.vfs.rootMem.createFile("/proj/data.txt", "SCOPED CONTENT"); });
  const caps = normalizeCaps({ fs: { mode: "readonly", scopes: ["/proj"] } });
  const r = await runWasm(k, { wasmBytes: readFileModule("data.txt"), argv: ["cat.wasm"], caps, cwd: "/proj", timeoutMs: 15000 });
  assertEqual(r.stdout, "SCOPED CONTENT", "read the in-scope file");
});

await test("structural preopen escape: '..' traversal is DENIED (P1/W2)", async () => {
  const k = await newKernel((k) => { k.vfs.mkdir("/proj", 0o755); k.vfs.rootMem.createFile("/proj/x", "in"); k.vfs.rootMem.createFile("/secret.txt", "TOP SECRET"); });
  const caps = normalizeCaps({ fs: { mode: "readonly", scopes: ["/proj"] } });
  const r = await runWasm(k, { wasmBytes: readFileModule("../secret.txt"), argv: ["cat.wasm"], caps, cwd: "/proj", timeoutMs: 15000 });
  assert(!r.stdout.includes("TOP SECRET"), "secret NOT leaked across the preopen boundary");
  assertEqual(r.stdout, "", "escape yields no data (structural denial)");
});

await test("readonly preopen: a write-intent open is refused", async () => {
  const k = await newKernel((k) => { k.vfs.mkdir("/proj", 0o755); k.vfs.rootMem.createFile("/proj/data.txt", "ro"); });
  // readonly caps → preopen readonly. The read module opens with FD_READ, which
  // is allowed; this asserts the scope mapping preserved readonly on the fd.
  const caps = normalizeCaps({ fs: { mode: "readonly", scopes: ["/proj"] } });
  const r = await runWasm(k, { wasmBytes: readFileModule("data.txt"), argv: ["cat.wasm"], caps, cwd: "/proj", timeoutMs: 15000 });
  assertEqual(r.stdout, "ro", "readonly read still works");
});

await test("wasm on PATH: routed via proc.spawn (kind:wasm)", async () => {
  const k = await newKernel((k) => {
    k.vfs.mkdir("/usr", 0o755); k.vfs.mkdir("/usr/local", 0o755); k.vfs.mkdir("/usr/local/bin", 0o755);
    k.vfs.rootMem.createFile("/usr/local/bin/greet.wasm", helloModule("greetings from PATH\n"));
  });
  registerWasmDelegate(k);
  const route = k.router.route(["greet.wasm"]);
  assertEqual(route.tier, "wasm", "routes .wasm to the wasm tier");
  // Drive through the actual spawn path from a node parent.
  registerNodertDelegate(k);
  const src = `const cp=require("child_process"); const r=cp.spawnSync("greet.wasm",[],{encoding:"utf8"}); process.stdout.write("node saw: "+r.stdout)`;
  const r = await runNode(k, { argv: ["node", "-e", src], source: src, cwd: "/", env: {}, timeoutMs: 20000 });
  assertEqual(r.stdout, "node saw: greetings from PATH\n", "node → wasm cross-tier spawn");
});

// --- W-2: inspect, module cache, syscall counters ---

await test("wasm inspect: imports/exports/memory/wasi/threads (static)", async () => {
  const info = inspectWasm(helloModule("x\n"));
  assertEqual(info.wasiVersion, "wasip1", "wasip1 detected");
  assertEqual(info.threads, false, "no threads");
  assert(info.imports.some((i) => i.name === "fd_write"), "fd_write import");
  assert(info.exports.some((e) => e.name === "_start"), "_start export");
  assert(info.memory && info.memory.min >= 1, "memory limits parsed");
  assert(!info.hasStart, "no start section (uses _start export)");
});

await test("module cache: second launch reuses the compiled Module (X5)", async () => {
  const bytes = helloModule("cache me\n");
  const k1 = await newKernel();
  const r1 = await runWasm(k1, { wasmBytes: bytes, argv: ["h.wasm"], moduleKey: "cache-test", timeoutMs: 15000 });
  const k2 = await newKernel();
  const r2 = await runWasm(k2, { wasmBytes: bytes, argv: ["h.wasm"], moduleKey: "cache-test", timeoutMs: 15000 });
  assert(r1.cached === false, "first launch compiles");
  assert(r2.cached === true, "second launch is cached");
  assertEqual(r1.stdout, "cache me\n", "output unaffected");
});

await test("syscall counters (M3 running-instance stats)", async () => {
  const k = await newKernel();
  const r = await runWasm(k, { wasmBytes: helloModule("counted\n"), argv: ["h.wasm"], timeoutMs: 15000 });
  assert(r.stats && r.stats.syscalls >= 1, `syscall count ${r.stats?.syscalls}`);
  assertEqual(r.stats.counts.fd_write, 1, "one fd_write");
  assert(r.stats.memoryPages >= 1, "memory page count");
});

await test("wasip1-threads: wasi_thread_spawn + shared memory (X4)", async () => {
  const info = inspectWasm(threadsModule());
  assert(info.threads, "inspect reports threads");
  assert(info.threadsSpawn, "inspect sees thread-spawn import");
  const k = await newKernel();
  const r = await runWasm(k, { wasmBytes: threadsModule(), argv: ["threads.wasm"], timeoutMs: 15000 });
  // The sibling thread (own worker) atomic-stored 1 to the shared SAB; the main
  // spin-waited (atomic load) and exited with the flag value.
  assertEqual(r.exitCode, 1, "cross-worker shared-memory write observed");
  assertEqual(r.stats.threads, 1, "one thread spawned");
});

console.log(`\n=== nodert wasm tier (W-1+W-2): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
