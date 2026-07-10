#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// M2 ESM tests (spec §9.2): the blob-URL loader running real host ES modules —
// static import/export, re-exports, JSON modules, TLA, dynamic import,
// import.meta, CJS-builtin interop, circular imports (SCC concatenation), and
// TypeScript type-stripping via the SWC Kernel Service.

import { Kernel, registerBuiltinServices } from "../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

let passed = 0, failed = 0;

async function run(name, opts, expect, expectExit = 0) {
  const k = new Kernel();
  await registerBuiltinServices(k);
  if (opts.files) { for (const [p, c] of Object.entries(opts.files)) { const dir = p.slice(0, p.lastIndexOf("/")); if (dir) mkdirp(k, dir); k.vfs.rootMem.createFile(p, c); } }
  const argv = opts.entryPath ? ["node", opts.entryPath] : ["node", "-e", opts.source];
  const r = await runNode(k, { argv, source: opts.source, entryPath: opts.entryPath, inputType: opts.inputType, cwd: opts.cwd ?? "/", env: {}, timeoutMs: 20000 });
  const ok = typeof expect === "function" ? expect(r.stdout) : r.stdout === expect;
  if (ok && r.exitCode === expectExit) { passed++; console.log(`  PASS: ${name}`); }
  else {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    exit ${r.exitCode} (want ${expectExit}) stdout ${JSON.stringify(r.stdout)}`);
    if (r.stderr) console.error(`    stderr ${r.stderr.split("\n").slice(0, 2).join(" | ")}`);
  }
}
function mkdirp(k, dir) { let cur = ""; for (const seg of dir.split("/").filter(Boolean)) { cur += "/" + seg; try { k.vfs.mkdir(cur, 0o755); } catch {} } }

await run("static named import from a builtin", { source: `import { join, dirname } from "path"; console.log(join("/a", "b"), dirname("/x/y"))`, inputType: "module" }, "/a/b /x\n");
await run("default + namespace import", { source: `import * as p from "path"; console.log(typeof p.join, p.sep)`, inputType: "module" }, "function /\n");
await run("top-level await", { source: `const v = await Promise.resolve(21); console.log(v * 2)`, inputType: "module" }, "42\n");
await run("dynamic import()", { source: `const m = await import("path"); console.log(m.basename("/a/b.js"))`, inputType: "module" }, "b.js\n");
await run("import.meta.url", { entryPath: "/app/m.mjs", cwd: "/app", files: { "/app/m.mjs": `console.log(import.meta.url)` } }, "file:///app/m.mjs\n");
await run("multi-file graph + JSON module", {
  entryPath: "/app/main.mjs", cwd: "/app",
  files: { "/app/main.mjs": `import { double } from "./lib.mjs"; import cfg from "./cfg.json"; console.log(double(cfg.n))`, "/app/lib.mjs": `export const double = (x) => x * 2;`, "/app/cfg.json": `{ "n": 21 }` },
}, "42\n");
await run("export ... from re-export chain", {
  entryPath: "/app/main.mjs", cwd: "/app",
  files: { "/app/main.mjs": `import { a, b } from "./agg.mjs"; console.log(a + b)`, "/app/agg.mjs": `export { a } from "./x.mjs"; export { b } from "./y.mjs";`, "/app/x.mjs": `export const a = 10;`, "/app/y.mjs": `export const b = 32;` },
}, "42\n");
await run("circular imports (SCC concatenation)", {
  entryPath: "/app/a.mjs", cwd: "/app",
  files: { "/app/a.mjs": `import { bVal } from "./b.mjs"; export const aVal = 1; export function getB() { return bVal; } console.log("a:" + getB())`, "/app/b.mjs": `import { aVal } from "./a.mjs"; export const bVal = 2; export function getA() { return aVal; }` },
}, "a:2\n");
await run("TypeScript entry (type-stripped via SWC)", {
  entryPath: "/app/t.ts", cwd: "/app", inputType: "module",
  files: { "/app/t.ts": `interface Pt { x: number; y: number }\nconst add = (a: number, b: number): number => a + b;\nconst p: Pt = { x: 20, y: 22 };\nconsole.log("ts:" + add(p.x, p.y))` },
}, "ts:42\n");
await run("TS + import from a .ts sibling", {
  entryPath: "/app/main.ts", cwd: "/app", inputType: "module",
  files: { "/app/main.ts": `import { greet } from "./greet.ts"; const who: string = "world"; console.log(greet(who))`, "/app/greet.ts": `export const greet = (name: string): string => "hi " + name;` },
}, "hi world\n");

console.log(`\n=== nodert ESM loader (M2): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
