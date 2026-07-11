#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// The nodert /dev/__net__ device (Tier-1 outbound HTTP) → Kernel fetch bridge →
// the in-page LLM bridge. This is the path opencode's LLM traffic takes on
// nodert: a guest writes the "METHOD url\nHeaders\n\nbody" wire form to
// /dev/__net__ and reads the framed HTTP/1.1 response; requests to
// nanoinfer.internal are handed to the registered LLM bridge (the in-browser
// WebGPU model in production; a mock OpenAI-compatible handler here).

import { Kernel, registerBuiltinServices } from "../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
function assertEqual(a, b, m) { if (a !== b) { console.error(`  FAIL: ${current} - ${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

// A guest program that speaks the /dev/__net__ wire form and returns the
// assistant text (or the raw framed response for the error cases).
const CLIENT = (payload) => `
const fs = require("fs");
const fd = fs.openSync("/dev/__net__", "r+");
fs.writeSync(fd, Buffer.from("POST http://nanoinfer.internal/v1/chat/completions\\nContent-Type: application/json\\n\\n" + ${JSON.stringify(payload)}));
let resp = ""; const buf = Buffer.alloc(65536);
for (;;) { const n = fs.readSync(fd, buf, 0, buf.length); if (n === 0) break; resp += buf.subarray(0, n).toString(); }
fs.closeSync(fd);
process.stdout.write(resp);
`;

async function runClient(k, payload) {
  const src = CLIENT(payload);
  const r = await runNode(k, { argv: ["node", "-e", src], source: src, cwd: "/", env: {}, timeoutMs: 15000 });
  return r.stdout;
}

await test("chat completion round-trips through /dev/__net__ → nanoinfer LLM bridge", async () => {
  const k = new Kernel(); await registerBuiltinServices(k);
  let seen = null;
  k.fetchBridge.setLlmBridge(async ({ method, url, body }) => {
    seen = { method, url, body };
    const req = JSON.parse(body || "{}");
    const reply = "echo:" + (req.messages?.at(-1)?.content ?? "");
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }] }) };
  });
  const resp = await runClient(k, JSON.stringify({ model: "ornith-1.0-9b", messages: [{ role: "user", content: "hello nanoinfer" }] }));
  assert(resp.startsWith("HTTP/1.1 200"), `framed 200 response (got ${resp.split("\r\n")[0]})`);
  const json = JSON.parse(resp.slice(resp.indexOf("\r\n\r\n") + 4));
  assertEqual(json.choices[0].message.content, "echo:hello nanoinfer", "assistant content from the bridge");
  // The bridge saw the exact request the guest sent.
  assertEqual(seen.method, "POST", "method forwarded");
  assert(seen.url.startsWith("http://nanoinfer.internal/v1/chat/completions"), "url forwarded");
  assertEqual(JSON.parse(seen.body).model, "ornith-1.0-9b", "body forwarded (model)");
});

await test("no LLM bridge registered → a framed 502 (not a crash)", async () => {
  const k = new Kernel(); await registerBuiltinServices(k); // no setLlmBridge
  const resp = await runClient(k, JSON.stringify({ messages: [{ role: "user", content: "x" }] }));
  assert(resp.startsWith("HTTP/1.1 502"), `framed 502 (got ${resp.split("\r\n")[0]})`);
  assert(/no LLM bridge/i.test(resp), "explains the missing bridge");
});

await test("streaming (SSE) completion flows through the device", async () => {
  const k = new Kernel(); await registerBuiltinServices(k);
  k.fetchBridge.setLlmBridge(async () => {
    const chunks = ["data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n", "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n", "data: [DONE]\n\n"];
    const stream = new ReadableStream({ start(c) { const enc = new TextEncoder(); for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: stream };
  });
  const resp = await runClient(k, JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }));
  assert(resp.includes("text/event-stream"), "SSE content-type preserved");
  assert(resp.includes('"content":"Hel"') && resp.includes('"content":"lo"'), "both stream deltas delivered");
  assert(resp.includes("[DONE]"), "terminal SSE frame delivered");
});

console.log(`\n=== nodert LLM bridge over /dev/__net__: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
