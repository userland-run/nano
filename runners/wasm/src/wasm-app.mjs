// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// runners/wasm/src/wasm-app.mjs — register core `apps/` tools (ripgrep,
// coreutils, …) compiled to wasm32-wasip1 as named commands on the wasm tier.
//
// Unlike the generic wasm-delegate (which routes a `foo.wasm` PATH entry and
// preopens caps.scopes), a core app is a NAMED command (`rg`) invoked with a
// working directory, and — like a normal Unix tool — its `.` must be that cwd.
// wasi-libc resolves "." against a preopen named "/", so we preopen the spawn
// cwd AS "/" (the tool sees its working dir as root). One "wasm-app" tier
// delegate serves a registry of name → module bytes; each registered name is
// pinned to that tier so `proc.spawn(["rg", …])` routes here.

import { runWasm } from "./wasm-runtime.mjs";

const TIER = "wasm-app";

/**
 * @param {import("../../../kernel/kernel.mjs").Kernel} kernel
 * @returns {{ register: (name: string, wasmBytes: Uint8Array) => () => void, apps: Map<string, Uint8Array> }}
 */
function createWasmAppRunner(kernel) {
  /** @type {Map<string, Uint8Array>} command name → wasm module bytes */
  const apps = new Map();

  kernel.router.registerDelegate(TIER, async (req) => {
    const { parent, argv, cwd, env, caps, wait } = req;
    const name = basename(argv[0] ?? "");
    const wasmBytes = apps.get(name);
    if (!wasmBytes) return { exitCode: 127, stdout: "", stderr: `${name}: not found\n` };
    // The tool's "." is its spawn cwd → preopen cwd AS "/".
    const preopens = [{ guestPath: "/", hostPath: cwd || "/", readonly: false }];

    if (wait) {
      const r = await runWasm(kernel, { wasmBytes, argv, cwd, env, caps, preopens, ppid: parent?.pid ?? 1, timeoutMs: req.timeoutMs ?? 60000 });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    }
    // Async spawn: the parent drains the returned pipes (child_process.spawn).
    const stdin = kernel.pipes.create(), stdout = kernel.pipes.create(), stderr = kernel.pipes.create();
    const child = kernel.registerProcess({ kind: "wasm", argv, cwd, env, caps, ppid: parent?.pid ?? 1, stdio: [stdin.id, stdout.id, stderr.id] });
    runWasm(kernel, { wasmBytes, argv, cwd, env, caps, preopens, ppid: parent?.pid ?? 1, _reuseProc: child, _stdout: stdout, _stderr: stderr, _stdin: stdin, timeoutMs: req.timeoutMs ?? 60000 })
      .then((r) => { stdout.closeWrite(); stderr.closeWrite(); kernel.proc.exit(child.pid, r.exitCode ?? 0); })
      .catch(() => { stdout.closeWrite(); stderr.closeWrite(); kernel.proc.exit(child.pid, 1); });
    return { pid: child.pid, stdin: stdin.id, stdout: stdout.id, stderr: stderr.id };
  });

  return {
    apps,
    /** Register a core app: pin its name → the wasm-app tier + store its bytes. */
    register(name, wasmBytes) {
      apps.set(name, wasmBytes);
      kernel.router.pin(name, TIER);
      return () => { apps.delete(name); kernel.router.pin(name, null); };
    },
  };
}

function basename(p) { return String(p).slice(String(p).lastIndexOf("/") + 1); }

export { createWasmAppRunner, TIER as WASM_APP_TIER };
