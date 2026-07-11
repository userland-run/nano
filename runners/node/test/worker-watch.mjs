#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// M2-b tests: worker_threads (nested nodert workers as Kernel processes,
// messaging over Kernel IPC pipes, workerData) and fs.watch (over the Kernel
// WatchRegistry events). No keep-alive timers — the loop-ref API keeps the
// process alive while a Worker/watcher is active (§10.4).

import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";
import { registerNodertDelegate } from "../src/host/delegate.mjs";

let passed = 0, failed = 0;

async function run(name, src, files, expect, expectExit = 0) {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel);
  registerNodertDelegate(kernel);
  if (files) for (const [p, c] of Object.entries(files)) { const d = p.slice(0, p.lastIndexOf("/")); if (d) mkdirp(kernel, d); kernel.vfs.rootMem.createFile(p, c); }
  const r = await runNode(kernel, { argv: ["node", "-e", src], source: src, cwd: "/", env: {}, timeoutMs: 25000 });
  const ok = typeof expect === "function" ? expect(r.stdout) : r.stdout === expect;
  if (ok && r.exitCode === expectExit) { passed++; console.log(`  PASS: ${name}`); }
  else {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    exit ${r.exitCode} (want ${expectExit}) stdout ${JSON.stringify(r.stdout)}`);
    if (r.stderr) console.error(`    stderr ${r.stderr.split("\n").slice(0, 3).join(" | ")}`);
  }
}
function mkdirp(k, dir) { let c = ""; for (const s of dir.split("/").filter(Boolean)) { c += "/" + s; try { k.vfs.mkdir(c, 0o755); } catch {} } }

await run("worker_threads: message round-trip + workerData",
  `const { Worker } = require("worker_threads");
   const w = new Worker("/app/w.js", { workerData: { label: "hi" } });
   w.on("message", (m) => { console.log("main:" + JSON.stringify(m)); w.terminate(); process.exit(0); });
   w.postMessage({ a: 20, b: 22 });`,
  { "/app/w.js": `const {parentPort,workerData}=require("worker_threads"); parentPort.on("message", m => { parentPort.postMessage({sum:m.a+m.b, label:workerData.label}); parentPort.close(); });` },
  "main:{\"sum\":42,\"label\":\"hi\"}\n");

await run("worker_threads: worker stdout routes to parent",
  `const { Worker } = require("worker_threads");
   const w = new Worker("/app/w.js");
   w.on("exit", () => process.exit(0));`,
  { "/app/w.js": `console.log("from worker"); require("worker_threads").parentPort.close();` },
  (out) => out.includes("from worker"));

await run("worker_threads: keeps the loop alive until the worker replies",
  `const { Worker } = require("worker_threads");
   const w = new Worker("/app/w.js");
   w.on("message", (m) => { console.log("late:" + m); w.terminate(); });`,
  { "/app/w.js": `const {parentPort}=require("worker_threads"); setTimeout(() => { parentPort.postMessage(99); parentPort.close(); }, 100);` },
  "late:99\n");

await run("fs.watch: change event fires with filename",
  `const fs = require("fs");
   const w = fs.watch("/w/f.txt", (kind, name) => { console.log(kind + ":" + name); w.close(); process.exit(0); });
   setTimeout(() => fs.writeFileSync("/w/f.txt", "changed"), 50);`,
  { "/w/f.txt": "initial" },
  "change:f.txt\n");

await run("fs.watch: directory watch sees new file",
  `const fs = require("fs");
   const w = fs.watch("/w", (kind, name) => { if (name === "new.txt") { console.log(kind + ":" + name); w.close(); process.exit(0); } });
   setTimeout(() => fs.writeFileSync("/w/new.txt", "x"), 50);`,
  { "/w/keep": "1" },
  "rename:new.txt\n");

console.log(`\n=== nodert worker_threads + fs.watch (M2-b): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
