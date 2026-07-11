#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// Real-app proof: the actual opencode agent CLI (its 16MB minified-ESM serve
// bundle) runs on the nodert HOST ENGINE. This is the "run-via-nodert" half of
// the install-via-VM / run-via-nodert flow — once opencode is on the shared
// VFS (installed/built by the VM tier or staged), the fast host-engine tier
// runs its CLI. Exercises the ESM loader at real scale (es-module-lexer),
// large-module loading, the permissive builtin facade, node:module/createRequire,
// child_process, fs (incl. Node-compatible error .code), and i18n/yargs.
//
// Skips if the opencode assets aren't present (they live in terminal/).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OC = [
  join(here, "..", "..", "..", "terminal", "public", "opencode"),
  join(here, "..", "..", "..", "terminal", "dist", "opencode"),
].find((d) => existsSync(join(d, "nano-files.json")));

if (!OC) {
  console.log("  SKIP: opencode assets not found (terminal/public/opencode) — nano-only CI");
  console.log("\n=== nodert real-app: opencode (SKIPPED) ===");
  process.exit(0);
}

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

// Stage the opencode tree into the shared VFS (the "installed" state the VM
// tier would produce; here staged directly).
function stage(k) {
  k.vfs.mkdir("/opencode", 0o755);
  for (const rel of JSON.parse(readFileSync(join(OC, "nano-files.json"), "utf8"))) {
    const dst = "/opencode/" + rel;
    let cur = ""; for (const p of dst.slice(0, dst.lastIndexOf("/")).split("/").filter(Boolean)) { cur += "/" + p; try { k.vfs.mkdir(cur, 0o755); } catch {} }
    k.vfs.rootMem.createFile(dst, new Uint8Array(readFileSync(join(OC, rel))));
  }
}
async function newKernel() { const k = new Kernel(); await registerBuiltinServices(k); stage(k); return k; }
const run = (k, args) => runNode(k, { argv: ["node", "/opencode/index-nano.js", ...args], entryPath: "/opencode/index-nano.js", cwd: "/opencode", env: { HOME: "/root", PATH: "/usr/bin" }, timeoutMs: 120000 });

await test("the 16MB opencode ESM bundle loads + executes on the host engine", async () => {
  const k = await newKernel();
  const r = await run(k, ["--help"]);
  // The real yargs CLI runs: command list + options are printed.
  assert(r.stdout.includes("opencode <command>"), "prints the CLI usage banner");
  assert(r.stdout.includes("serve"), "lists the serve command");
  assert(r.stdout.includes("--help"), "lists options");
  assert(r.exitCode === 0, `exit 0 (got ${r.exitCode})`);
});

await test("host-engine boot of the 16MB bundle is fast (< 8s, vs seconds-per-boot in the VM)", async () => {
  const k = await newKernel();
  const t0 = Date.now();
  const r = await run(k, ["--help"]);
  const ms = Date.now() - t0;
  assert(r.stdout.includes("opencode <command>"), "ran");
  assert(ms < 8000, `booted+ran in ${ms}ms`);
});

// Drive one loopback HTTP request into a listening in-Kernel server (replicates
// net.connect_loopback from the host: crossed pipes + a 'connection' event).
async function loopbackRequest(k, port, rawReq) {
  const l = k.ports.lookup(port);
  if (!l) return "(no listener)";
  const c2s = k.pipes.create(), s2c = k.pipes.create();
  k.hub.sendEvent(l.ownerPid, { ev: "connection", port, readPipe: c2s.id, writePipe: s2c.id, remotePort: 12345 });
  c2s.write(new TextEncoder().encode(rawReq));
  let resp = ""; const dec = new TextDecoder();
  for (let i = 0; i < 400; i++) {
    const r = s2c.read(65536);
    if (r === "eof") break;
    if (r) { resp += dec.decode(r, { stream: true }); if (resp.includes("\r\n\r\n")) break; }
    else await Promise.race([s2c.waitReadable(), new Promise((res) => setTimeout(res, 30))]);
  }
  return resp;
}

await test("opencode serve starts a listening HTTP server that handles requests [heavy]", async () => {
  const k = await newKernel();
  for (const p of ["/root", "/root/.local", "/root/.local/share"]) try { k.vfs.mkdir(p, 0o755); } catch {}
  const auth = "Basic " + Buffer.from("opencode:x").toString("base64");
  const results = new Promise((resolve) => {
    const off = k.ports.onListening(async (info) => {
      if ((info?.port ?? info) !== 4096) return; off?.();
      await new Promise((r) => setTimeout(r, 300)); // let the server settle its routes
      const unauth = await loopbackRequest(k, 4096, "GET / HTTP/1.1\r\nHost: 127.0.0.1:4096\r\nConnection: close\r\n\r\n");
      const authed = await loopbackRequest(k, 4096, `GET /doc HTTP/1.1\r\nHost: 127.0.0.1:4096\r\nAuthorization: ${auth}\r\nConnection: close\r\n\r\n`);
      resolve({ unauth, authed });
    });
  });
  const runP = runNode(k, { argv: ["node", "/opencode/index-nano.js", "serve", "--port", "4096"], entryPath: "/opencode/index-nano.js", cwd: "/opencode", env: { HOME: "/root", PATH: "/usr/bin", OPENCODE_SERVER_PASSWORD: "x", XDG_DATA_HOME: "/root/.local/share" }, timeoutMs: 10000 });
  const r = await Promise.race([results, runP.then(() => ({ unauth: "(server exited)", authed: "" }))]);
  assert(r.unauth.startsWith("HTTP/1.1 401"), `unauthed → 401 auth challenge (got: ${r.unauth.split("\r\n")[0]})`);
  assert(/www-authenticate/i.test(r.unauth), "server issued a WWW-Authenticate challenge (auth middleware ran)");
  assert(r.authed.startsWith("HTTP/1.1 200"), `authed GET /doc → 200 OK (got: ${r.authed.split("\r\n")[0]})`);
  await runP; // let the server shut down at its timeout
});

console.log(`\n=== nodert real-app: opencode on the host engine: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
