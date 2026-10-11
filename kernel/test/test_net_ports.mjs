#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * K6 tests: PortTable semantics (EADDRINUSE, ephemeral allocation,
 * listening events, per-pid cleanup) and the net.fetch_* opcodes over the
 * bus against data: URLs (no network needed).
 *
 * Usage: node test/kernel/test_net_ports.mjs
 */
import { Kernel, KernelError, ERRNO } from "../index.mjs";
import { PortTable } from "../net/ports.mjs";
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

async function boot(caps) {
  const kernel = new Kernel();
  const proc = kernel.registerProcess({ kind: "node", caps });
  const chan = kernel.allocChannel(proc.pid);
  const client = new BusClient({ pid: chan.pid, token: chan.token, asyncPort: chan.port });
  await client.hello();
  return { kernel, proc, client };
}

// ============================================================
// PortTable
// ============================================================

await test("listen/lookup/EADDRINUSE/close", () => {
  const t = new PortTable();
  const events = [];
  t.onListening((ev) => events.push(ev));
  assertEqual(t.listen(2, 8080, { kind: "vm" }), 8080, "explicit port");
  assertEqual(t.lookup(8080).ownerPid, 2, "lookup");
  assertEqual(events.length, 1, "listening event");
  try {
    t.listen(3, 8080, { kind: "node" });
    assert(false, "should throw EADDRINUSE");
  } catch (e) {
    assertEqual(e.errno, ERRNO.EADDRINUSE, "EADDRINUSE");
  }
  try {
    t.close(3, 8080);
    assert(false, "close by non-owner rejected");
  } catch (e) {
    assertEqual(e.errno, ERRNO.EINVAL, "EINVAL for non-owner");
  }
  t.close(2, 8080);
  assertEqual(t.lookup(8080), null, "closed");
});

await test("ephemeral allocation + closeAllFor", () => {
  const t = new PortTable();
  const p1 = t.listen(2, 0, { kind: "node" });
  const p2 = t.listen(2, 0, { kind: "node" });
  assert(p1 >= 49152 && p2 >= 49152 && p1 !== p2, "distinct ephemeral ports");
  t.listen(3, 9999, { kind: "vm" });
  t.closeAllFor(2);
  assertEqual(t.list().length, 1, "pid 2 listeners gone");
  assertEqual(t.list()[0].port, 9999, "pid 3 listener survives");
});

// ============================================================
// net.* over the bus
// ============================================================

await test("net.listen over the bus emits a structured listening event", async () => {
  const { kernel, client, proc } = await boot();
  const events = [];
  kernel.ports.onListening((ev) => events.push(ev));
  const { port } = await client.call("net.listen", { port: 3000 });
  assertEqual(port, 3000, "bound");
  assertEqual(events[0].pid, proc.pid, "event carries owner pid");
  await client.call("net.listen", { port: 3000 }).then(
    () => assert(false, "EADDRINUSE expected"),
    (e) => assertEqual(e.errno, ERRNO.EADDRINUSE, "EADDRINUSE over the wire")
  );
  await client.call("net.close_listener", { port: 3000 });
  assertEqual(kernel.ports.lookup(3000), null, "closed over the wire");
  client.close();
});

await test("listen respects caps.net.listen whitelist", async () => {
  const { client } = await boot(
    normalizeCaps({ fs: { mode: "none" }, net: { listen: [4000], fetchHosts: "none", loopbackConnect: false } })
  );
  const { port } = await client.call("net.listen", { port: 4000 });
  assertEqual(port, 4000, "whitelisted port ok");
  await client.call("net.listen", { port: 4001 }).then(
    () => assert(false, "should be denied"),
    (e) => assertEqual(e.name, "ERR_CAP_DENIED", "denied by caps")
  );
  client.close();
});

// The bridge only fetches absolute http(s) URLs, so the stream tests stub
// fetch() (no network needed) and record what the bridge asked for.
const realFetch = globalThis.fetch;
let fetchSeen = null;
function stubFetch(body) {
  globalThis.fetch = async (url, init) => {
    fetchSeen = { url, init };
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  };
}

await test("net.fetch_open/read/abort stream a stubbed https response", async () => {
  const { client } = await boot();
  stubFetch("hello fetch bridge");
  const { streamId } = await client.call("net.fetch_open", {
    method: "GET",
    url: "https://example.test/hello",
  });
  assertEqual(fetchSeen && fetchSeen.init.credentials, "omit", "fetch sent with credentials: omit");
  let out = new Uint8Array(0);
  let eof = false;
  while (!eof) {
    const r = await client.call("net.fetch_read", { streamId, len: 7 });
    if (r.eof) {
      eof = true;
    } else {
      const merged = new Uint8Array(out.length + r.bytes);
      merged.set(out, 0);
      merged.set(new Uint8Array(r.data), out.length);
      out = merged;
    }
  }
  const text = new TextDecoder().decode(out);
  assert(text.startsWith("HTTP/1.1 200"), `framed response head (${text.slice(0, 20)})`);
  assert(text.endsWith("hello fetch bridge"), "body delivered");
  // Reading a dead stream is EBADF
  await client.call("net.fetch_read", { streamId, len: 1 }).then(
    () => assert(false, "stream should be gone after EOF"),
    (e) => assertEqual(e.errno, ERRNO.EBADF, "EBADF after EOF")
  );
  client.close();
});

await test("release cleans a process's ports and streams", async () => {
  const { kernel, client, proc } = await boot();
  await client.call("net.listen", { port: 5001 });
  stubFetch("x");
  const { streamId } = await client.call("net.fetch_open", { url: "https://example.test/x" });
  assert(streamId >= 1, "stream open");
  kernel.releaseChannel(proc.pid);
  assertEqual(kernel.ports.lookup(5001), null, "port released");
  assertEqual(kernel.hub._netStreams.size, 0, "streams released");
  client.close();
});

await test("non-http(s) and relative URLs are refused without fetching", async () => {
  const { client } = await boot();
  for (const url of ["data:text/plain,x", "/relative/path", "file:///etc/passwd", "blob:x"]) {
    fetchSeen = null;
    stubFetch("must not be served");
    const { streamId } = await client.call("net.fetch_open", { url });
    const r = await client.call("net.fetch_read", { streamId, len: 4096 });
    const head = new TextDecoder().decode(new Uint8Array(r.data));
    assert(head.startsWith("HTTP/1.1 400"), `${url} → 400 (${head.slice(0, 16)})`);
    assertEqual(fetchSeen, null, `${url} never reaches fetch()`);
  }
  client.close();
});
globalThis.fetch = realFetch;

// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
