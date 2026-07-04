#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Unit tests for the /dev/__net__ streaming network bridge (container/nanovm.mjs).
 * Pure Node.js - no WASM needed. Drives the NanoVM class net methods directly
 * against a mock VM memory (same approach as test_memfs.mjs uses for MemFS).
 *
 * Covers:
 *   1. Streaming responses: chunks reach the guest incrementally (EOF framing,
 *      no content-length), reads that arrive early park and re-complete.
 *   2. setLlmBridge(): nanoinfer.internal requests bypass fetch and stream.
 *   3. Legacy byte-compat: small responses with content-length keep the exact
 *      old fully-buffered framing (_httpResp).
 *   4. Mid-stream reader error surfaces as EIO after queued data drains.
 *   5. Early guest close cancels the host reader.
 *
 * Usage: node test/test_net.mjs
 */
import { NanoVM } from "../container/nanovm.mjs";

let passed = 0;
let failed = 0;
let current = "";
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

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
    console.error(`  FAIL: ${current} - ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
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
      console.log(`  OK: ${name}`);
    }
  } catch (e) {
    console.error(`  FAIL: ${name} - ${e.stack || e.message}`);
    failed++;
  }
}

// ---- mock VM plumbing -------------------------------------------------------

const A0_OFF = 80;      // a0 register (x[10]) at vmPtr + 80
const STATUS_OFF = 528; // run status at vmPtr + 528
const BUF_GADDR = 8192; // guest address used for read buffers

function makeVM() {
  const vm = new NanoVM();
  vm._memory = { buffer: new ArrayBuffer(1 << 20) };
  vm._vmPtr = 0;
  vm._ramPtr = 65536;
  return vm;
}

const a0 = (vm) => Number(new DataView(vm._memory.buffer).getBigInt64(vm._vmPtr + A0_OFF, true));

// Fake fetch Response: only the surface _respToNetStream touches.
function makeResp(status, statusText, headerMap, body, bodyBytes) {
  const entries = Object.entries(headerMap);
  return {
    status,
    statusText,
    headers: {
      forEach(cb) { for (const [k, v] of entries) cb(v, k); },
      get(k) { const e = entries.find(([ek]) => ek.toLowerCase() === k.toLowerCase()); return e ? e[1] : null; },
    },
    body,
    arrayBuffer: async () => bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength),
  };
}

// Submit a guest request ("METHOD URL\nHeader: v\n\nbody") and run the host
// fetch, exactly like the run loop does after the write/close sentinel.
async function sendRequest(vm, reqText) {
  vm._netReq = [enc(reqText)];
  await vm._netFetch();
}

// One guest read() against the sentinel fd, replaying the run-loop park
// protocol: serve; if parked (_blockedOnNet), sleep in _parkNet and retry.
async function guestRead(vm, bufLen = 4096) {
  for (;;) {
    vm._blockedOnNet = false;
    vm._serveNetRead(BUF_GADDR, bufLen);
    if (vm._blockedOnNet) { await vm._parkNet(); continue; }
    const n = a0(vm);
    if (n <= 0) return { n, bytes: new Uint8Array(0) };
    return { n, bytes: new Uint8Array(vm._memory.buffer, vm._ramPtr + BUF_GADDR, n).slice() };
  }
}

// Drain reads until EOF (or error); returns all bytes + the final a0.
async function guestReadAll(vm, bufLen = 4096) {
  const parts = [];
  for (;;) {
    const { n, bytes } = await guestRead(vm, bufLen);
    if (n <= 0) return { finalN: n, bytes: concat(parts) };
    parts.push(bytes);
  }
}

function concat(parts) {
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const realFetch = globalThis.fetch;

console.log("=== Net Bridge Streaming Unit Tests ===\n");

// ============================================================
// 1. Streaming response: incremental chunks, EOF framing
// ============================================================

await test("streaming response reaches the guest incrementally", async () => {
  const vm = makeVM();
  let ctrl;
  const rs = new ReadableStream({ start(c) { ctrl = c; } });
  globalThis.fetch = async () => makeResp(200, "OK", { "content-type": "text/event-stream" }, rs);

  await sendRequest(vm, "GET https://example.com/stream\n\n");

  // Head is available immediately, before any body byte exists.
  const head = await guestRead(vm);
  const headText = dec(head.bytes);
  assert(headText.startsWith("HTTP/1.1 200 OK\r\n"), `head status line, got: ${headText.slice(0, 40)}`);
  assert(headText.endsWith("\r\n\r\n"), "head terminated by CRLFCRLF");
  assert(!/content-length/i.test(headText), "streamed head has no content-length");
  assert(/content-type: text\/event-stream/i.test(headText), "server headers forwarded");

  // Each chunk is delivered as it arrives: the guest read parks first, then
  // the delayed enqueue wakes it.
  const chunks = ["data: tok1\n\n", "data: tok2\n\n", "data: [DONE]\n\n"];
  for (const c of chunks) {
    const pending = guestRead(vm); // parks: queue is empty, stream open
    setTimeout(() => ctrl.enqueue(enc(c)), 10);
    const r = await pending;
    assertEqual(dec(r.bytes), c, "incremental chunk");
  }

  // Stream end -> read() returns 0 (EOF framing; nfetch read_to_end stops here).
  const done = guestRead(vm);
  setTimeout(() => ctrl.close(), 10);
  const r = await done;
  assertEqual(r.n, 0, "EOF after stream close");
  assert(vm._netStream.eofDelivered, "EOF recorded for stale-stream cleanup");
});

// ============================================================
// 2. setLlmBridge: internal origin bypasses fetch, streams SSE
// ============================================================

await test("setLlmBridge streams to the guest without fetch()", async () => {
  const vm = makeVM();
  globalThis.fetch = async () => { throw new Error("fetch must not be called for nanoinfer.internal"); };

  let ctrl;
  const rs = new ReadableStream({ start(c) { ctrl = c; } });
  let seenReq = null;
  vm.setLlmBridge(async (req) => {
    seenReq = req;
    return { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" }, body: rs };
  });

  await sendRequest(vm,
    'POST http://nanoinfer.internal/v1/chat/completions\ncontent-type: application/json\n\n{"model":"m","stream":true}');

  assert(seenReq !== null, "bridge handler invoked");
  assertEqual(seenReq.method, "POST", "bridge method");
  assertEqual(seenReq.url, "http://nanoinfer.internal/v1/chat/completions", "bridge url");
  assertEqual(seenReq.headers["content-type"], "application/json", "bridge headers");
  assertEqual(seenReq.body, '{"model":"m","stream":true}', "bridge body");

  const head = await guestRead(vm);
  assert(dec(head.bytes).startsWith("HTTP/1.1 200 OK\r\n"), "bridge head");

  const tokens = ['data: {"delta":"Hel"}\n\n', 'data: {"delta":"lo"}\n\n'];
  for (const t of tokens) {
    const pending = guestRead(vm);
    setTimeout(() => ctrl.enqueue(enc(t)), 5);
    const r = await pending;
    assertEqual(dec(r.bytes), t, "bridge token chunk");
  }
  const done = guestRead(vm);
  setTimeout(() => ctrl.close(), 5);
  assertEqual((await done).n, 0, "bridge EOF");
});

await test("setLlmBridge Uint8Array body uses buffered framing", async () => {
  const vm = makeVM();
  globalThis.fetch = async () => { throw new Error("fetch must not be called"); };
  vm.setLlmBridge(async () => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: '{"ok":true}' }));
  await sendRequest(vm, "POST https://nanoinfer.internal/v1/models\n\n{}");
  const { finalN, bytes } = await guestReadAll(vm);
  assertEqual(finalN, 0, "clean EOF");
  const expected = dec(vm._httpResp(200, "OK", { "content-type": "application/json" }, enc('{"ok":true}')));
  assertEqual(dec(bytes), expected, "exact _httpResp framing");
});

await test("unregistered bridge yields 502, not a fetch", async () => {
  const vm = makeVM();
  globalThis.fetch = async () => { throw new Error("fetch must not be called"); };
  await sendRequest(vm, "GET http://nanoinfer.internal/v1/models\n\n");
  const { bytes } = await guestReadAll(vm);
  assert(dec(bytes).startsWith("HTTP/1.1 502 Bad Gateway\r\n"), "502 for missing bridge");
  assert(/no LLM bridge registered/.test(dec(bytes)), "explanatory body");
});

// ============================================================
// 3. Legacy byte-compat: small response with content-length
// ============================================================

await test("small content-length response keeps the exact legacy framing", async () => {
  const vm = makeVM();
  const bodyBytes = enc("hello from the old path");
  const headerMap = {
    "content-type": "text/plain",
    "content-length": String(bodyBytes.length),
    "x-custom": "kept",
  };
  // body non-null (a real fetch Response has one) but must NOT be read on this path.
  let streamRead = false;
  const fakeBody = { getReader() { streamRead = true; return new ReadableStream().getReader(); } };
  globalThis.fetch = async () => makeResp(200, "OK", headerMap, fakeBody, bodyBytes);

  await sendRequest(vm, "GET https://example.com/small\n\n");
  const { finalN, bytes } = await guestReadAll(vm, 7); // odd buffer size: exercise chunk splitting

  assertEqual(finalN, 0, "clean EOF");
  // Byte-identical to the pre-streaming bridge: it returned exactly
  // _httpResp(status, statusText, hdrs, await resp.arrayBuffer()).
  const hdrs = {}; for (const [k, v] of Object.entries(headerMap)) hdrs[k] = v;
  const expected = vm._httpResp(200, "OK", hdrs, bodyBytes);
  assertEqual(dec(bytes), dec(expected), "byte-identical legacy framing");
  assert(!streamRead, "body stream untouched (arrayBuffer path)");
});

await test("large content-length response streams instead of buffering", async () => {
  const vm = makeVM();
  const big = 512 * 1024; // > NET_BUFFER_MAX (256 KiB)
  let ctrl;
  const rs = new ReadableStream({ start(c) { ctrl = c; } });
  globalThis.fetch = async () =>
    makeResp(200, "OK", { "content-type": "application/octet-stream", "content-length": String(big) }, rs);
  await sendRequest(vm, "GET https://example.com/big\n\n");
  const head = await guestRead(vm);
  assert(!/content-length/i.test(dec(head.bytes)), "big response head has no content-length");
  const pending = guestRead(vm);
  setTimeout(() => { ctrl.enqueue(new Uint8Array(1024).fill(7)); ctrl.close(); }, 5);
  const r = await pending;
  assertEqual(r.n, 1024, "body chunk streamed");
  assertEqual((await guestRead(vm)).n, 0, "EOF");
});

// ============================================================
// 4. Mid-stream reader error -> EIO after the queue drains
// ============================================================

await test("reader error surfaces as EIO after queued data drains", async () => {
  const vm = makeVM();
  let ctrl;
  const rs = new ReadableStream({ start(c) { ctrl = c; } });
  globalThis.fetch = async () => makeResp(200, "OK", {}, rs);
  await sendRequest(vm, "GET https://example.com/flaky\n\n");
  await guestRead(vm); // head
  const pending = guestRead(vm);
  setTimeout(() => { ctrl.enqueue(enc("partial")); ctrl.error(new Error("boom")); }, 5);
  const r = await pending;
  assertEqual(dec(r.bytes), "partial", "queued data still served after error");
  const err = await guestRead(vm);
  assertEqual(err.n, -5, "then read returns -EIO");
});

// ============================================================
// 5. Early guest close cancels the host reader
// ============================================================

await test("early close cancels the host reader and drops the stream", async () => {
  const vm = makeVM();
  let ctrl, cancelled = false;
  const rs = new ReadableStream({ start(c) { ctrl = c; }, cancel() { cancelled = true; } });
  globalThis.fetch = async () => makeResp(200, "OK", {}, rs);
  await sendRequest(vm, "GET https://example.com/endless\n\n");
  await guestRead(vm); // head (marks the stream as served)
  const pending = guestRead(vm);
  setTimeout(() => ctrl.enqueue(enc("chunk-1")), 5);
  await pending;
  vm._netOnClose(); // guest close()s the fd mid-stream
  await new Promise((r) => setTimeout(r, 5)); // let the cancel propagate
  assert(cancelled, "host reader cancelled");
  assertEqual(vm._netStream, null, "stream dropped for the next request");
});

await test("close without reading keeps the response (printf>dev; cat dev)", async () => {
  const vm = makeVM();
  const bodyBytes = enc("kept");
  globalThis.fetch = async () =>
    makeResp(200, "OK", { "content-length": String(bodyBytes.length) }, null, bodyBytes);
  await sendRequest(vm, "GET https://example.com/kept\n\n");
  vm._netOnClose(); // close before any read: served=false, stream must survive
  assert(vm._netStream !== null, "unread response survives the writing fd's close");
  const { bytes } = await guestReadAll(vm);
  assert(dec(bytes).endsWith("kept"), "follow-up open+read still serves the body");
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
