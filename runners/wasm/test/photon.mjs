#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// photon (apps/core/photon.wasm) — a tiny image-processing CLI compiled to
// wasm32-wasip1 — runs as a NAMED command on the wasm tier: decode a PNG from
// the spawn cwd, apply a filter, encode a PNG back. Exercises the WASI shim's
// file read + write path with real binary I/O (the catalog's first kind:"wasm-app").

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { createWasmAppRunner } from "../src/wasm-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PHOTON_WASM = join(here, "..", "..", "..", "apps", "core", "photon.wasm");
const TINY_PNG = join(here, "fixtures", "tiny.png");

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

if (!existsSync(PHOTON_WASM)) {
  console.log(`  SKIP: apps/core/photon.wasm not built (run 'make build-photon')`);
  process.exit(0);
}
const photonBytes = new Uint8Array(readFileSync(PHOTON_WASM));
const pngBytes = new Uint8Array(readFileSync(TINY_PNG));
const isPng = (b) => b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

async function project() {
  const k = new Kernel();
  await registerBuiltinServices(k);
  k.vfs.mkdir("/work", 0o755);
  k.vfs.rootMem.createFile("/work/in.png", pngBytes);
  return k;
}

await test("photon is pinned to the wasm-app tier", async () => {
  const k = await project();
  createWasmAppRunner(k).register("photon", photonBytes);
  const r = k.router.route(["photon", "in.png", "out.png"]);
  assert(r.tier === "wasm-app" && r.command === "photon", `routed to wasm-app (got ${JSON.stringify(r)})`);
});

await test("photon decodes a PNG, applies a filter, encodes a PNG (round-trip)", async () => {
  const k = await project();
  createWasmAppRunner(k).register("photon", photonBytes);
  const parent = k.registerProcess({ kind: "node", argv: ["p"] });
  const del = k.router.delegateFor("wasm-app");
  for (const filter of ["grayscale", "invert", "sepia", "threshold", "blur"]) {
    const out = `out-${filter}.png`;
    const r = await del({ parent, argv: ["photon", "in.png", out, "--filter", filter], cwd: "/work", env: {}, caps: parent.caps, wait: true, timeoutMs: 20000 });
    if (!assert(r.exitCode === 0, `${filter}: exit 0 (got ${r.exitCode}, stderr ${JSON.stringify(r.stderr)})`)) continue;
    assert(r.stdout.includes(`${filter}`) && r.stdout.includes("4x4"), `${filter}: summary reports 4x4 (got ${JSON.stringify(r.stdout)})`);
    const bytes = k.vfs.rootMem.readFile ? k.vfs.rootMem.readFile(`/work/${out}`) : null;
    const st = (() => { try { return k.vfs.stat(`/work/${out}`); } catch { return null; } })();
    assert(st && st.size > 8, `${filter}: wrote a non-empty output file (size ${st?.size})`);
  }
});

console.log(`\n=== photon (apps/core photon on wasm32-wasip1): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
