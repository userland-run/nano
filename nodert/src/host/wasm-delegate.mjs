// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/wasm-delegate.mjs — registers the wasm tier as the router's
// "wasm" spawn delegate and teaches the router to route .wasm files to it
// (UL-SPEC/wasm-tier §6 T1). A command word resolving to a .wasm file on the
// VFS routes here; the module bytes are read from the VFS and run under the
// WASI runner as a kind:"wasm" process.

import { runWasm } from "./wasm-runtime.mjs";

/**
 * @param {import("../../../kernel/kernel.mjs").Kernel} kernel
 * @returns {() => void} unregister
 */
function registerWasmDelegate(kernel) {
  // Route a resolved-to-.wasm command to the wasm tier (T1).
  const origRoute = kernel.router.route.bind(kernel.router);
  kernel.router.route = (argv, hints = {}) => {
    const cmd = argv?.[0] ?? "";
    if ((/\.wasm$/.test(cmd) || hints.isWasm) && kernel.router.delegateFor("wasm")) {
      return { tier: "wasm", command: cmd.slice(cmd.lastIndexOf("/") + 1) };
    }
    return origRoute(argv, hints);
  };

  return kernel.router.registerDelegate("wasm", async (req) => {
    const { parent, argv, cwd, env, caps, wait } = req;
    const path = resolveOnPath(kernel, argv[0], cwd);
    if (!path) return { exitCode: 127, stderr: `${argv[0]}: not found\n`, stdout: "" };
    let wasmBytes;
    try { wasmBytes = readVfsBytes(kernel, path); }
    catch { return { exitCode: 126, stderr: `${argv[0]}: cannot read wasm\n`, stdout: "" }; }

    if (wait) {
      const r = await runWasm(kernel, { wasmBytes, argv, cwd, env, caps, ppid: parent?.pid ?? 1, timeoutMs: req.timeoutMs ?? 60000 });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    }
    // Async spawn: pipes the parent drains.
    const stdin = kernel.pipes.create(), stdout = kernel.pipes.create(), stderr = kernel.pipes.create();
    const child = kernel.registerProcess({ kind: "wasm", argv, cwd, env, caps, ppid: parent?.pid ?? 1, stdio: [stdin.id, stdout.id, stderr.id] });
    runWasm(kernel, { wasmBytes, argv, cwd, env, caps, ppid: parent?.pid ?? 1, _reuseProc: child, _stdout: stdout, _stderr: stderr, _stdin: stdin, timeoutMs: req.timeoutMs ?? 60000 })
      .then((r) => { stdout.closeWrite(); stderr.closeWrite(); kernel.proc.exit(child.pid, r.exitCode); });
    return { pid: child.pid, stdin: stdin.id, stdout: stdout.id, stderr: stderr.id };
  });
}

// PATH walk over the VFS (UL-SPEC/applets R1 — the symlink farm is the source
// of truth). Absolute/relative paths resolve directly; bare names search PATH.
function resolveOnPath(kernel, cmd, cwd) {
  const tryPath = (p) => { try { const st = kernel.vfs.stat(p); return st.isFile ? p : null; } catch { return null; } };
  if (cmd.startsWith("/")) return tryPath(cmd);
  if (cmd.includes("/")) return tryPath(join(cwd, cmd));
  const dirs = ["/usr/local/bin", "/usr/bin", "/bin"];
  for (const d of dirs) { const hit = tryPath(`${d}/${cmd}`) ?? tryPath(`${d}/${cmd}.wasm`); if (hit) return hit; }
  return null;
}
function join(a, b) { return (a.endsWith("/") ? a : a + "/") + b.replace(/^\.\//, ""); }

function readVfsBytes(kernel, path) {
  const fd = kernel.vfs.open(path, 0, 0);
  try {
    const st = kernel.vfs.stat(path);
    const out = new Uint8Array(st.size);
    let pos = 0;
    while (pos < st.size) { const n = kernel.vfs.read(fd, out, pos, st.size - pos, pos); if (n === 0) break; pos += n; }
    return out;
  } finally { kernel.vfs.close(fd); }
}

export { registerWasmDelegate };
