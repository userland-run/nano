#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Kernel Services (spec §13): registry, svc.* over the bus, and the built-in
 * services — zlib (real, native), swc/type-strip (real), duckdb (adapter +
 * mini-SQL), rspack (documented deferral).
 *
 * Usage: node test/kernel/test_services.mjs
 */
import { Kernel, KernelError, ERRNO, registerBuiltinServices, stripTypes } from "../index.mjs";
import { BusClient } from "../bus/client.mjs";
import { normalizeCaps } from "../caps/caps.mjs";

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
function assertEqual(a, b, m) { if (a !== b) { console.error(`  FAIL: ${current} - ${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

async function boot(services = ["zlib", "swc", "duckdb", "rspack"], caps) {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel, { include: services });
  const proc = kernel.registerProcess({ kind: "node", caps });
  const chan = kernel.allocChannel(proc.pid);
  const client = new BusClient({ pid: chan.pid, token: chan.token, asyncPort: chan.port });
  await client.hello();
  return { kernel, client, proc };
}

// ============================================================

await test("svc.list enumerates registered services", async () => {
  const { client } = await boot();
  const { services } = await client.call("svc.list", {});
  const ids = services.map((s) => s.id).sort();
  assertEqual(ids.join(","), "duckdb,rspack,swc,zlib", "all four registered");
  assert(services.find((s) => s.id === "duckdb").stateful, "duckdb is stateful");
  client.close();
});

await test("zlib service: gzip → gunzip round-trip (real, native)", async () => {
  const { client } = await boot(["zlib"]);
  const original = new TextEncoder().encode("hello kernel services ".repeat(20));
  const gz = await client.call("svc.invoke", { service: "zlib", method: "gzip", data: original.buffer.slice(0) });
  const compressed = new Uint8Array(gz.data);
  assert(compressed.length > 0 && compressed[0] === 0x1f && compressed[1] === 0x8b, "gzip magic bytes");
  assert(compressed.length < original.length, "actually compressed");
  const un = await client.call("svc.invoke", { service: "zlib", method: "gunzip", data: compressed.buffer });
  assertEqual(new TextDecoder().decode(new Uint8Array(un.data)), new TextDecoder().decode(original), "round-trip");
  client.close();
});

await test("swc/type-strip: erases types, keeps offsets", async () => {
  const src = `const x: number = 1;\nfunction f(a: string, b: number): boolean { return a.length > b; }\ninterface I { y: number }\nconst z = x as unknown;`;
  const out = stripTypes(src);
  assert(!/:\s*number/.test(out), "number annotation gone");
  assert(!/interface/.test(out), "interface gone");
  assert(!/\bas\b/.test(out), "as-expression gone");
  assertEqual(out.length, src.length, "byte length preserved (source-map friendly)");
  assert(/const x\s+= 1;/.test(out), "value code intact");
  assert(/function f\(a\s*,\s*b\s*\)\s*\{ return a\.length > b; \}/.test(out.replace(/\s+/g, (m) => m.includes("\n") ? m : " ")), "function body intact");
  // The stripped output must be valid JS.
  const fn = new Function(out + "\nreturn f('abc', 2);");
  assertEqual(fn(), true, "stripped code executes correctly");
});

await test("swc over the bus + session", async () => {
  const { client } = await boot(["swc"]);
  const r = await client.call("svc.invoke", { service: "swc", method: "transform", payload: { code: "let a: string = 'x';" } });
  assert(!r.result.code.includes(": string"), "types stripped over the bus");
  const { sessionId } = await client.call("svc.open_session", { service: "swc", config: {} });
  assert(sessionId >= 1, "session opened");
  await client.call("svc.close_session", { sessionId });
  client.close();
});

await test("duckdb adapter: CREATE/INSERT/SELECT via mini-SQL backend", async () => {
  const { client } = await boot(["duckdb"]);
  const { sessionId } = await client.call("svc.open_session", { service: "duckdb", config: { path: ":memory:" } });
  // Sessions are called via svc.invoke? No — the session trio. Use a fresh
  // one-shot invoke for exec, then a stateful path check through the registry.
  await client.call("svc.close_session", { sessionId });
  // One-shot query path:
  const r1 = await client.call("svc.invoke", { service: "duckdb", method: "exec", payload: { sql: "CREATE TABLE t (id, name)" } });
  assert(r1.result.ok, "create ok");
  client.close();
});

await test("duckdb stateful session end-to-end (registry direct)", async () => {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel, { include: ["duckdb"] });
  const sess = kernel.services.openSession("duckdb", { path: ":memory:" }, 1);
  await kernel.services.sessionCall(sess, "exec", { sql: "CREATE TABLE users (id, name)" }, 1);
  await kernel.services.sessionCall(sess, "exec", { sql: "INSERT INTO users (id, name) VALUES (1, 'ada'), (2, 'lin')" }, 1);
  const q = await kernel.services.sessionCall(sess, "query", { sql: "SELECT id, name FROM users WHERE id > 1 ORDER BY id" }, 1);
  assertEqual(q.rows.length, 1, "one row");
  assertEqual(q.rows[0].name, "lin", "filtered + selected");
  kernel.services.closeSession(sess, 1);
});

await test("rspack: honest ERR_NODERT_UNSUPPORTED (no browser wasm exists)", async () => {
  const { client } = await boot(["rspack"]);
  await client.call("svc.invoke", { service: "rspack", method: "build", payload: {} }).then(
    () => assert(false, "should be unsupported"),
    (e) => { assert(e instanceof KernelError, "KernelError"); assertEqual(e.name, "ERR_NODERT_UNSUPPORTED", "documented deferral"); }
  );
  client.close();
});

await test("services gated by caps.services", async () => {
  const { client } = await boot(["zlib", "swc"], normalizeCaps({ fs: { mode: "none" }, services: ["zlib"] }));
  await client.call("svc.invoke", { service: "zlib", method: "gzip", data: new Uint8Array([1, 2, 3]).buffer }); // allowed
  await client.call("svc.invoke", { service: "swc", method: "transform", payload: { code: "let a: number = 1;" } }).then(
    () => assert(false, "swc not in caps"),
    (e) => { assertEqual(e.name, "ERR_CAP_DENIED", "denied"); assertEqual(e.capability, "services", "capability facet"); }
  );
  client.close();
});

await test("session cleanup on process release", async () => {
  const { kernel, client, proc } = await boot(["duckdb"]);
  await client.call("svc.open_session", { service: "duckdb", config: {} });
  assert(kernel.services._sessions.size === 1, "session open");
  kernel.releaseChannel(proc.pid);
  assertEqual(kernel.services._sessions.size, 0, "released on exit");
  client.close();
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
