#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// Applet difftest (UL-SPEC/applets T1, S2): the kernel-native applets (cat,
// echo, wc, head, tail, ls — JS in the Kernel, direct VFS access) must produce
// BYTE-IDENTICAL output to real BusyBox for their declared flag surface, and
// an undeclared flag must fall back per-invocation to the VM applet (S2).
//
// Heavy: needs wasm/nano.wasm + images/busybox. Run directly.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices, registerKernelApplets } from "../../../kernel/index.mjs";
import { createVmDelegate } from "../src/host/vm-delegate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(here, "..", "..", "wasm", "nano.wasm");
const busyboxPath = join(here, "..", "..", "images", "busybox");
if (!existsSync(busyboxPath)) { console.log("  SKIP: applet difftest (images/busybox not present)"); process.exit(0); }

const { NanoVM } = await import("../../riscv/host/nanovm.mjs");

const kernel = new Kernel();
await registerBuiltinServices(kernel);
const { vm } = await createVmDelegate(kernel, { NanoVM, wasm: readFileSync(wasmPath), busybox: readFileSync(busyboxPath), ramMB: 512 });
registerKernelApplets(kernel, { enable: ["cat", "echo", "wc", "head", "tail", "ls"] });

// Seed a corpus into the shared VFS.
kernel.vfs.mkdir("/d", 0o755);
kernel.vfs.rootMem.createFile("/d/three.txt", "one\ntwo\nthree\n");
kernel.vfs.rootMem.createFile("/d/words.txt", "the quick brown fox\njumps over\nthe lazy dog\n");
kernel.vfs.rootMem.createFile("/d/nums.txt", Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
kernel.vfs.rootMem.createFile("/d/a.txt", "a"); kernel.vfs.rootMem.createFile("/d/b.txt", "b"); kernel.vfs.rootMem.createFile("/d/c.txt", "c");

let passed = 0, failed = 0;

// Run an argv on a given tier delegate (wait:true) and return {stdout, code}.
async function onTier(tier, argv) {
  const delegate = kernel.router.delegateFor(tier);
  const proc = kernel.registerProcess({ kind: tier === "kernel" ? "service" : "vm", argv });
  const r = await delegate({ parent: proc, argv: tier === "vm" ? ["busybox", ...argv] : argv, cwd: "/", env: {}, wait: true });
  // The VM combines stdout+stderr (documented NanoVM behavior); compare
  // combined output so native applets (which split streams) match fairly.
  return { stdout: (r.stdout ?? "") + (r.stderr ?? ""), code: r.exitCode ?? 0 };
}

async function diff(name, argv) {
  const native = await onTier("kernel", argv);
  const busybox = await onTier("vm", argv);
  if (native.stdout === busybox.stdout && native.code === busybox.code) {
    passed++; console.log(`  PASS: ${name}  (native == BusyBox)`);
  } else {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    native : ${JSON.stringify(native.stdout)} (exit ${native.code})`);
    console.error(`    busybox: ${JSON.stringify(busybox.stdout)} (exit ${busybox.code})`);
  }
}

await diff("cat file", ["cat", "/d/three.txt"]);
await diff("cat -n", ["cat", "-n", "/d/three.txt"]);
await diff("cat missing (exit 1)", ["cat", "/d/nope.txt"]);
await diff("echo", ["echo", "hello", "world"]);
await diff("echo -n", ["echo", "-n", "no-newline"]);
await diff("wc file", ["wc", "/d/words.txt"]);
await diff("wc -l", ["wc", "-l", "/d/words.txt"]);
await diff("wc -w", ["wc", "-w", "/d/words.txt"]);
await diff("head -n 3", ["head", "-n", "3", "/d/nums.txt"]);
await diff("head default", ["head", "/d/nums.txt"]);
await diff("tail -n 4", ["tail", "-n", "4", "/d/nums.txt"]);
await diff("ls dir", ["ls", "/d"]);
await diff("ls -1", ["ls", "-1", "/d"]);

// S2: an undeclared flag falls back to the VM → identical to BusyBox by
// construction (same applet runs). We assert the fallback path produces the
// BusyBox result (not a native-specific error).
{
  const native = await onTier("kernel", ["cat", "-A", "/d/a.txt"]); // -A is undeclared → VM fallback
  const busybox = await onTier("vm", ["cat", "-A", "/d/a.txt"]);
  const name = "S2 fallback: undeclared flag (cat -A) → VM applet";
  if (native.stdout === busybox.stdout) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}\n    native ${JSON.stringify(native.stdout)}\n    busybox ${JSON.stringify(busybox.stdout)}`); }
}

console.log(`\n=== applet difftest (native vs BusyBox): ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
