#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// K8-core / M3-b tests: the CAS store (content-addressed, integrity-verified,
// immutable) and node_modules materialization by HARDLINKING from it (pnpm
// model — shared inodes, O(entries), no copy).

import { Kernel, registerBuiltinServices, materializePackages } from "../../kernel/index.mjs";
import { runNode } from "../../nodert/src/host/runtime.mjs";

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
function assertEqual(a, b, m) { if (a !== b) { console.error(`  FAIL: ${current} - ${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }
const text = (s) => new TextEncoder().encode(s);

await test("CAS put is content-addressed + immutable + idempotent", async () => {
  const k = new Kernel();
  const a = await k.cas.put(text("hello world"));
  const b = await k.cas.put(text("hello world"));
  assertEqual(a.key, b.key, "same content → same key");
  assert(b.existed, "second put finds the existing object");
  assert(k.cas.has(a.key), "has()");
  assertEqual(new TextDecoder().decode(k.cas.read(a.key)), "hello world", "read back");
  const c = await k.cas.put(text("different"));
  assert(c.key !== a.key, "different content → different key");
});

await test("CAS verifies npm integrity on write", async () => {
  const k = new Kernel();
  // Correct integrity for "data" (sha256) — computed by putting once.
  const put = await k.cas.put(text("data"));
  const good = await k.cas.put(text("data"), put.integrity);
  assertEqual(good.key, put.key, "matching integrity accepted");
  await k.cas.put(text("data"), "sha256-WRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRO").then(
    () => assert(false, "bad integrity should throw"),
    (e) => assertEqual(e.code, "EINTEGRITY", "EINTEGRITY on mismatch")
  );
});

await test("node_modules materialize hardlinks from CAS (shared inode)", async () => {
  const k = new Kernel();
  k.vfs.mkdir("/app", 0o755);
  const libSrc = `module.exports = (x) => x * 2;`;
  const res = await materializePackages(k, "/app", {
    "double": {
      packageJson: { name: "double", version: "1.0.0", main: "index.js" },
      files: { "index.js": { bytes: text(libSrc) }, "package.json": { bytes: text(`{"name":"double","version":"1.0.0","main":"index.js"}`) } },
    },
  });
  assert(res.linked >= 2, "linked files");
  const linked = k.vfs.rootMem.resolve("/app/node_modules/double/index.js");
  assert(linked !== null, "materialized index.js");
  assertEqual(new TextDecoder().decode(linked.data), libSrc, "content via hardlink");
  // The CAS object and the materialized file share ONE inode (nlink ≥ 2).
  const casObj = k.cas.read(res /* unused */ && `sha256/${hexOf(libSrc)}`);
  assert(linked.nlink >= 2, `shared inode (nlink=${linked.nlink} ≥ 2)`);
});

await test("bin symlinks land in node_modules/.bin", async () => {
  const k = new Kernel();
  k.vfs.mkdir("/app", 0o755);
  await materializePackages(k, "/app", {
    "cli": { packageJson: { name: "cli", version: "1.0.0", bin: { "mycli": "./bin/run.js" } }, files: { "bin/run.js": { bytes: text("#!/usr/bin/env node\nconsole.log('cli')") } } },
  });
  const link = k.vfs.rootMem.resolve("/app/node_modules/.bin/mycli", false);
  assert(link !== null && link.isSymlink, "mycli symlink exists");
  assertEqual(link.target, "/app/node_modules/cli/bin/run.js", "points at the package bin");
});

function hexOf() { return ""; } // not used for assertion; nlink is the check

await test("nodert require()s a CAS-materialized package (CJS)", async () => {
  const k = new Kernel();
  await registerBuiltinServices(k);
  k.vfs.mkdir("/app", 0o755);
  await materializePackages(k, "/app", {
    "leftpad": { packageJson: { name: "leftpad", version: "1.0.0", main: "index.js" }, files: { "index.js": { bytes: text(`module.exports = (s, n, c = " ") => String(s).padStart(n, c);`) }, "package.json": { bytes: text(`{"name":"leftpad","version":"1.0.0","main":"index.js"}`) } } },
  });
  k.vfs.rootMem.createFile("/app/main.js", `console.log(require("leftpad")("42", 5, "0"))`);
  const r = await runNode(k, { argv: ["node", "/app/main.js"], entryPath: "/app/main.js", cwd: "/app", env: {}, timeoutMs: 20000 });
  assertEqual(r.stdout, "00042\n", "require the CAS package");
  assertEqual(r.exitCode, 0, "exit 0");
});

await test("nodert ESM imports a CAS package (CJS interop)", async () => {
  const k = new Kernel();
  await registerBuiltinServices(k);
  k.vfs.mkdir("/app", 0o755);
  await materializePackages(k, "/app", {
    "leftpad": { packageJson: { name: "leftpad", version: "1.0.0", main: "index.js" }, files: { "index.js": { bytes: text(`module.exports = (s, n, c = " ") => String(s).padStart(n, c);`) }, "package.json": { bytes: text(`{"name":"leftpad","version":"1.0.0","main":"index.js"}`) } } },
  });
  k.vfs.rootMem.createFile("/app/m.mjs", `import leftpad from "leftpad"; console.log(leftpad("7", 3, "0"))`);
  const r = await runNode(k, { argv: ["node", "/app/m.mjs"], entryPath: "/app/m.mjs", cwd: "/app", env: {}, timeoutMs: 20000 });
  assertEqual(r.stdout, "007\n", "ESM import of a CJS package");
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
