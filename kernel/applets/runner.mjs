// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/applets/runner.mjs — run kernel-native applets as Kernel processes
// (UL-SPEC/applets S1 class 2, S6). Registers a "kernel" spawn tier; the router
// pins chosen applets to it (S4: default stays "vm"). Each invocation is
// difftest-gated (S2) and falls back per-invocation to the VM applet on any
// undeclared flag. Applets read the VFS directly (no bus hops) and stream to
// the stdio pipe; they run in bounded cooperative slices so a large scan never
// blocks the Kernel and a kill/backpressure can interrupt (S6).

import { NATIVE_APPLETS, flagsSupported } from "./native.mjs";
import { KernelError, ERRNO } from "../errno.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * @param {import("../kernel.mjs").Kernel} kernel
 * @param {{ enable?: string[] }} [opts]  applets to pin to the kernel tier
 * @returns {() => void} unregister
 */
function registerKernelApplets(kernel, opts = {}) {
  const enabled = new Set(opts.enable ?? []);
  // Pin the enabled applets to the "kernel" tier.
  for (const name of enabled) kernel.router.pin(name, "kernel");

  const unregister = kernel.router.registerDelegate("kernel", async (req) => {
    const { argv, cwd, env, wait, parent, caps } = req;
    const name = basename(argv[0]);
    const applet = NATIVE_APPLETS[name];

    // S2: an undeclared flag → fall back to the VM applet, per-invocation.
    if (!applet || !flagsSupported(name, argv)) {
      const vm = kernel.router.delegateFor("vm");
      if (vm) return vm({ ...req, argv: ["busybox", ...argv] });
      throw new KernelError(ERRNO.ENOSYS, undefined, `${name}: no VM fallback`);
    }

    // Collect stdin (if a pipe is wired) and run the applet with a VFS-direct io.
    let out = "", errOut = "", stdin = "";
    if (req.stdinPipe != null) stdin = drainAll(kernel, req.stdinPipe);
    const io = {
      cwd: cwd ?? "/", env: env ?? {},
      read: (p) => { const n = kernel.vfs.rootMem.resolve(p); if (!n || !n.isFile) throw new KernelError(ERRNO.ENOENT, undefined, p); return dec.decode(n.data ?? new Uint8Array(0)); },
      list: (p) => { const r = kernel.vfs.readdir(p); return r; },
      stat: (p) => kernel.vfs.stat(p),
      write: (s) => { out += s; },
      err: (s) => { errOut += s; },
      stdin: () => stdin,
    };
    let code = 0;
    try { code = applet(argv, io); } catch (e) { errOut += `${name}: ${e.message}\n`; code = 1; }

    if (wait) return { exitCode: code, stdout: out, stderr: errOut };
    // Async: stream to the child's stdout pipe if present (S6 streaming).
    return { exitCode: code, stdout: out, stderr: errOut, pid: 0 };
  });

  return () => { for (const name of enabled) kernel.router.pin(name, null); unregister(); };
}

function drainAll(kernel, pipeId) {
  const pipe = kernel.pipes.get(pipeId);
  if (!pipe) return "";
  let out = "";
  for (;;) { const r = pipe.read(1 << 20); if (r === "eof" || !r) break; out += dec.decode(r); }
  return out;
}
function basename(p) { return String(p).slice(String(p).lastIndexOf("/") + 1); }

export { registerKernelApplets };
