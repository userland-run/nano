#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// exifstrip (apps/core/exifstrip.wasm) — lossless photo-metadata removal on the
// wasm tier: `show` finds GPS/camera/date in JPEG/PNG/WebP/HEIC fixtures,
// `strip` removes it (recursively, in place or into -o OUTDIR) while the
// compressed pixel payload stays byte-identical. Exercises the WASI shim's
// readdir walk, mkdir -p, truncating rewrite and exit codes.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { createWasmAppRunner } from "../src/wasm-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(here, "..", "..", "..", "apps", "core");
const WASM = join(APP_DIR, "exifstrip.wasm");
const FIX = join(APP_DIR, "build", "exifstrip", "tests", "fixtures");

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

if (!existsSync(WASM)) {
  console.log(`  SKIP: apps/core/exifstrip.wasm not built (run 'make build-exifstrip')`);
  process.exit(0);
}
const wasmBytes = new Uint8Array(readFileSync(WASM));
const fx = (n) => new Uint8Array(readFileSync(join(FIX, n)));
const FILES = { "photos/photo.jpg": fx("photo.jpg"), "photos/sub/photo.png": fx("photo.png"), "photos/photo.webp": fx("photo.webp"), "photos/photo.heic": fx("photo.heic"), "photos/clean.png": fx("clean.png") };

async function project() {
  const k = new Kernel();
  await registerBuiltinServices(k);
  for (const d of ["/work", "/work/photos", "/work/photos/sub"]) k.vfs.mkdir(d, 0o755);
  for (const [p, b] of Object.entries(FILES)) k.vfs.rootMem.createFile(`/work/${p}`, b);
  k.vfs.rootMem.createFile("/work/photos/notes.txt", new TextEncoder().encode("not an image\n"));
  createWasmAppRunner(k).register("exifstrip", wasmBytes);
  const parent = k.registerProcess({ kind: "node", argv: ["p"] });
  const del = k.router.delegateFor("wasm-app");
  const run = (...args) => del({ parent, argv: ["exifstrip", ...args], cwd: "/work", env: {}, caps: parent.caps, wait: true, timeoutMs: 20000 });
  const read = (p) => { const st = k.vfs.stat(p); const fd = k.vfs.open(p, 0); const buf = new Uint8Array(st.size); let o = 0; while (o < st.size) { const n = k.vfs.read(fd, buf, o, st.size - o, o); if (!n) break; o += n; } k.vfs.close(fd); return buf; };
  return { k, run, read };
}

// The compressed image payload, independent of metadata blocks.
function payload(b) {
  const eq = (a, s) => a.length === s.length && a.every((x, i) => x === s[i]);
  if (b[0] === 0xff && b[1] === 0xd8) { // JPEG: from the first SOS to the end of EOI
    let i = 2;
    while (i < b.length) { const m = b[i + 1]; if (m === 0xda) break; i += 2 + ((b[i + 2] << 8) | b[i + 3]); }
    let e = b.length; while (e > 2 && !(b[e - 2] === 0xff && b[e - 1] === 0xd9)) e--;
    return b.slice(i, e);
  }
  if (b[1] === 0x50 && b[2] === 0x4e) { // PNG: IHDR + concatenated IDAT
    const parts = []; let i = 8;
    while (i < b.length) { const len = new DataView(b.buffer, b.byteOffset + i).getUint32(0); const t = String.fromCharCode(...b.slice(i + 4, i + 8)); if (t === "IHDR" || t === "IDAT") parts.push(b.slice(i + 8, i + 8 + len)); i += 12 + len; }
    return Buffer.concat(parts);
  }
  if (eq(b.slice(8, 12), [0x57, 0x45, 0x42, 0x50])) { // WebP: VP8/VP8L/ALPH/ANMF chunks
    const parts = []; let i = 12;
    while (i + 8 <= b.length) { const t = String.fromCharCode(...b.slice(i, i + 4)); const len = new DataView(b.buffer, b.byteOffset + i).getUint32(4, true); if (["VP8 ", "VP8L", "ALPH", "ANMF"].includes(t)) parts.push(b.slice(i + 8, i + 8 + len)); i += 8 + len + (len & 1); }
    return Buffer.concat(parts);
  }
  return null;
}
const same = (a, b) => a && b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

await test("exifstrip is pinned to the wasm-app tier", async () => {
  const { k } = await project();
  const r = k.router.route(["exifstrip", "show", "x.jpg"]);
  assert(r.tier === "wasm-app" && r.command === "exifstrip", `routed to wasm-app (got ${JSON.stringify(r)})`);
});

await test("show finds GPS, camera and date in JPEG/PNG/WebP/HEIC (recursive)", async () => {
  const { run } = await project();
  const r = await run("show", "photos");
  assert(r.exitCode === 0, `exit 0 (got ${r.exitCode}, stderr ${JSON.stringify(r.stderr)})`);
  for (const [f, fmt] of [["photos/photo.jpg", "JPEG"], ["photos/sub/photo.png", "PNG"], ["photos/photo.webp", "WebP"], ["photos/photo.heic", "HEIF (heic)"]]) {
    assert(r.stdout.includes(`${f}: ${fmt} 64x48`), `${f} header`);
  }
  assert((r.stdout.match(/gps: yes \(47\.269200, 11\.404100\)/g) || []).length === 4, `4x gps (got ${r.stdout})`);
  assert((r.stdout.match(/camera: Canon EOS 5D Mark IV/g) || []).length === 4, "4x camera");
  assert(r.stdout.includes("photos/clean.png: PNG 64x48\n  metadata: none"), "clean.png has none");
  assert(!r.stdout.includes("notes.txt"), "non-images in dirs are skipped");
});

await test("strip -o out: metadata gone, pixel payload byte-identical", async () => {
  const { run, read } = await project();
  const r = await run("strip", "-o", "out", "photos");
  assert(r.exitCode === 0, `exit 0 (got ${r.exitCode}, stderr ${JSON.stringify(r.stderr)})`);
  assert(r.stdout.includes("5 file(s): 4 stripped, 1 clean, 0 failed"), `summary (got ${JSON.stringify(r.stdout)})`);
  for (const [p, orig] of Object.entries(FILES)) {
    const out = read(`/work/out/${p}`);
    if (p.endsWith(".heic")) assert(out.length === orig.length, "heic blanked in place (same length)");
    else assert(same(payload(orig), payload(out)), `${p}: compressed pixel data identical`);
    assert(same(read(`/work/${p}`), orig), `${p}: input untouched with -o`);
  }
  const s = await run("show", "out");
  assert(s.exitCode === 0 && !s.stdout.includes("gps: yes") && !s.stdout.includes("camera:"), `no gps/camera left (got ${s.stdout})`);
  assert((s.stdout.match(/metadata: none/g) || []).length === 5, "all 5 report metadata: none");
});

await test("strip in place --keep-orientation (idempotent)", async () => {
  const { run, read } = await project();
  const r = await run("strip", "--keep-orientation", "photos/photo.jpg", "photos/sub/photo.png");
  assert(r.exitCode === 0 && r.stdout.includes("2 file(s): 2 stripped"), `strip (got ${r.exitCode} ${JSON.stringify(r.stdout)})`);
  assert(same(payload(read("/work/photos/photo.jpg")), payload(FILES["photos/photo.jpg"])), "jpeg payload identical");
  const s = await run("show", "photos/photo.jpg", "photos/sub/photo.png");
  assert((s.stdout.match(/orientation: 6/g) || []).length === 2 && (s.stdout.match(/gps: no/g) || []).length === 2, `orientation kept, gps gone (got ${s.stdout})`);
  const again = await run("strip", "--keep-orientation", "photos/photo.jpg");
  assert(again.stdout.startsWith("clean    photos/photo.jpg"), `second pass is clean (got ${JSON.stringify(again.stdout)})`);
});

await test("exit codes: unsupported file → 1, usage → 2", async () => {
  const { run } = await project();
  const a = await run("strip", "photos/notes.txt");
  assert(a.exitCode === 1 && /unsupported format/.test(a.stderr), `unsupported → 1 (got ${a.exitCode} ${JSON.stringify(a.stderr)})`);
  const b = await run("frobnicate");
  assert(b.exitCode === 2, `usage → 2 (got ${b.exitCode})`);
  const c = await run("show", "missing.jpg");
  assert(c.exitCode === 1, `missing → 1 (got ${c.exitCode})`);
});

console.log(`\n=== exifstrip (apps/core exifstrip on wasm32-wasip1): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
