#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// install-via-VM / run-via-nodert — the recommended two-tier flow, demonstrated
// end-to-end with the REAL opencode agent CLI over ONE shared VFS:
//
//   • INSTALL phase → the RISC-V VM tier (real BusyBox). The gnarly, fidelity-
//     sensitive OS work — unpacking/staging a package tree, perms, layout — runs
//     on the emulator, which can run anything. (In production this is where
//     `npm install` runs: full network + tar + lifecycle scripts.)
//   • RUN phase → the nodert HOST-ENGINE tier. The hot loop — actually running
//     the tool — runs on the browser's own JS engine at ~68x the VM's speed.
//
// Both tiers share the same Kernel VFS, so files installed by the VM are run by
// nodert with zero copying. Run: node nodert/examples/install-vm-run-nodert.mjs

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices } from "../../kernel/index.mjs";
import { NanoVM } from "../../container/nanovm.mjs";
import { createVmDelegate } from "../src/host/vm-delegate.mjs";
import { registerNodertDelegate } from "../src/host/delegate.mjs";
import { createNodeEngine } from "../src/host/engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const OC = [
  join(root, "..", "terminal", "public", "opencode"),
  join(root, "..", "terminal", "dist", "opencode"),
].find((d) => existsSync(join(d, "nano-files.json")));
const WASM = join(root, "wasm", "nano.wasm");
const BUSYBOX = join(root, "images", "busybox");

if (!OC || !existsSync(WASM) || !existsSync(BUSYBOX)) {
  console.error("skip: needs terminal/public/opencode + wasm/nano.wasm + images/busybox");
  process.exit(0);
}

const log = (...a) => console.log(...a);

// ── one shared Kernel (VFS + syscall bus + services) for BOTH tiers ──
const kernel = new Kernel();
await registerBuiltinServices(kernel);

// The package arrives in a staging area (as a CDN/registry would deliver it).
log("• delivering the opencode package into the shared VFS (staging area)…");
kernel.vfs.mkdir("/staging", 0o755);
let bytes = 0;
for (const rel of JSON.parse(readFileSync(join(OC, "nano-files.json"), "utf8"))) {
  const dst = "/staging/" + rel;
  let cur = ""; for (const p of dst.slice(0, dst.lastIndexOf("/")).split("/").filter(Boolean)) { cur += "/" + p; try { kernel.vfs.mkdir(cur, 0o755); } catch {} }
  const b = readFileSync(join(OC, rel)); kernel.vfs.rootMem.createFile(dst, new Uint8Array(b)); bytes += b.length;
}
log(`  staged ${(bytes / 1e6).toFixed(1)}MB`);

// ── INSTALL phase: the RISC-V VM (real BusyBox) does the OS-level install ──
// It sees the SAME VFS. Here it lays out the install prefix and copies the
// package into place — the kind of shell work an install script performs.
log("\n• INSTALL phase — RISC-V VM (BusyBox) installing into /opt/opencode …");
const { vm } = await createVmDelegate(kernel, { NanoVM, wasm: readFileSync(WASM), busybox: readFileSync(BUSYBOX), ramMB: 512 });
// NanoVM.run whitespace-splits argv, so stage the install script as a file and
// run `sh <path>` (the real BusyBox shell over the shared VFS).
kernel.vfs.rootMem.createFile("/install.sh",
  "mkdir -p /opt\n" +
  "mv /staging /opt/opencode\n" +           // the VM lays the package into its prefix
  "echo INSTALLED to /opt/opencode\n" +
  "ls /opt/opencode | head -4\n");
const t0 = Date.now();
const install = await vm.run("sh /install.sh", { maxSteps: 2_000_000_000 });
log(`  VM stdout: ${JSON.stringify((install.stdout || "").trim())}`);
log(`  install (emulated BusyBox) took ${Date.now() - t0}ms`);

// ── RUN phase: nodert runs the installed CLI on the host engine ──
log("\n• RUN phase — nodert (host engine) running the installed opencode …");
registerNodertDelegate(kernel);
const engine = createNodeEngine(kernel, { engine: "auto", vmRun: async (argv, o) => ({ exitCode: 0, stdout: (await vm.run("sh -c " + JSON.stringify(argv.join(" ")), o)).stdout, stderr: "" }) });
const t1 = Date.now();
const r = await engine.node(["node", "/opt/opencode/index-nano.js", "--help"], { cwd: "/opt/opencode", env: { HOME: "/root", PATH: "/usr/bin" }, timeoutMs: 120000 });
log(`  ran on: ${r.engine}   (exit ${r.exitCode}, ${Date.now() - t1}ms)`);
log("  ── opencode --help output ──");
log((r.stdout || "").split("\n").map((l) => "  " + l).join("\n"));

const ok = r.engine === "nodert" && r.exitCode === 0 && r.stdout.includes("opencode <command>");
log(ok ? "\n✓ FLOW OK: BusyBox VM installed it, nodert ran it — one shared VFS." : "\n✗ flow did not complete");
process.exit(ok ? 0 : 1);
