#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Cross-tier spawn (spec §12): a nodert process spawns another node program.
 * With the nodert delegate registered, argv[0]==="node" routes to a fresh
 * nodert worker; spawnSync/execSync run the child to completion while the
 * Kernel services BOTH the parked parent and the running child concurrently
 * (the Kernel never blocks — §12.2, the sync-parent/running-child property).
 *
 * Usage: node nodert/test/cross-tier.mjs
 */
import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";
import { registerNodertDelegate } from "../src/host/delegate.mjs";

let passed = 0, failed = 0;

async function run(name, source, expect, expectExit = 0) {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel);
  registerNodertDelegate(kernel); // node → nodert worker
  const r = await runNode(kernel, { argv: ["node", "-e", source], source, cwd: "/", env: {}, timeoutMs: 40000 });
  const okOut = typeof expect === "function" ? expect(r.stdout) : r.stdout === expect;
  if (okOut && r.exitCode === expectExit) { passed++; console.log(`  PASS: ${name}`); }
  else {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    exit ${r.exitCode} (want ${expectExit}) stdout ${JSON.stringify(r.stdout)}`);
    if (r.stderr) console.error(`    stderr ${r.stderr.slice(0, 300)}`);
  }
}

// A nodert parent spawns a nodert child via child_process — the whole chain
// runs on the host engine, two workers, stdio bridged through Kernel pipes.
await run(
  "spawnSync node child captures stdout",
  `const cp = require("child_process");
   const r = cp.spawnSync("node", ["-e", "console.log('hello from child')"], { encoding: "utf8" });
   process.stdout.write("parent got: " + r.stdout);
   process.stdout.write("status: " + r.status + "\\n");`,
  "parent got: hello from child\nstatus: 0\n"
);

await run(
  "child exit code propagates",
  `const cp = require("child_process");
   const r = cp.spawnSync("node", ["-e", "process.exit(7)"]);
   console.log("child exited", r.status);`,
  "child exited 7\n"
);

await run(
  "child computes and returns a value",
  `const cp = require("child_process");
   const r = cp.spawnSync("node", ["-e", "let s=0; for(let i=1;i<=100;i++) s+=i; console.log(s)"], { encoding: "utf8" });
   console.log("sum:", r.stdout.trim());`,
  "sum: 5050\n"
);

await run(
  "nested spawn: parent → child → grandchild",
  `const cp = require("child_process");
   const grand = "console.log('grandchild')";
   const child = "const cp=require('child_process'); const r=cp.spawnSync('node',['-e'," + JSON.stringify(grand) + "],{encoding:'utf8'}); process.stdout.write('child sees: '+r.stdout)";
   const r = cp.spawnSync("node", ["-e", child], { encoding: "utf8" });
   process.stdout.write("parent sees: " + r.stdout);`,
  "parent sees: child sees: grandchild\n"
);

await run(
  "child uses a Kernel service (zlib)",
  `const cp = require("child_process");
   const r = cp.spawnSync("node", ["-e", "const z=require('zlib'); console.log(z.gunzipSync(z.gzipSync('svc')).toString())"], { encoding: "utf8" });
   process.stdout.write("roundtrip: " + r.stdout);`,
  "roundtrip: svc\n"
);

// child_process.fork — a node child with an IPC channel (§12.2).
await (async () => {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel);
  registerNodertDelegate(kernel);
  kernel.vfs.mkdir("/app", 0o755);
  kernel.vfs.rootMem.createFile("/app/child.js", `process.on("message", (m) => { if (m.n < 4) process.send({ n: m.n + 1 }); else { console.log("child done " + m.n); process.exit(0); } });`);
  const src = `const cp = require("child_process");
   const c = cp.fork("/app/child.js");
   c.on("message", (m) => { console.log("parent " + m.n); c.send({ n: m.n + 1 }); });
   c.on("exit", (code) => { console.log("exit " + code); process.exit(0); });
   c.send({ n: 0 });`;
  const r = await runNode(kernel, { argv: ["node", "-e", src], source: src, cwd: "/", env: {}, timeoutMs: 20000 });
  const name = "child_process.fork IPC ping-pong";
  const want = "parent 1\nparent 3\nchild done 4\nexit 0\n";
  if (r.stdout === want && r.exitCode === 0) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}\n    got ${JSON.stringify(r.stdout)} exit ${r.exitCode}`); if (r.stderr) console.error(`    stderr ${r.stderr.split("\n").slice(0, 2).join(" | ")}`); }
})();

// Streaming child_process.spawn: a tool that writes its final chunk in the
// same turn it exits must still deliver EVERY byte to the parent before 'close'
// fires. Regression for the child-exit-races-the-last-pipe-chunk bug: 'close'
// waits for the stdout drain to reach EOF (Node semantics), so nothing is lost.
await (async () => {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel);
  // A minimal vm-tier delegate emulating a file-lister (like `rg --files`):
  // it writes several lines AND closeWrites AND exits, all in one microtask.
  kernel.router.registerDelegate("vm", (req) => {
    const stdin = kernel.pipes.create(), stdout = kernel.pipes.create(), stderr = kernel.pipes.create();
    const child = kernel.registerProcess({ kind: "applet", argv: req.argv, cwd: req.cwd, env: req.env, caps: req.caps, ppid: req.parent?.pid ?? 1, stdio: [stdin.id, stdout.id, stderr.id] });
    queueMicrotask(() => {
      stdout.write(new TextEncoder().encode("a.js\n"));
      stdout.write(new TextEncoder().encode("b.js\nc.js\n"));
      stdout.closeWrite(); stderr.closeWrite();
      kernel.proc.exit(child.pid, 0, null);
    });
    return { pid: child.pid, stdin: stdin.id, stdout: stdout.id, stderr: stderr.id };
  });
  kernel.router.pin("rg", "vm");
  const src = `const cp = require("child_process");
   const out = [];
   const ch = cp.spawn("rg", ["--files", "."], {});
   ch.stdout.on("data", (d) => out.push(d.toString()));
   ch.on("close", (code) => { process.stdout.write("close:" + code + " out:" + out.join("")); process.exit(0); });`;
  const r = await runNode(kernel, { argv: ["node", "-e", src], source: src, cwd: "/proj", env: {}, timeoutMs: 20000 });
  const name = "streaming spawn delivers the trailing chunk before 'close'";
  const want = "close:0 out:a.js\nb.js\nc.js\n";
  if (r.stdout === want && r.exitCode === 0) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}\n    got ${JSON.stringify(r.stdout)} exit ${r.exitCode}`); if (r.stderr) console.error(`    stderr ${r.stderr.split("\n").slice(0, 2).join(" | ")}`); }
})();

console.log(`\n=== cross-tier spawn: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
