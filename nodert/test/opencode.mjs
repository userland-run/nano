#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// Real-app proof: the actual opencode agent CLI (its 16MB minified-ESM serve
// bundle) runs on the nodert HOST ENGINE. This is the "run-via-nodert" half of
// the install-via-VM / run-via-nodert flow — once opencode is on the shared
// VFS (installed/built by the VM tier or staged), the fast host-engine tier
// runs its CLI. Exercises the ESM loader at real scale (es-module-lexer),
// large-module loading, the permissive builtin facade, node:module/createRequire,
// child_process, fs (incl. Node-compatible error .code), and i18n/yargs.
//
// Skips if the opencode assets aren't present (they live in terminal/).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices } from "../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OC = [
  join(here, "..", "..", "..", "terminal", "public", "opencode"),
  join(here, "..", "..", "..", "terminal", "dist", "opencode"),
].find((d) => existsSync(join(d, "nano-files.json")));

if (!OC) {
  console.log("  SKIP: opencode assets not found (terminal/public/opencode) — nano-only CI");
  console.log("\n=== nodert real-app: opencode (SKIPPED) ===");
  process.exit(0);
}

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

// Stage the opencode tree into the shared VFS (the "installed" state the VM
// tier would produce; here staged directly).
function stage(k) {
  k.vfs.mkdir("/opencode", 0o755);
  for (const rel of JSON.parse(readFileSync(join(OC, "nano-files.json"), "utf8"))) {
    const dst = "/opencode/" + rel;
    let cur = ""; for (const p of dst.slice(0, dst.lastIndexOf("/")).split("/").filter(Boolean)) { cur += "/" + p; try { k.vfs.mkdir(cur, 0o755); } catch {} }
    k.vfs.rootMem.createFile(dst, new Uint8Array(readFileSync(join(OC, rel))));
  }
}
async function newKernel() { const k = new Kernel(); await registerBuiltinServices(k); stage(k); return k; }
const run = (k, args) => runNode(k, { argv: ["node", "/opencode/index-nano.js", ...args], entryPath: "/opencode/index-nano.js", cwd: "/opencode", env: { HOME: "/root", PATH: "/usr/bin" }, timeoutMs: 120000 });

await test("the 16MB opencode ESM bundle loads + executes on the host engine", async () => {
  const k = await newKernel();
  const r = await run(k, ["--help"]);
  // The real yargs CLI runs: command list + options are printed.
  assert(r.stdout.includes("opencode <command>"), "prints the CLI usage banner");
  assert(r.stdout.includes("serve"), "lists the serve command");
  assert(r.stdout.includes("--help"), "lists options");
  assert(r.exitCode === 0, `exit 0 (got ${r.exitCode})`);
});

await test("host-engine boot of the 16MB bundle is fast (< 8s, vs seconds-per-boot in the VM)", async () => {
  const k = await newKernel();
  const t0 = Date.now();
  const r = await run(k, ["--help"]);
  const ms = Date.now() - t0;
  assert(r.stdout.includes("opencode <command>"), "ran");
  assert(ms < 8000, `booted+ran in ${ms}ms`);
});

console.log(`\n=== nodert real-app: opencode on the host engine: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
