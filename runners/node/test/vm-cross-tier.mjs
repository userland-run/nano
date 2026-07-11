#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// The REAL cross-tier showcase (spec §12.3, UL-SPEC/applets): a live NanoVM
// (real emulated BusyBox) registered as the "vm" delegate, nodert as the
// "node" delegate, sharing ONE VFS. A nodert `execSync("sh -c …")` runs a
// cross-tier shell — busybox applets/pipelines in the emulator, `node …` at
// JIT speed in nodert — with files crossing freely between the tiers.
//
// Heavy: needs wasm/nano.wasm + images/busybox. Run directly:
//   node nodert/test/vm-cross-tier.mjs

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices, materializePackages } from "../../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";
import { registerNodertDelegate } from "../src/host/delegate.mjs";
import { createVmDelegate } from "../src/host/vm-delegate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(here, "..", "..", "wasm", "nano.wasm");
const busyboxPath = join(here, "..", "..", "images", "busybox");

if (!existsSync(wasmPath) || !existsSync(busyboxPath)) {
  console.log(`  SKIP: real-VM cross-tier (missing ${existsSync(wasmPath) ? "images/busybox" : "wasm/nano.wasm"})`);
  process.exit(0);
}

const { NanoVM } = await import("../../../container/nanovm.mjs");

let passed = 0, failed = 0;

const kernel = new Kernel();
await registerBuiltinServices(kernel);
registerNodertDelegate(kernel);
await createVmDelegate(kernel, { NanoVM, wasm: readFileSync(wasmPath), busybox: readFileSync(busyboxPath), ramMB: 512 });

async function run(name, opts, expect, expectExit = 0) {
  const argv = opts.entryPath ? ["node", opts.entryPath] : ["node", "-e", opts.source];
  const r = await runNode(kernel, { argv, source: opts.source, entryPath: opts.entryPath, cwd: opts.cwd ?? "/", env: {}, timeoutMs: 90000 });
  const ok = typeof expect === "function" ? expect(r.stdout) : r.stdout === expect;
  if (ok && r.exitCode === expectExit) { passed++; console.log(`  PASS: ${name}`); }
  else {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    exit ${r.exitCode} (want ${expectExit}) stdout ${JSON.stringify(r.stdout)}`);
    if (r.stderr) console.error(`    stderr ${r.stderr.split("\n").slice(0, 3).join(" | ")}`);
  }
}

// 1. real BusyBox applet pipeline
await run("real busybox pipeline (echo | tr)",
  { source: `process.stdout.write(require("child_process").execSync("echo hello world | tr a-z A-Z", { encoding: "utf8" }))` },
  "HELLO WORLD\n");

// 2. the §12.3 chain: node → sh → node, real busybox + real nodert
await run("node → real-sh → node (busybox echo + nodert node)",
  { source: `process.stdout.write(require("child_process").execSync("echo start && node -e \\"console.log(6*7)\\" && echo end", { encoding: "utf8" }))` },
  "start\n42\nend\n");

// 3. shared VFS: nodert writes → busybox transforms → nodert reads
await run("shared VFS handoff (nodert → busybox → nodert)",
  { source: `
    const fs = require("fs"), cp = require("child_process");
    fs.writeFileSync("/tmp/in.txt", "banana\\napple\\ncherry\\n");
    cp.execSync("sort /tmp/in.txt > /tmp/out.txt");     // real busybox sort
    process.stdout.write("sorted: " + fs.readFileSync("/tmp/out.txt", "utf8").trim().replace(/\\n/g, ","));
  ` },
  "sorted: apple,banana,cherry");

// 4. npm run build with real busybox sh + a CAS dependency
kernel.vfs.mkdir("/proj", 0o755);
await materializePackages(kernel, "/proj", {
  "upcase": { packageJson: { name: "upcase", version: "1.0.0", main: "index.js" }, files: { "index.js": { bytes: new TextEncoder().encode(`module.exports = (s) => s.toUpperCase();`) }, "package.json": { bytes: new TextEncoder().encode(`{"name":"upcase","version":"1.0.0","main":"index.js"}`) } } },
});
kernel.vfs.rootMem.createFile("/proj/build.js", `const up = require("upcase"); require("fs").writeFileSync("/proj/out.txt", up("built via cross-tier"))`);
kernel.vfs.rootMem.createFile("/proj/run.js", `
  const cp = require("child_process"), fs = require("fs");
  cp.execSync("echo building… && node build.js", { cwd: "/proj" });   // busybox echo + nodert node
  process.stdout.write(fs.readFileSync("/proj/out.txt", "utf8"));
`);
await run("npm run build (real busybox sh + CAS dep + nodert node)",
  { entryPath: "/proj/run.js", cwd: "/proj" },
  "BUILT VIA CROSS-TIER");

console.log(`\n=== real-VM cross-tier: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
