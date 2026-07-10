#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * K7 tests: Kernel pipes (chunk queue, EOF, async wakeups), the signal
 * router (event delivery, SIGKILL terminator, ESRCH), and the spawn
 * routing table (pins, delegate gating, caps at the resolved tier).
 *
 * Usage: node test/kernel/test_proc_plumbing.mjs
 */
import { Kernel, KernelError, ERRNO } from "../../kernel/index.mjs";
import { Pipe, PipeRegistry } from "../../kernel/proc/pipes.mjs";
import { SpawnRouter } from "../../kernel/proc/router.mjs";
import { BusClient } from "../../kernel/bus/client.mjs";
import { normalizeCaps } from "../../kernel/caps/caps.mjs";

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
    console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`);
  }
}
const text = (s) => new TextEncoder().encode(s);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ============================================================
// Pipes
// ============================================================

await test("pipe: ordered reads across chunk boundaries + EOF", () => {
  const p = new Pipe(1);
  p.write(text("hello "));
  p.write(text("kernel pipes"));
  assertEqual(new TextDecoder().decode(p.read(8)), "hello ke", "read spans chunks");
  assertEqual(new TextDecoder().decode(p.read(100)), "rnel pipes", "drain");
  assertEqual(p.read(10), null, "open + empty → null");
  p.closeWrite();
  assertEqual(p.read(10), "eof", "eof after close");
});

await test("pipe: waitReadable wakes on write and on close", async () => {
  const p = new Pipe(1);
  let woke = 0;
  const w1 = p.waitReadable().then(() => woke++);
  await tick();
  assertEqual(woke, 0, "parked while empty");
  p.write(text("x"));
  await w1;
  assertEqual(woke, 1, "woken by write");
  p.read(10);
  const w2 = p.waitReadable().then(() => woke++);
  p.closeWrite();
  await w2;
  assertEqual(woke, 2, "woken by close");
});

await test("pipe registry: pairs and destroy", () => {
  const reg = new PipeRegistry();
  const { aToB, bToA } = reg.createPair();
  assert(aToB.id !== bToA.id, "distinct pipes");
  aToB.write(text("ping"));
  assertEqual(new TextDecoder().decode(reg.get(aToB.id).read(10)), "ping", "lookup by id");
  reg.destroy(aToB.id);
  assertEqual(reg.get(aToB.id), null, "destroyed");
  assertEqual(bToA.ended, false, "peer unaffected");
});

// ============================================================
// Signal router
// ============================================================

await test("kill delivers async-plane signal events to node processes", async () => {
  const kernel = new Kernel();
  const proc = kernel.registerProcess({ kind: "node" });
  const chan = kernel.allocChannel(proc.pid);
  const client = new BusClient({ pid: chan.pid, token: chan.token, asyncPort: chan.port });
  await client.hello();
  const events = [];
  client.onEvent((ev) => events.push(ev));
  kernel.signals.kill(proc.pid, "SIGTERM");
  await tick();
  assertEqual(events.length, 1, "one event");
  assertEqual(events[0].signal, "SIGTERM", "signal name");
  assertEqual(kernel.proc.get(proc.pid).state, "running", "SIGTERM not auto-fatal in the kernel");
  client.close();
  kernel.releaseChannel(proc.pid);
});

await test("SIGKILL runs the terminator and records the exit", () => {
  const kernel = new Kernel();
  const proc = kernel.registerProcess({ kind: "node" });
  let terminated = false;
  kernel.signals.registerTerminator(proc.pid, () => {
    terminated = true;
  });
  kernel.signals.kill(proc.pid, "SIGKILL");
  assert(terminated, "terminator ran");
  const rec = kernel.proc.get(proc.pid);
  assertEqual(rec.state, "zombie", "zombie");
  assertEqual(rec.signal, "SIGKILL", "signal recorded");
  try {
    kernel.signals.kill(proc.pid, "SIGTERM");
    assert(false, "killing a zombie is ESRCH");
  } catch (e) {
    assertEqual(e.errno, ERRNO.ESRCH, "ESRCH");
  }
});

// ============================================================
// Spawn router
// ============================================================

await test("router: vm-authoritative until a node delegate registers", () => {
  const r = new SpawnRouter();
  assertEqual(r.route(["node", "x.js"]).tier, "vm", "node → vm without delegate");
  const un = r.registerDelegate("node", () => {});
  assertEqual(r.route(["node", "x.js"]).tier, "node", "node → node with delegate");
  assertEqual(r.route(["/usr/bin/node", "x.js"]).tier, "node", "basename match");
  assertEqual(r.route(["sh", "-c", "ls"]).tier, "vm", "sh stays vm");
  assertEqual(r.route(["tsc"], { shebang: "#!/usr/bin/env node" }).tier, "node", "shebang routing");
  un();
  assertEqual(r.route(["node", "x.js"]).tier, "vm", "delegate unregistered");
});

await test("router: pins override and are enumerable/revertible (S4)", () => {
  const r = new SpawnRouter({ jest: "vm" });
  r.registerDelegate("node", () => {});
  assertEqual(r.route(["jest"]).tier, "vm", "pin wins");
  assertEqual(r.routing().jest, "vm", "enumerable");
  r.pin("grep", "kernel");
  assertEqual(r.route(["grep", "-r", "x"]).tier, "kernel", "applet pin");
  r.pin("grep", null);
  assertEqual(r.route(["grep"]).tier, "vm", "unpinned");
});

await test("proc.spawn over the bus: ENOSYS without delegate, runs with one, caps at resolved tier", async () => {
  const kernel = new Kernel();
  const proc = kernel.registerProcess({ kind: "node" });
  const chan = kernel.allocChannel(proc.pid);
  const client = new BusClient({ pid: chan.pid, token: chan.token, asyncPort: chan.port });
  await client.hello();

  await client.call("proc.spawn", { argv: ["busybox", "true"] }).then(
    () => assert(false, "no vm delegate yet"),
    (e) => assertEqual(e.errno, ERRNO.ENOSYS, "ENOSYS without delegate")
  );

  let spawned = null;
  kernel.router.registerDelegate("vm", (req) => {
    spawned = req;
    const child = kernel.registerProcess({ kind: "vm", argv: req.argv, ppid: req.parent.pid });
    return { pid: child.pid };
  });
  const { pid } = await client.call("proc.spawn", { argv: ["busybox", "echo", "hi"] });
  assert(pid > proc.pid, "child pid returned");
  assertEqual(spawned.argv.join(" "), "busybox echo hi", "delegate got argv");
  assertEqual(spawned.parent.pid, proc.pid, "parent threaded through");

  // A child without spawn.vm is denied at the RESOLVED tier.
  const restricted = kernel.registerProcess({
    kind: "node",
    caps: normalizeCaps({ fs: { mode: "readonly" }, spawn: { node: true, vm: false, boa: false } }),
  });
  const chan2 = kernel.allocChannel(restricted.pid);
  const client2 = new BusClient({ pid: chan2.pid, token: chan2.token, asyncPort: chan2.port });
  await client2.hello();
  await client2.call("proc.spawn", { argv: ["busybox", "true"] }).then(
    () => assert(false, "should be denied"),
    (e) => {
      assertEqual(e.name, "ERR_CAP_DENIED", "denied");
      assertEqual(e.capability, "spawn.vm", "resolved-tier capability");
    }
  );
  client.close();
  client2.close();
  kernel.releaseChannel(proc.pid);
  kernel.releaseChannel(restricted.pid);
});

// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
