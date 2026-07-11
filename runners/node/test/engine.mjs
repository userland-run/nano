#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// Engine-selection tests (spec §14): createNodeEngine's vm/nodert/auto policy,
// ERR_NODE_HOST_UNSUPPORTED fallback, and routing pins. The VM tier is a STUB
// vmRun (so this runs headless in <1s); a separate @heavy test wires the real
// emulated node. The nodert path is REAL — programs actually run on the host
// engine.

import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { createNodeEngine } from "../src/host/engine.mjs";

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
function assertEqual(a, b, m) { if (a !== b) { console.error(`  FAIL: ${current} - ${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

async function newKernel() { const k = new Kernel(); await registerBuiltinServices(k); return k; }

// A stub VM node runner: records that it was called and echoes a marker so the
// test can prove the vm path (not nodert) served the request.
function stubVm() {
  const calls = [];
  const run = async (argv, opts) => {
    calls.push({ argv, opts });
    return { exitCode: 0, stdout: "VM-RAN " + argv.slice(1).join(" "), stderr: "", signal: null };
  };
  return { run, calls };
}

await test("engine 'nodert' runs a program on the host engine (real)", async () => {
  const k = await newKernel();
  const eng = createNodeEngine(k, { engine: "host" });
  const r = await eng.node(["node", "-e", 'process.stdout.write("hi from nodert")'], { timeoutMs: 15000 });
  assertEqual(r.engine, "host", "served by nodert");
  assertEqual(r.stdout, "hi from nodert", "nodert stdout");
  assertEqual(r.exitCode, 0, "exit 0");
});

await test("engine 'vm' dispatches to the injected vmRun", async () => {
  const k = await newKernel();
  const vm = stubVm();
  const eng = createNodeEngine(k, { engine: "vm", vmRun: vm.run });
  const r = await eng.node(["node", "-e", 'console.log("ignored")']);
  assertEqual(r.engine, "vm", "served by vm");
  assert(r.stdout.startsWith("VM-RAN"), "vm stub ran");
  assertEqual(vm.calls.length, 1, "vmRun called once");
});

await test("engine 'auto' stays on nodert for a supported program (no fallback)", async () => {
  const k = await newKernel();
  const vm = stubVm();
  const eng = createNodeEngine(k, { engine: "auto", vmRun: vm.run });
  const r = await eng.node(["node", "-e", 'process.stdout.write("ok")'], { timeoutMs: 15000 });
  assertEqual(r.engine, "host", "auto → nodert when supported");
  assertEqual(r.stdout, "ok", "nodert output");
  assert(!r.fellBack, "no fallback");
  assertEqual(vm.calls.length, 0, "vm NOT called");
});

await test("engine 'auto' falls back to vm on ERR_NODE_HOST_UNSUPPORTED", async () => {
  const k = await newKernel();
  const vm = stubVm();
  const eng = createNodeEngine(k, { engine: "auto", vmRun: vm.run });
  // A guest surfacing the documented marker to stderr + non-zero exit (exactly
  // how a service adapter like rspack reports "can't do this on the host").
  const src = 'process.stderr.write("ERR_NODE_HOST_UNSUPPORTED: rspack has no browser build"); process.exit(1);';
  const r = await eng.node(["node", "-e", src], { timeoutMs: 15000 });
  assertEqual(r.engine, "vm", "fell back to vm");
  assert(r.fellBack, "fellBack flag set");
  assert(r.stdout.startsWith("VM-RAN"), "vm stub served the retry");
  assertEqual(vm.calls.length, 1, "vm called once for the fallback");
});

await test("engine 'nodert' does NOT fall back on unsupported (honest failure)", async () => {
  const k = await newKernel();
  const vm = stubVm();
  const eng = createNodeEngine(k, { engine: "host", vmRun: vm.run });
  const src = 'process.stderr.write("ERR_NODE_HOST_UNSUPPORTED"); process.exit(1);';
  const r = await eng.node(["node", "-e", src], { timeoutMs: 15000 });
  assertEqual(r.engine, "host", "stays nodert");
  assertEqual(r.exitCode, 1, "surfaces the failure");
  assertEqual(vm.calls.length, 0, "no vm fallback in explicit nodert mode");
});

await test("routing pin forces a program to the vm (argv0)", async () => {
  const k = await newKernel();
  const vm = stubVm();
  const eng = createNodeEngine(k, { engine: "host", pins: { jest: "vm" }, vmRun: vm.run });
  const d = eng.which(["jest", "--run"]);
  assertEqual(d.engine, "vm", "which() resolves the pin");
  assertEqual(d.reason, "pin", "reason is pin");
  const r = await eng.node(["jest", "--run"]);
  assertEqual(r.engine, "vm", "pinned program runs on vm despite engine:nodert");
  assertEqual(vm.calls.length, 1, "vm served the pinned program");
});

await test("routing pin matches the entry bin, not just argv0 (node .bin/jest)", async () => {
  const k = await newKernel();
  const vm = stubVm();
  const eng = createNodeEngine(k, { engine: "host", pins: { jest: "vm" }, vmRun: vm.run });
  const d = eng.which(["node", "node_modules/.bin/jest", "--ci"]);
  assertEqual(d.engine, "vm", "pin resolves via the entry basename");
  const r = await eng.node(["node", "/proj/node_modules/.bin/jest"]);
  assertEqual(r.engine, "vm", "entry-pinned program runs on vm");
});

await test("per-call opts.engine overrides the default (but not a pin)", async () => {
  const k = await newKernel();
  const vm = stubVm();
  const eng = createNodeEngine(k, { engine: "vm", pins: { jest: "vm" }, vmRun: vm.run });
  // Default is vm; override this one call to nodert.
  const r = await eng.node(["node", "-e", 'process.stdout.write("override")'], { engine: "host", timeoutMs: 15000 });
  assertEqual(r.engine, "host", "opts.engine overrode the default");
  assertEqual(r.stdout, "override", "ran on nodert");
  // A pin still wins over a per-call preference.
  const p = eng.which(["jest"], { engine: "host" });
  assertEqual(p.engine, "vm", "pin beats opts.engine");
});

await test("engine 'vm' without a wired vmRun throws a clear error", async () => {
  const k = await newKernel();
  const eng = createNodeEngine(k, { engine: "vm" });
  let threw = null;
  try { await eng.node(["node", "-e", "0"]); } catch (e) { threw = e; }
  assert(threw && threw.code === "ERR_NO_VM_ENGINE", "clear ERR_NO_VM_ENGINE when vm unwired");
});

await test("runtime pin() + routing() introspection (S4 revertibility)", async () => {
  const k = await newKernel();
  const eng = createNodeEngine(k, { engine: "auto", vmRun: stubVm().run });
  eng.pin("node-gyp", "vm");
  assertEqual(eng.which(["node-gyp"]).engine, "vm", "runtime pin applied");
  assertEqual(eng.routing()["node-gyp"], "vm", "routing() enumerates the pin");
  eng.pin("node-gyp", null);
  assertEqual(eng.which(["node-gyp"]).engine, "auto", "pin reverted → default engine");
});

console.log(`\n=== nodert engine selector (§14): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
