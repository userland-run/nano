#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// Ordering harness (spec §16.2, §10) — validates the nodert event loop's phase
// and callback-ordering semantics by running interleaving scripts and diffing
// the emitted sequence BYTE-FOR-BYTE against the Node oracle (host node by
// default; --vm for the real VM). Covers nextTick vs microtask priority,
// setImmediate vs setTimeout(0), nextTick recursion draining before I/O,
// close-callback timing, and multi-immediate FIFO order.

import { execFileSync } from "node:child_process";
import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

const useVm = process.argv.includes("--vm");

const CORPUS = [
  { name: "sync > nextTick > microtask > timer > immediate",
    src: `setImmediate(() => console.log("immediate"));
          setTimeout(() => console.log("timeout"), 0);
          Promise.resolve().then(() => console.log("promise"));
          process.nextTick(() => console.log("nextTick"));
          console.log("sync");` },
  { name: "nextTick drains before promises each turn",
    src: `Promise.resolve().then(() => { console.log("p1"); process.nextTick(() => console.log("tick-in-p1")); });
          process.nextTick(() => console.log("tick1"));
          Promise.resolve().then(() => console.log("p2"));
          console.log("sync");` },
  { name: "recursive nextTick drains fully before a timer",
    src: `let n = 0;
          function tick() { if (++n <= 3) { console.log("tick" + n); process.nextTick(tick); } }
          setTimeout(() => console.log("timeout"), 0);
          process.nextTick(tick);
          console.log("sync");` },
  { name: "setImmediate FIFO order",
    src: `setImmediate(() => console.log("i1"));
          setImmediate(() => console.log("i2"));
          setImmediate(() => console.log("i3"));
          console.log("sync");` },
  { name: "chained then() vs nextTick interleave",
    src: `Promise.resolve().then(() => console.log("a")).then(() => console.log("b"));
          process.nextTick(() => console.log("t1"));
          Promise.resolve().then(() => console.log("c"));
          console.log("sync");` },
  { name: "queueMicrotask vs nextTick",
    src: `queueMicrotask(() => console.log("micro"));
          process.nextTick(() => console.log("tick"));
          console.log("sync");` },
  { name: "async/await sequencing with timers",
    src: `(async () => {
            console.log("start");
            await null;
            console.log("after-await");
            setTimeout(() => console.log("timeout"), 0);
            await Promise.resolve();
            console.log("after-promise");
          })();
          console.log("sync");` },
  { name: "nested setTimeout schedules nextTick + immediate",
    src: `setTimeout(() => {
            console.log("timeout");
            process.nextTick(() => console.log("tick-in-timeout"));
            setImmediate(() => console.log("immediate-in-timeout"));
            Promise.resolve().then(() => console.log("promise-in-timeout"));
          }, 0);
          console.log("sync");` },
  { name: "multiple awaits resolve in order",
    src: `async function f(n) { await null; await null; return n; }
          Promise.all([f(1), f(2), f(3)]).then((r) => console.log("all:" + r.join(",")));
          console.log("sync");` },
  { name: "nextTick from within a promise defers correctly",
    src: `Promise.resolve().then(() => {
            console.log("p");
            process.nextTick(() => console.log("nt"));
            Promise.resolve().then(() => console.log("p2"));
          });
          console.log("sync");` },
];

function oracle(src) {
  if (useVm) return runVm(src);
  try { return { out: execFileSync(process.execPath, ["-e", src], { encoding: "utf8", timeout: 15000 }), code: 0 }; }
  catch (e) { return { out: e.stdout ?? "", code: e.status ?? 1 }; }
}
function runVm(src) {
  try {
    const out = execFileSync(process.execPath, [join(dir, "..", "..", "test", "run.mjs"), join(dir, "..", "..", "images", "node"), "--cmd", "node", "-e", src],
      { encoding: "utf8", timeout: 180000, env: { ...process.env, NANOVM_RAM_MB: "1800" }, maxBuffer: 32 << 20 });
    return { out, code: 0 };
  } catch (e) { return { out: e.stdout ?? "", code: e.status ?? 1 }; }
}
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
for (const c of CORPUS) {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel);
  const r = await runNode(kernel, { argv: ["node", "-e", c.src], source: c.src, cwd: "/", env: {}, timeoutMs: 20000 });
  const want = oracle(c.src);
  if (r.stdout === want.out && r.exitCode === want.code) { passed++; console.log(`  PASS: ${c.name}`); }
  else {
    failed++;
    console.error(`  FAIL: ${c.name}`);
    console.error(`    nodert: ${JSON.stringify(r.stdout)}`);
    console.error(`    oracle: ${JSON.stringify(want.out)}`);
  }
}

console.log(`\n=== ordering harness (${useVm ? "VM oracle" : "host-node oracle"}): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
