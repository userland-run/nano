#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Unit tests for K3: process table (register/attenuation/exit/waitpid/
 * reparent/list) and the capability engine (subset rules, checkCap).
 *
 * Usage: node test/kernel/test_proc_caps.mjs
 */
import { Kernel, KernelError, ERRNO, OP } from "../../kernel/index.mjs";
import { ProcessTable } from "../../kernel/proc/table.mjs";
import { capsIsSubset, checkCap, normalizeCaps } from "../../kernel/caps/caps.mjs";
import { trustedDev, boaDefault, fromExposeConfig } from "../../kernel/caps/profiles.mjs";

let passed = 0;
let failed = 0;
let current = "";

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${current} - ${msg}`);
    failed++;
    return false;
  }
  return true;
}
function assertEqual(a, b, msg) {
  if (a !== b) {
    console.error(`  FAIL: ${current} - ${msg}: expected ${b}, got ${a}`);
    failed++;
    return false;
  }
  return true;
}
function assertDenied(fn, capability, msg) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${current} - ${msg}: expected ERR_CAP_DENIED`);
  } catch (e) {
    if (!(e instanceof KernelError) || e.name !== "ERR_CAP_DENIED") {
      failed++;
      console.error(`  FAIL: ${current} - ${msg}: wrong error ${e.name}`);
    } else if (capability && e.capability !== capability) {
      failed++;
      console.error(`  FAIL: ${current} - ${msg}: capability ${e.capability} != ${capability}`);
    }
  }
}
async function test(name, fn) {
  current = name;
  const before = failed;
  try {
    await fn();
    if (failed === before) {
      passed++;
      console.log(`  PASS: ${name}`);
    }
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name} - threw ${e.message}`);
  }
}

// ============================================================
// Capability engine
// ============================================================

await test("subset rules: fs mode ranking + scopes", () => {
  const parent = normalizeCaps({ fs: { mode: "readonly", scopes: ["/proj"] } });
  assert(capsIsSubset(normalizeCaps({ fs: { mode: "none" } }), parent), "none ⊆ readonly");
  assert(
    capsIsSubset(normalizeCaps({ fs: { mode: "readonly", scopes: ["/proj/sub"] } }), parent),
    "narrower scope ⊆"
  );
  assert(
    !capsIsSubset(normalizeCaps({ fs: { mode: "readwrite", scopes: ["/proj"] } }), parent),
    "readwrite ⊄ readonly"
  );
  assert(
    !capsIsSubset(normalizeCaps({ fs: { mode: "readonly", scopes: ["/etc"] } }), parent),
    "/etc ⊄ /proj"
  );
  assert(
    !capsIsSubset(normalizeCaps({ fs: { mode: "readonly" } }), parent),
    "whole-tree ⊄ scoped parent"
  );
});

await test("subset rules: net/spawn/services", () => {
  const parent = normalizeCaps({
    net: { fetchHosts: ["api.example.com"], listen: [8080], loopbackConnect: true },
    spawn: { node: true, vm: false, boa: false },
    services: ["swc"],
  });
  assert(
    capsIsSubset(
      normalizeCaps({ net: { fetchHosts: ["api.example.com"], listen: false, loopbackConnect: false } }),
      parent
    ),
    "narrower net ⊆"
  );
  assert(!capsIsSubset(normalizeCaps({ net: { fetchHosts: "all" } }), parent), "all hosts ⊄ list");
  assert(!capsIsSubset(normalizeCaps({ net: { listen: true } }), parent), "any port ⊄ [8080]");
  assert(!capsIsSubset(normalizeCaps({ spawn: { vm: true } }), parent), "spawn.vm escalation");
  assert(!capsIsSubset(normalizeCaps({ services: ["duckdb"] }), parent), "service escalation");
  assert(capsIsSubset(boaDefault(), parent), "deny-all ⊆ anything");
  assert(capsIsSubset(parent, trustedDev()), "anything ⊆ trusted-dev");
});

await test("checkCap: fs mode + scopes at dispatch", () => {
  const ro = normalizeCaps({ fs: { mode: "readonly", scopes: ["/proj"] } });
  checkCap(OP["fs.open"], { path: "/proj/a.txt" }, ro); // no throw
  assertDenied(() => checkCap(OP["fs.write"], { path: "/proj/a.txt" }, ro), "fs.mode", "write on ro");
  assertDenied(() => checkCap(OP["fs.open"], { path: "/etc/passwd" }, ro), "fs.scopes", "outside scope");
  assertDenied(
    () => checkCap(OP["fs.rename"], { path: "/proj/a", path2: "/etc/b" }, trustedDevScoped()),
    "fs.scopes",
    "path2 checked too"
  );
  function trustedDevScoped() {
    return normalizeCaps({ fs: { mode: "readwrite", scopes: ["/proj"] } });
  }
});

await test("checkCap: net listen/fetch/loopback + services", () => {
  const caps = normalizeCaps({
    net: { fetchHosts: ["ok.example"], listen: [3000], loopbackConnect: false },
    services: ["swc"],
  });
  checkCap(OP["net.listen"], { port: 3000 }, caps);
  assertDenied(() => checkCap(OP["net.listen"], { port: 80 }, caps), "net.listen", "port not whitelisted");
  checkCap(OP["net.fetch_open"], { url: "https://ok.example/x" }, caps);
  assertDenied(
    () => checkCap(OP["net.fetch_open"], { url: "https://evil.example/" }, caps),
    "net.fetchHosts",
    "host blocked"
  );
  assertDenied(() => checkCap(OP["net.connect_loopback"], {}, caps), "net.loopbackConnect", "loopback");
  checkCap(OP["svc.invoke"], { service: "swc" }, caps);
  assertDenied(() => checkCap(OP["svc.invoke"], { service: "duckdb" }, caps), "services", "service");
  checkCap(OP["sys.clock"], {}, boaDefault()); // sys.* always allowed
});

await test("fromExposeConfig maps scripting expose to caps", () => {
  const caps = fromExposeConfig({ fs: "readonly", run: true });
  assertEqual(caps.fs.mode, "readonly", "fs mapped");
  assert(caps.spawn.vm && !caps.spawn.node, "run→spawn.vm only");
  assert(capsIsSubset(caps, trustedDev()), "expose caps ⊆ trusted-dev");
});

// ============================================================
// Process table
// ============================================================

await test("register/exit/waitpid lifecycle with reaping", async () => {
  const t = new ProcessTable();
  const child = t.register({ kind: "node", argv: ["node", "x.js"] });
  assertEqual(child.pid, 2, "first pid is 2 (pid 1 = root)");
  assertEqual(child.state, "running", "running");
  const wait = t.waitpid(child.pid, 1);
  t.exit(child.pid, 42);
  const info = await wait;
  assertEqual(info.exitCode, 42, "exit code");
  assertEqual(t.get(child.pid).state, "reaped", "reaped after waitpid");
  // waiting again on a reaped pid is ECHILD
  await t.waitpid(child.pid, 1).then(
    () => assert(false, "second waitpid should reject"),
    (e) => assertEqual(e.errno, ERRNO.ECHILD, "ECHILD")
  );
});

await test("zombie until waited; child-exit listener fires", async () => {
  const t = new ProcessTable();
  const child = t.register({ kind: "vm" });
  const events = [];
  t.onChildExit(1, (info) => events.push(info));
  t.exit(child.pid, 0);
  assertEqual(t.get(child.pid).state, "zombie", "zombie before wait");
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(events.length, 1, "SIGCHLD-equivalent delivered");
  const info = await t.waitpid(child.pid, 1);
  assertEqual(info.exitCode, 0, "late waitpid reaps");
});

await test("attenuation enforced at register; orphans reparent", () => {
  const t = new ProcessTable();
  const parent = t.register({ kind: "node", caps: normalizeCaps({ fs: { mode: "readonly" } }) });
  assertDenied(
    () => t.register({ kind: "node", ppid: parent.pid, caps: normalizeCaps({ fs: { mode: "readwrite" } }) }),
    "fs.mode",
    "escalation rejected"
  );
  const child = t.register({ kind: "node", ppid: parent.pid });
  assertEqual(child.caps.fs.mode, "readonly", "caps inherited");
  t.exit(parent.pid, 0);
  assertEqual(t.get(child.pid).ppid, 1, "orphan reparented to root");
});

await test("kernel.registerProcess defaults + proc.list", () => {
  const k = new Kernel();
  const vm = k.registerProcess({ kind: "vm-init", argv: ["nanovm"] });
  const boa = k.registerProcess({ kind: "boa", argv: ["script"] });
  assertEqual(vm.caps.fs.mode, "readwrite", "vm-init gets trusted-dev");
  assertEqual(boa.caps.fs.mode, "none", "boa gets deny-by-default");
  const list = k.proc.list();
  assertEqual(list.length, 3, "root + vm + boa");
  assert(list.some((p) => p.kind === "vm-init"), "ps shows vm-init");
});

// ============================================================
// Summary
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
