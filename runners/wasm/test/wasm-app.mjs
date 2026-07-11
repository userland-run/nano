#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// The wasm-app runner (runners/wasm/src/wasm-app.mjs) + the fd_readdir the shim
// gained for it: a core app compiled to wasm32-wasip1 (apps/core/rg.wasm) runs
// as a NAMED command on the wasm tier, sees its spawn cwd as ".", and walks it.
// This is the first apps/core artifact — a minimal `rg --files`.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { createWasmAppRunner } from "../src/wasm-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RG_WASM = join(here, "..", "..", "..", "apps", "core", "rg.wasm");

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

if (!existsSync(RG_WASM)) {
  console.log(`  SKIP: apps/core/rg.wasm not built (run 'make build-rg')`);
  process.exit(0);
}
const rgBytes = new Uint8Array(readFileSync(RG_WASM));

function project() {
  const k = new Kernel();
  return registerBuiltinServices(k).then(() => {
    for (const d of ["/proj", "/proj/src", "/proj/.git"]) k.vfs.mkdir(d, 0o755);
    const mk = (p, c) => k.vfs.rootMem.createFile(p, new TextEncoder().encode(c));
    mk("/proj/README.md", "#\n"); mk("/proj/package.json", "{}\n");
    mk("/proj/src/a.js", "1\n"); mk("/proj/src/b.js", "2\n");
    mk("/proj/.gitignore", "x\n"); mk("/proj/.git/config", "y\n");
    return k;
  });
}

await test("rg is pinned to the wasm-app tier", async () => {
  const k = await project();
  createWasmAppRunner(k).register("rg", rgBytes);
  const r = k.router.route(["rg", "--files", "."]);
  assert(r.tier === "wasm-app" && r.command === "rg", `routed to wasm-app (got ${JSON.stringify(r)})`);
  // A basename-only pin also catches an absolute invocation (opencode spawns /…/bin/rg).
  const r2 = k.router.route(["/root/.cache/opencode/bin/rg", "--files", "."]);
  assert(r2.tier === "wasm-app", "absolute rg path routes by basename");
});

await test("rg --files walks the spawn cwd (fd_readdir), skips .git/hidden", async () => {
  const k = await project();
  const runner = createWasmAppRunner(k); runner.register("rg", rgBytes);
  const parent = k.registerProcess({ kind: "node", argv: ["p"] });
  const delegate = k.router.delegateFor("wasm-app");
  const r = await delegate({ parent, argv: ["rg", "--no-config", "--files", "--glob=!**/.git/**", "."], cwd: "/proj", env: {}, caps: parent.caps, wait: true, timeoutMs: 15000 });
  assert(r.exitCode === 0, `exit 0 (got ${r.exitCode}, stderr ${r.stderr})`);
  assert(r.stdout === "README.md\npackage.json\nsrc/a.js\nsrc/b.js\n", `sorted project files, no .git/hidden (got ${JSON.stringify(r.stdout)})`);
});

await test("async spawn: parent drains the file list from the pipe", async () => {
  const k = await project();
  const runner = createWasmAppRunner(k); runner.register("rg", rgBytes);
  const parent = k.registerProcess({ kind: "node", argv: ["p"] });
  const delegate = k.router.delegateFor("wasm-app");
  const res = await delegate({ parent, argv: ["rg", "--files", "."], cwd: "/proj", env: {}, caps: parent.caps, wait: false, timeoutMs: 15000 });
  const pipe = k.pipes.get(res.stdout);
  let out = "";
  const dec = new TextDecoder();
  for (let i = 0; i < 4000; i++) {
    const c = pipe.read(65536);
    if (c === "eof") break;
    if (c) out += dec.decode(c, { stream: true });
    else await Promise.race([pipe.waitReadable(), new Promise((r) => setTimeout(r, 5))]);
  }
  assert(out.includes("README.md") && out.includes("src/a.js"), `streamed the file list (got ${JSON.stringify(out)})`);
  assert(!out.includes(".git"), "no .git in the streamed output");
});

console.log(`\n=== wasm-app runner (apps/core rg on wasm32-wasip1): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
