#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// Real-tools proof: the ACTUAL TypeScript compiler (typescript@5.x lib/_tsc.js,
// ~6MB of bundled CJS) runs on the nodert HOST ENGINE — not the RISC-V
// emulator. `tsc --version` and a real .ts → .js compile with the bundled
// lib.*.d.ts staged into the shared Kernel VFS. This exercises the CJS loader
// at scale, the fd-based fs ops (openSync/writeSync — tsc writes output through
// an fd), and enough of the process/os/path/util surface to boot the compiler.
//
// Skips gracefully if a typescript checkout isn't reachable (nano-only CI).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices } from "../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(here, "..", "..", "..", "sdk", "node_modules", "typescript", "lib"),
  join(here, "..", "..", "node_modules", "typescript", "lib"),
  join(here, "..", "node_modules", "typescript", "lib"),
];
const libDir = CANDIDATES.find((d) => existsSync(join(d, "_tsc.js")));

if (!libDir) {
  console.log("  SKIP: typescript lib not found (no sibling sdk/node_modules/typescript) — nano-only CI");
  console.log("\n=== nodert real-tool: tsc (SKIPPED) ===");
  process.exit(0);
}

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
function assertEqual(a, b, m) { if (a !== b) { console.error(`  FAIL: ${current} - ${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

// Stage the compiler + all bundled lib.*.d.ts at the VFS root (tsc resolves the
// default lib next to _tsc.js → "/lib.*.d.ts").
function stageTsc(k) {
  k.vfs.rootMem.createFile("/tsc.js", readFileSync(join(libDir, "_tsc.js"), "utf8"));
  for (const f of readdirSync(libDir)) {
    if (f.startsWith("lib.") && f.endsWith(".d.ts")) k.vfs.rootMem.createFile("/" + f, readFileSync(join(libDir, f), "utf8"));
  }
}
async function newKernel() { const k = new Kernel(); await registerBuiltinServices(k); stageTsc(k); return k; }

const tscVersion = JSON.parse(readFileSync(join(libDir, "..", "package.json"), "utf8")).version;

await test("tsc --version runs on the host engine", async () => {
  const k = await newKernel();
  const r = await runNode(k, { argv: ["node", "/tsc.js", "--version"], entryPath: "/tsc.js", cwd: "/", env: {}, timeoutMs: 60000 });
  assertEqual(r.exitCode, 0, "exit 0");
  assertEqual(r.stdout.trim(), `Version ${tscVersion}`, "prints the real version");
});

await test("tsc compiles a .ts to .js cleanly (types checked against staged libs)", async () => {
  const k = await newKernel();
  k.vfs.mkdir("/proj", 0o755);
  k.vfs.rootMem.createFile("/proj/app.ts", "const greet = (n: string): string => `hi ${n}`;\nconsole.log(greet('nodert'));\nexport {};\n");
  const r = await runNode(k, {
    argv: ["node", "/tsc.js", "--outDir", "/proj/out", "--target", "es2019", "--module", "commonjs", "--lib", "es2019,dom", "/proj/app.ts"],
    entryPath: "/tsc.js", cwd: "/proj", env: {}, timeoutMs: 180000,
  });
  assertEqual(r.exitCode, 0, `clean compile (stdout: ${JSON.stringify(r.stdout.slice(0, 300))})`);
  const js = new TextDecoder().decode(k.vfs.rootMem.resolve("/proj/out/app.js").data);
  assert(js.includes("const greet = (n) => `hi ${n}`;"), "types stripped, arrow preserved");
  assert(js.includes('console.log(greet(\'nodert\'))'), "body emitted");
  assert(js.includes('"use strict"'), "commonjs preamble");
});

await test("tsc reports a real type error (exit 2) with the diagnostic", async () => {
  const k = await newKernel();
  k.vfs.mkdir("/p2", 0o755);
  k.vfs.rootMem.createFile("/p2/bad.ts", "const n: number = 'not a number';\nexport {};\n");
  const r = await runNode(k, {
    argv: ["node", "/tsc.js", "--outDir", "/p2/out", "--target", "es2019", "--lib", "es2019", "/p2/bad.ts"],
    entryPath: "/tsc.js", cwd: "/p2", env: {}, timeoutMs: 180000,
  });
  assertEqual(r.exitCode, 2, "type error exit code");
  assert(r.stdout.includes("TS2322"), `TS2322 not assignable (stdout: ${JSON.stringify(r.stdout.slice(0, 200))})`);
});

console.log(`\n=== nodert real-tool: tsc ${tscVersion} on the host engine: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
