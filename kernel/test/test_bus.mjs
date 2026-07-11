#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * K4 conformance tests for the async Syscall Bus plane: handshake,
 * correlation, fs/env/sys opcodes, capability denial on the wire,
 * transferables, watch events, waitpid over the bus.
 *
 * Uses the global MessageChannel (same-thread) — the async plane is
 * transport-identical whether or not a Worker sits on the other end.
 *
 * Usage: node test/kernel/test_bus.mjs
 */
import { Kernel, KernelError, ERRNO } from "../index.mjs";
import { BusClient } from "../bus/client.mjs";
import { normalizeCaps } from "../caps/caps.mjs";

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

/** Boot a kernel + a registered node process + a connected, hello'd client. */
async function boot(caps) {
  const kernel = new Kernel();
  const proc = kernel.registerProcess({ kind: "node", argv: ["node"], caps });
  const chan = kernel.allocChannel(proc.pid);
  const client = new BusClient({ pid: chan.pid, token: chan.token, asyncPort: chan.port });
  await client.hello();
  return { kernel, proc, client };
}

// ============================================================

await test("handshake acks the protocol version", async () => {
  const { kernel, client } = await boot();
  assert(client._helloAck.major === kernel.protocol.major, "major acked");
  client.close();
});

await test("bad token is rejected before any dispatch", async () => {
  const kernel = new Kernel();
  const proc = kernel.registerProcess({ kind: "node" });
  const chan = kernel.allocChannel(proc.pid);
  const client = new BusClient({ pid: chan.pid, token: "wrong", asyncPort: chan.port });
  await client.hello().then(
    () => assert(false, "hello should reject"),
    (e) => assert(/mismatch/.test(e.message), "token mismatch reported")
  );
  client.close();
});

await test("fs round-trip over the wire with transferables", async () => {
  const { client } = await boot();
  const { fd } = await client.call("fs.open", { path: "/bus.txt", flags: 0x41, mode: 0o644 });
  const payload = text("hello bus").buffer;
  const { bytes } = await client.call("fs.write", { fd, data: payload, pos: 0 }, [payload]);
  assertEqual(bytes, 9, "write count");
  assertEqual(payload.byteLength, 0, "request buffer was transferred, not copied");
  const r = await client.call("fs.read", { fd, len: 32, pos: 0 });
  assertEqual(r.bytes, 9, "read count");
  assertEqual(new TextDecoder().decode(new Uint8Array(r.data)), "hello bus", "content");
  await client.call("fs.close", { fd });
  const st = await client.call("fs.stat", { path: "/bus.txt" });
  assertEqual(st.size, 9, "stat over the bus");
  client.close();
});

await test("correlation: interleaved in-flight requests resolve to their callers", async () => {
  const { client } = await boot();
  await client.call("fs.mkdir", { path: "/many" });
  const writes = [];
  for (let i = 0; i < 8; i++) {
    writes.push(
      client
        .call("fs.open", { path: `/many/f${i}`, flags: 0x41 })
        .then(({ fd }) => client.call("fs.write", { fd, data: text("x".repeat(i + 1)).buffer, pos: 0 }))
    );
  }
  const results = await Promise.all(writes);
  results.forEach((r, i) => assertEqual(r.bytes, i + 1, `write ${i} got its own reply`));
  client.close();
});

await test("KernelError crosses the wire intact (ENOENT + cap denial)", async () => {
  const { client } = await boot(normalizeCaps({ fs: { mode: "readonly", scopes: ["/proj"] } }));
  await client.call("fs.stat", { path: "/proj/missing" }).then(
    () => assert(false, "should reject"),
    (e) => {
      assert(e instanceof KernelError, "KernelError reconstructed");
      assertEqual(e.errno, ERRNO.ENOENT, "ENOENT");
    }
  );
  await client.call("fs.open", { path: "/etc/passwd", flags: 0 }).then(
    () => assert(false, "should be denied"),
    (e) => {
      assertEqual(e.name, "ERR_CAP_DENIED", "cap denial name");
      assertEqual(e.errno, ERRNO.EACCES, "EACCES");
      assertEqual(e.capability, "fs.scopes", "capability field");
    }
  );
  client.close();
});

await test("unknown opcode → ENOSYS; env scoped to the process", async () => {
  const { client, proc } = await boot();
  await client.call("net.accept", { port: 80 }).then(
    () => assert(false, "net.accept not implemented"),
    (e) => assertEqual(e.errno, ERRNO.ENOSYS, "ENOSYS")
  );
  await client.call("env.set", { key: "FOO", value: "bar" });
  const { value } = await client.call("env.get", { key: "FOO" });
  assertEqual(value, "bar", "env round-trip");
  assertEqual(proc.env.FOO, "bar", "stored on the process record");
  client.close();
});

await test("fs.watch events arrive as unsolicited messages", async () => {
  const { client } = await boot();
  await client.call("fs.mkdir", { path: "/watched" });
  const events = [];
  client.onEvent((ev) => events.push(ev));
  const { watchId } = await client.call("fs.watch", { path: "/watched" });
  const { fd } = await client.call("fs.open", { path: "/watched/new.txt", flags: 0x41 });
  await client.call("fs.close", { fd });
  await tick();
  await tick();
  assert(events.some((e) => e.ev === "watch" && e.filename === "new.txt"), "watch event delivered");
  await client.call("fs.unwatch", { watchId });
  client.close();
});

await test("proc.list and waitpid work over the bus", async () => {
  const { kernel, client, proc } = await boot();
  // waitpid only reaps CHILDREN of the waiter — register under the client.
  const child = kernel.registerProcess({ kind: "vm", argv: ["busybox", "true"], ppid: proc.pid });
  const { procs } = await client.call("proc.list", {});
  assert(procs.some((p) => p.pid === child.pid), "child visible in ps");
  const waitP = client.call("proc.waitpid", { pid: child.pid });
  kernel.proc.exit(child.pid, 7);
  const info = await waitP;
  assertEqual(info.exitCode, 7, "waitpid resolves with the exit code");
  client.close();
});

await test("sys.caps_query reports caps + protocol", async () => {
  const { client } = await boot(normalizeCaps({ fs: { mode: "readonly" } }));
  const { caps, protocol } = await client.call("sys.caps_query", {});
  assertEqual(caps.fs.mode, "readonly", "caps echoed");
  assertEqual(protocol.major, 1, "protocol");
  client.close();
});

// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
