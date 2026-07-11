#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// WASM tier W-3: the WASI service runner. A wasm32-wasip1 module is wrapped as
// a Kernel Service (svc.* bus) and invoked as a per-request FILTER — request
// bytes → fd 0, response ← fd 1. Covers: direct registration + invoke, the
// svc.* bus path (list/invoke through the registry), a catalog
// kind:"wasm-service" manifest driving registration, and non-string payloads.

import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { createWasiService, createWarmWasmService, registerWasmServiceFromManifest } from "../src/wasi-service.mjs";
import { stdinEchoModule, counterReactorModule } from "./wasm-fixtures.mjs";

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
function assertEqual(a, b, m) { if (a !== b) { console.error(`  FAIL: ${current} - ${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

async function newKernel() { const k = new Kernel(); await registerBuiltinServices(k); return k; }

await test("createWasiService: invoke runs the module as a request→response filter", async () => {
  const k = await newKernel();
  const svc = createWasiService(k, { id: "echo", version: "1.0.0", wasmBytes: stdinEchoModule("WASI:") });
  const r = await svc.invoke("run", "hello world");
  assert(r.ok, "ok");
  assertEqual(r.stdout, "WASI:hello world", "prefix + echoed request (the wasm ran)");
});

await test("service is a kind:'wasm-service' with declared methods", async () => {
  const k = await newKernel();
  const svc = createWasiService(k, { id: "echo", wasmBytes: stdinEchoModule("X:"), methods: ["run", "check"] });
  assertEqual(svc.kind, "wasm-service", "kind");
  assert(svc.methods.includes("run") && svc.methods.includes("check"), "methods");
});

await test("registered service is reachable over the svc.* bus (list + invoke)", async () => {
  const k = await newKernel();
  const unregister = k.services.register(createWasiService(k, { id: "up", version: "2.1.0", wasmBytes: stdinEchoModule("R:") }));
  const listed = k.services.list().find((s) => s.id === "up");
  assert(listed, "service appears in svc.list");
  assertEqual(listed.kind, "wasm-service", "list reports the kind");
  const res = await k.services.invoke("up", "run", "payload-42");
  assertEqual(res.stdout, "R:payload-42", "svc.invoke round-trips through the wasm filter");
  unregister();
  assert(!k.services.list().find((s) => s.id === "up"), "unregister removes it");
});

await test("registerWasmServiceFromManifest wires a catalog wasm-service", async () => {
  const k = await newKernel();
  const manifest = { name: "echofilter", version: "0.3.0", kind: "wasm-service", entrypoint: { argv: ["echofilter"], env: {} }, methods: ["run"] };
  registerWasmServiceFromManifest(k, manifest, stdinEchoModule("M:"));
  const listed = k.services.list().find((s) => s.id === "echofilter");
  assert(listed && listed.kind === "wasm-service", "manifest-driven service registered");
  const res = await k.services.invoke("echofilter", "run", "cat");
  assertEqual(res.stdout, "M:cat", "invocation works via the manifest-registered service");
});

await test("a non-wasm-service manifest is refused", async () => {
  const k = await newKernel();
  let threw = null;
  try { registerWasmServiceFromManifest(k, { name: "x", kind: "wasm-app" }, stdinEchoModule()); } catch (e) { threw = e; }
  assert(threw && /not kind:"wasm-service"/.test(threw.message), "kind guard rejects wasm-app");
});

await test("JSON payload is serialized to the request stream", async () => {
  const k = await newKernel();
  const svc = createWasiService(k, { id: "j", wasmBytes: stdinEchoModule("") });
  const r = await svc.invoke("run", { a: 1, b: "two" });
  assertEqual(r.stdout, '{"a":1,"b":"two"}', "object payload → JSON on stdin, echoed back");
});

// --- persistent / warm services (W-3 tail) ---

await test("warm service instance persists state across invokes", async () => {
  const k = await newKernel();
  const svc = createWarmWasmService(k, { id: "counter", version: "1.0.0", wasmBytes: counterReactorModule(), methods: ["increment", "add"] });
  assert(!svc.isWarm(), "cold before first invoke");
  const a = await svc.invoke("increment");
  const b = await svc.invoke("increment");
  const c = await svc.invoke("increment");
  assert(svc.isWarm(), "warm after first invoke");
  assertEqual(a.result, 1, "first increment");
  assertEqual(b.result, 2, "state persisted → second");
  assertEqual(c.result, 3, "state persisted → third");
});

await test("warm service: a different method on the same warm instance", async () => {
  const k = await newKernel();
  const svc = createWarmWasmService(k, { id: "calc", wasmBytes: counterReactorModule(), methods: ["increment", "add"] });
  assertEqual((await svc.invoke("add", { args: [40, 2] })).result, 42, "add(40,2)");
  assertEqual((await svc.invoke("increment")).result, 1, "increment on the same instance");
});

await test("warm service reset() drops state (next invoke is cold)", async () => {
  const k = await newKernel();
  const svc = createWarmWasmService(k, { id: "c2", wasmBytes: counterReactorModule() });
  await svc.invoke("increment"); await svc.invoke("increment");
  assertEqual((await svc.invoke("increment")).result, 3, "warmed to 3");
  svc.reset();
  assert(!svc.isWarm(), "cold after reset");
  assertEqual((await svc.invoke("increment")).result, 1, "fresh instance restarts state");
});

await test("warm service is kind:'wasm-service' + persistent, registrable on the bus", async () => {
  const k = await newKernel();
  const svc = createWarmWasmService(k, { id: "warmsvc", wasmBytes: counterReactorModule(), methods: ["increment"] });
  assertEqual(svc.kind, "wasm-service", "kind");
  assert(svc.persistent === true, "flagged persistent");
  k.services.register(svc);
  const r = await k.services.invoke("warmsvc", "increment");
  assertEqual(r.result, 1, "reachable + invocable over svc.*");
  assertEqual((await k.services.invoke("warmsvc", "increment")).result, 2, "warm across bus invokes");
});

console.log(`\n=== nodert WASI service runner (W-3): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
