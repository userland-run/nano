#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * K5 tests for the sync SAB plane + the S2 microbenchmark. A worker_threads
 * Worker plays the nodert process (Atomics.wait is illegal on the main
 * thread); the Kernel runs here and must keep servicing WITHOUT blocking.
 *
 * S2 targets (spec-plan): round-trip p50 < 50µs · 1 MB chunked read < 2 ms.
 * The CI assertion is deliberately looser (p50 < 1 ms, 1 MB < 50 ms) to
 * avoid flaking on loaded machines; measured numbers are printed.
 *
 * Usage: node test/kernel/test_sab.mjs
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { Kernel } from "../../kernel/index.mjs";
import { normalizeCaps } from "../../kernel/caps/caps.mjs";

let passed = 0;
let failed = 0;

function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

const kernelUrl = new URL("../../kernel/", import.meta.url).href;

// The worker script: hello over the async plane, then a scripted series of
// sync calls whose results are posted back for assertion.
const workerSource = `
import { parentPort, workerData } from "node:worker_threads";
import { BusClient } from "${kernelUrl}bus/client.mjs";
import { SyncCaller } from "${kernelUrl}bus/sab-channel.mjs";

const { pid, token, port, sab } = workerData;
const client = new BusClient({ pid, token, asyncPort: port });
await client.hello();
const sync = new SyncCaller(sab);
const out = {};

// 1. basic round-trip
const { fd } = sync.callSync("fs.open", { path: "/sync.txt", flags: 0x41, mode: 0o644 });
out.wrote = sync.callSync("fs.write", { fd, data: new TextEncoder().encode("sync plane"), pos: 0 }).bytes;
const r = sync.callSync("fs.read", { fd, len: 64, pos: 0 });
out.readBack = new TextDecoder().decode(new Uint8Array(r.data));
sync.callSync("fs.close", { fd });

// 2. errors + capability denial
try { sync.callSync("fs.stat", { path: "/nope" }); out.enoent = "no-throw"; }
catch (e) { out.enoent = e.name + ":" + e.errno; }
try { sync.callSync("fs.open", { path: "/etc/secret", flags: 0x41 }); out.denied = "no-throw"; }
catch (e) { out.denied = e.name + ":" + (e.capability ?? "?"); }

// 3. large payloads through the 256 KiB window (chunked both directions)
const big = new Uint8Array(1024 * 1024);
for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
const { fd: bfd } = sync.callSync("fs.open", { path: "/big.bin", flags: 0x41 });
out.bigWrote = sync.callSync("fs.write", { fd: bfd, data: big, pos: 0 }).bytes;
const br = sync.callSync("fs.read", { fd: bfd, len: big.length, pos: 0 });
const got = new Uint8Array(br.data);
out.bigOk = got.length === big.length && got.every((b, i) => b === (i & 0xff));
sync.callSync("fs.close", { fd: bfd });

// 4. S2 bench: small-call latency + 1MB chunked read
const N = 2000;
sync.callSync("fs.stat", { path: "/sync.txt" }); // warm
const lat = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  sync.callSync("fs.stat", { path: "/sync.txt" });
  lat.push(performance.now() - t0);
}
lat.sort((a, b) => a - b);
out.p50us = Math.round(lat[Math.floor(N * 0.5)] * 1000);
out.p99us = Math.round(lat[Math.floor(N * 0.99)] * 1000);
const { fd: mfd } = sync.callSync("fs.open", { path: "/big.bin", flags: 0 });
const t0 = performance.now();
for (let i = 0; i < 10; i++) sync.callSync("fs.read", { fd: mfd, len: big.length, pos: 0 });
out.mbReadMs = (performance.now() - t0) / 10;
sync.callSync("fs.close", { fd: mfd });

parentPort.postMessage(out);
`;

const kernel = new Kernel();
const proc = kernel.registerProcess({
  kind: "node",
  argv: ["node", "sab-test"],
  caps: normalizeCaps({
    fs: { mode: "readwrite", scopes: ["/sync.txt", "/big.bin", "/nope"] },
  }),
});
const chan = kernel.allocChannel(proc.pid);

const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`), {
  workerData: chan,
  transferList: [chan.port],
});

const out = await new Promise((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
  setTimeout(() => reject(new Error("worker timeout")), 60_000).unref();
});
await worker.terminate();
kernel.releaseChannel(proc.pid);

check(out.wrote === 10, "sync write count");
check(out.readBack === "sync plane", "sync read round-trip");
check(out.enoent === "ENOENT:2", `ENOENT crosses the sync plane (${out.enoent})`);
check(out.denied === "ERR_CAP_DENIED:fs.scopes", `cap denial crosses the sync plane (${out.denied})`);
check(out.bigWrote === 1024 * 1024, "1 MB chunked request write");
check(out.bigOk === true, "1 MB chunked response read byte-exact");
console.log(`  S2 bench: p50=${out.p50us}µs p99=${out.p99us}µs 1MB-read=${out.mbReadMs.toFixed(2)}ms (targets: 50µs / 2ms)`);
check(out.p50us < 1000, `S2 CI bound: p50 ${out.p50us}µs < 1000µs`);
check(out.mbReadMs < 50, `S2 CI bound: 1MB read ${out.mbReadMs.toFixed(2)}ms < 50ms`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
