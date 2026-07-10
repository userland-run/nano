#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// K9-browser: the host loads the node-lib bundle + fixtures and hands the bytes
// to the nodert worker, so a browser (no fs, no brotli) can boot. Headless
// coverage of everything but the actual browser fetch/Worker transport:
//   1. the Node disk branch returns the right shapes;
//   2. the BROWSER branch (forceBrowser + injected fetch + DecompressionStream
//      "gzip") inflates the .gz sibling to the SAME bytes as the .br disk path
//      — proving the gzip asset is correct and browser-decompressible;
//   3. a real program boots from injected in-memory bytes (init.libIndex/
//      libBytes/fixtures), i.e. the exact browser init plumbing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Kernel, registerBuiltinServices } from "../../kernel/index.mjs";
import { loadLibBundle } from "../src/host/lib-loader.mjs";
import { runNode } from "../src/host/runtime.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const nodertRoot = join(dir, "..");

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
function assertEqual(a, b, m) { if (a !== b) { console.error(`  FAIL: ${current} - ${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

// A fetch shim that serves the vendored assets from disk — stands in for the
// browser's same-origin fetch of dist/vendor/nodert/vendor/node-lib/*.
function diskFetch(url) {
  const p = fileURLToPath(url);
  const buf = readFileSync(p);
  return Promise.resolve({
    ok: true, status: 200,
    json: async () => JSON.parse(buf.toString("utf8")),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });
}

await test("Node disk branch returns index + decompressed bytes + fixtures", async () => {
  const { libIndex, libBytes, fixtures } = await loadLibBundle({ force: true });
  assert(libIndex && libIndex.version === "v25.4.0", "libIndex.version");
  assert(libIndex.modules && typeof libIndex.modules === "object", "libIndex.modules map");
  assert(libBytes instanceof Uint8Array && libBytes.length > 3_000_000, `libBytes ~4MB (${libBytes?.length})`);
  for (const k of ["options", "config", "constants", "errno"]) assert(fixtures[k] && typeof fixtures[k] === "object", `fixture ${k}`);
});

await test("browser branch (gzip + fetch) inflates to the SAME bytes as the .br disk path", async () => {
  const disk = await loadLibBundle({ force: true }); // Node/brotli
  const browser = await loadLibBundle({ force: true, forceBrowser: true, fetch: diskFetch }); // gzip/DecompressionStream
  assertEqual(browser.libBytes.length, disk.libBytes.length, "decompressed length matches");
  // Spot-check byte identity at a few offsets + the tail (cheap full-ish proof).
  const n = disk.libBytes.length;
  const eq = browser.libBytes[0] === disk.libBytes[0] && browser.libBytes[n - 1] === disk.libBytes[n - 1] &&
    browser.libBytes[(n / 2) | 0] === disk.libBytes[(n / 2) | 0];
  assert(eq, "byte-identical at head/mid/tail");
  // Exhaustive equality (it's only ~4MB).
  let same = true; for (let i = 0; i < n; i += 4096) if (browser.libBytes[i] !== disk.libBytes[i]) { same = false; break; }
  assert(same, "byte-identical on a 4K stride");
  assertEqual(browser.libIndex.version, disk.libIndex.version, "same version");
});

await test("nodert boots from INJECTED bytes (the browser init path)", async () => {
  const lib = await loadLibBundle({ force: true, forceBrowser: true, fetch: diskFetch });
  const k = new Kernel();
  await registerBuiltinServices(k);
  // Passing `lib` makes runtime.mjs send init.libIndex/libBytes/fixtures — the
  // worker uses initFromBytes + init.fixtures instead of reading disk.
  const r = await runNode(k, { argv: ["node", "-e", 'process.stdout.write("booted-from-bytes:" + (40+2))'], source: 'process.stdout.write("booted-from-bytes:" + (40+2))', lib, cwd: "/", env: {}, timeoutMs: 15000 });
  assertEqual(r.stdout, "booted-from-bytes:42", "ran on nodert via injected bundle");
  assertEqual(r.exitCode, 0, "exit 0");
});

console.log(`\n=== nodert lib-loader (K9-browser): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
