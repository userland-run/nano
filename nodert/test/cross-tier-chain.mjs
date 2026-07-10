#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// M3-c: the cross-tier chain (spec §12.3). A nodert process invokes `sh -c`
// (the "vm" tier), the shell runs the script, and any `node …` it invokes
// routes BACK to a fresh nodert worker — stdio bridged through Kernel pipes
// end-to-end. This is the npm-lifecycle-script shape:
//   npm (nodert) → sh -c "<script>" (vm shell) → node build.js (nodert).
// The lean shell here is the headless stand-in for BusyBox (DIV-SH-LEAN); the
// real BusyBox `sh` is the "vm" delegate in the terminal/SDK.

import { Kernel, registerBuiltinServices, materializePackages } from "../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";
import { registerNodertDelegate } from "../src/host/delegate.mjs";
import { registerShellDelegate } from "../src/host/shell-delegate.mjs";

let passed = 0, failed = 0;

async function newKernel(seed) {
  const k = new Kernel();
  await registerBuiltinServices(k);
  registerNodertDelegate(k);
  registerShellDelegate(k);
  if (seed) seed(k);
  return k;
}
async function run(name, kernel, src, entryPath, expect, expectExit = 0) {
  const argv = entryPath ? ["node", entryPath] : ["node", "-e", src];
  const r = await runNode(kernel, { argv, source: src, entryPath, cwd: "/app", env: {}, timeoutMs: 30000 });
  const ok = typeof expect === "function" ? expect(r.stdout) : r.stdout === expect;
  if (ok && r.exitCode === expectExit) { passed++; console.log(`  PASS: ${name}`); }
  else {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    exit ${r.exitCode} (want ${expectExit}) stdout ${JSON.stringify(r.stdout)}`);
    if (r.stderr) console.error(`    stderr ${r.stderr.split("\n").slice(0, 3).join(" | ")}`);
  }
}

// 1. node → sh → node round-trip
{
  const k = await newKernel((k) => k.vfs.mkdir("/app", 0o755));
  await run("node → sh -c → node round-trip", k,
    `const cp=require("child_process"); process.stdout.write(cp.execSync("echo start && node -e \\"console.log(2+2)\\" && echo done", {encoding:"utf8"}))`,
    null, "start\n4\ndone\n");
}

// 2. sh sequencing + exit-code short-circuit (&&/||)
{
  const k = await newKernel((k) => k.vfs.mkdir("/app", 0o755));
  await run("sh &&/|| short-circuit on exit code", k,
    `const cp=require("child_process"); let out=cp.execSync("node -e \\"process.exit(1)\\" || echo recovered", {encoding:"utf8"}); process.stdout.write(out)`,
    null, "recovered\n");
}

// 3. npm-lifecycle-script showcase: `npm run build` → sh -c "node build.js"
{
  const k = await newKernel((k) => {
    k.vfs.mkdir("/app", 0o755);
    k.vfs.rootMem.createFile("/app/package.json", `{"name":"demo","version":"1.0.0","scripts":{"build":"node build.js"}}`);
    k.vfs.rootMem.createFile("/app/build.js", `const fs=require("fs"); fs.writeFileSync("/app/dist.txt","BUILT:"+(6*7)); console.log("build complete")`);
    k.vfs.rootMem.createFile("/app/run.js", `
      const fs=require("fs"), cp=require("child_process");
      const pkg = JSON.parse(fs.readFileSync("/app/package.json","utf8"));
      const script = pkg.scripts.build;              // "node build.js"
      const out = cp.execSync("sh -c " + JSON.stringify(script), { cwd: "/app", encoding: "utf8" });
      process.stdout.write("npm run build → " + out.trim() + "\\n");
      process.stdout.write("artifact: " + fs.readFileSync("/app/dist.txt","utf8") + "\\n");
    `);
  });
  await run("npm run build (nodert → sh → node build.js)", k, null, "/app/run.js",
    "npm run build → build complete\nartifact: BUILT:42\n");
}

// 4. install (CAS) + lifecycle: materialize a package, then a build script uses it
{
  const k = await newKernel((k) => {
    k.vfs.mkdir("/app", 0o755);
  });
  await materializePackages(k, "/app", {
    "slugify": { packageJson: { name: "slugify", version: "1.0.0", main: "index.js" }, files: { "index.js": { bytes: new TextEncoder().encode(`module.exports = (s) => s.toLowerCase().replace(/\\s+/g, "-");`) }, "package.json": { bytes: new TextEncoder().encode(`{"name":"slugify","version":"1.0.0","main":"index.js"}`) } } },
  });
  k.vfs.rootMem.createFile("/app/build.js", `const slug=require("slugify"); console.log(slug("Hello Cross Tier World"))`);
  k.vfs.rootMem.createFile("/app/run.js", `const cp=require("child_process"); process.stdout.write(cp.execSync("sh -c 'node build.js'", {cwd:"/app", encoding:"utf8"}))`);
  await run("install (CAS) + build uses the dependency", k, null, "/app/run.js", "hello-cross-tier-world\n");
}

console.log(`\n=== nodert cross-tier chain (M3-c): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
