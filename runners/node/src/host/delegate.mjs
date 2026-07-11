// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/delegate.mjs — registers nodert as the Kernel router's
// `node` spawn delegate (spec §12.1, §14.2). Once registered, any proc.spawn
// (or VM execve, §14.2) that resolves to the node tier lands here and runs on
// the host engine, with stdio bridged through Kernel pipes.
//
// Sync spawns (execSync/spawnSync) run the child to completion and return its
// captured output — the Kernel never blocks, so the sync-parent-while-child-
// runs pattern is sound (§12.2). Async spawns return a pid + stdio pipe ids
// the parent reads incrementally.

import { runNode } from "./runtime.mjs";

/**
 * @param {import("../../../../kernel/kernel.mjs").Kernel} kernel
 * @param {{ services?: string[] }} [opts]
 * @returns {() => void} unregister
 */
function registerNodertDelegate(kernel, opts = {}) {
  return kernel.router.registerDelegate("node", async (req) => {
    const { parent, argv, cwd, env, caps, wait, stdio } = req;
    const nodeArgs = argvToNode(argv);
    // Resolve a relative entry path against the spawn cwd (node build.js).
    if (nodeArgs.entryPath && !nodeArgs.entryPath.startsWith("/")) {
      nodeArgs.entryPath = joinPath(cwd ?? "/", nodeArgs.entryPath);
    }

    if (wait) {
      // execSync/spawnSync: run to completion, return captured output.
      const r = await runNode(kernel, {
        argv: ["node", ...nodeArgs.args],
        source: nodeArgs.evalCode,
        entryPath: nodeArgs.entryPath,
        cwd, env, caps, ppid: parent?.pid ?? 1,
        timeoutMs: req.timeoutMs ?? 60000,
      });
      return { exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
    }

    // Async child_process.spawn: pipes the parent drains via proc.pipe_read.
    const stdinPipe = kernel.pipes.create();
    const stdoutPipe = kernel.pipes.create();
    const stderrPipe = kernel.pipes.create();
    // IPC channel (child_process.fork / worker_threads): a crossed pipe pair.
    let ipc = null;
    if (req.ipc) {
      const parentToChild = kernel.pipes.create();
      const childToParent = kernel.pipes.create();
      ipc = { parentWrite: parentToChild.id, parentRead: childToParent.id, childWrite: childToParent.id, childRead: parentToChild.id };
    }
    const child = kernel.registerProcess({
      kind: "node", argv: ["node", ...nodeArgs.args], cwd, env, caps,
      ppid: parent?.pid ?? 1, stdio: [stdinPipe.id, stdoutPipe.id, stderrPipe.id],
    });
    // Fire-and-forget the run; on completion record the exit + emit child-exit.
    runNode(kernel, {
      argv: ["node", ...nodeArgs.args], source: nodeArgs.evalCode, entryPath: nodeArgs.entryPath,
      cwd, env, caps, ppid: parent?.pid ?? 1, timeoutMs: req.timeoutMs ?? 60000,
      _reuseProc: child, _stdout: stdoutPipe, _stderr: stderrPipe, _stdin: stdinPipe,
      workerData: req.workerData, isWorker: req.isWorker,
      ipcRead: ipc?.childRead, ipcWrite: ipc?.childWrite,
    }).then((r) => {
      stdoutPipe.closeWrite(); stderrPipe.closeWrite();
      kernel.proc.exit(child.pid, r.exitCode, r.signal);
    });
    return { pid: child.pid, stdin: stdinPipe.id, stdout: stdoutPipe.id, stderr: stderrPipe.id, ipcWrite: ipc?.parentWrite, ipcRead: ipc?.parentRead };
  });
}

function joinPath(a, b) {
  if (b.startsWith("/")) return b;
  const parts = (a + "/" + b).split("/"); const out = [];
  for (const s of parts) { if (s === "" || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
  return "/" + out.join("/");
}

// Interpret argv the way the child expects: ["node", "-e", code, ...args] or
// ["node", script.js, ...args] or ["node", ...args].
function argvToNode(argv) {
  const rest = argv.slice(1);
  const eIdx = rest.indexOf("-e");
  if (eIdx >= 0) return { evalCode: rest[eIdx + 1], args: rest.slice(eIdx + 2), entryPath: null };
  const script = rest.find((a) => !a.startsWith("-"));
  if (script) return { evalCode: null, entryPath: script, args: rest.slice(rest.indexOf(script) + 1) };
  return { evalCode: "", args: rest, entryPath: null };
}

export { registerNodertDelegate };
