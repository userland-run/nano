// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/runtime.mjs — the main-thread driver for the nodert tier.
// Given a Kernel, it registers a `node` process, wires stdio pipes, allocates
// a Syscall Bus channel, spawns the worker, and runs a script — collecting
// stdout/stderr and the exit code. This is what the SDK's nano.node({engine:
// "nodert"}) calls under the hood (spec §14).

import { spawnWorker, isNode } from "../platform.mjs";
import { loadLibBundle } from "./lib-loader.mjs";

const workerEntry = new URL("../boot/worker-entry.mjs", import.meta.url).href;

/**
 * Run a Node program on the nodert tier.
 * @param {import("../../../../kernel/kernel.mjs").Kernel} kernel
 * @param {{ argv: string[], source?: string, entryPath?: string, env?: object,
 *           cwd?: string, caps?: object, ppid?: number,
 *           onStdout?: (b: Uint8Array) => void, onStderr?: (b: Uint8Array) => void,
 *           timeoutMs?: number }} opts
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, signal: string|null }>}
 */
async function runNode(kernel, opts) {
  const { argv, source, entryPath, env = {}, cwd = "/", caps, ppid = 1 } = opts;

  // Reuse a pre-registered process + pipes (async child_process.spawn path),
  // or create fresh ones (the common case).
  const stdin = opts._stdin ?? kernel.pipes.create();
  const stdout = opts._stdout ?? kernel.pipes.create();
  const stderr = opts._stderr ?? kernel.pipes.create();

  const proc = opts._reuseProc ?? kernel.registerProcess({
    kind: "node",
    argv,
    cwd,
    env: { ...env },
    caps,
    ppid,
    stdio: [stdin.id, stdout.id, stderr.id],
  });

  const chan = kernel.allocChannel(proc.pid);

  // The host loads the node-lib bundle + fixtures ONCE (cached, SAB-backed) and
  // passes them in init — required in the browser (no fs/brotli), and a win
  // under Node too: every worker shares the bundle zero-copy and skips its own
  // disk-read + brotli-decompress (~9ms/spawn). `opts.lib` injects a pre-loaded
  // bundle; `opts.noHostLib` forces the worker's own disk path (Node only).
  const lib = opts.lib ?? (opts.noHostLib && isNode ? null : await loadLibBundle({ fetch: opts.fetch }));

  let outBuf = "";
  let errBuf = "";
  const dec = new TextDecoder();
  const drainDone = [];
  const drain = (pipe, onData, append) => {
    drainDone.push((async () => {
      for (;;) {
        const r = pipe.read(1 << 16);
        if (r === "eof") break;
        if (r) {
          append(dec.decode(r, { stream: true }));
          onData?.(r);
        } else {
          await pipe.waitReadable();
        }
      }
    })());
  };
  // When the child's pipes are consumed by a parent guest (async spawn), the
  // host must not also drain them — it would steal the bytes.
  const hostDrains = !opts._noDrain && !opts._reuseProc;
  if (hostDrains) {
    drain(stdout, opts.onStdout, (s) => { outBuf += s; });
    drain(stderr, opts.onStderr, (s) => { errBuf += s; });
  }

  const init = {
    pid: chan.pid,
    token: chan.token,
    asyncPort: chan.port,
    channelSAB: chan.sab,
    caps: proc.caps,
    argv,
    env: proc.env,
    cwd,
    nodeLibVersion: "v25.4.0",
    protocolVersion: kernel.protocol.major,
    // Browser: host-provided bundle + fixtures (Node: null → worker reads disk).
    libIndex: lib?.libIndex ?? null,
    libBytes: lib?.libBytes ?? null,
    fixtures: lib?.fixtures ?? null,
    source: source ?? null,
    entryPath: entryPath ?? null,
    inputType: opts.inputType ?? null,
    // worker_threads / fork: workerData + IPC pipe ids for the child.
    workerData: opts.workerData ?? null,
    isWorker: !!opts.isWorker,
    ipcRead: opts.ipcRead ?? null,
    ipcWrite: opts.ipcWrite ?? null,
    stdio: { isTTY: [false, false, false] },
  };

  const worker = spawnWorker(workerEntry, init, [chan.port]);

  // The worker's hard-kill hook: Worker.terminate() (spec §7.4 SIGKILL).
  kernel.signals.registerTerminator(proc.pid, () => worker.terminate());

  const exit = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    worker.onMessage((msg) => {
      if (msg?.type === "exit") finish({ exitCode: msg.code ?? 0, signal: null });
      else if (msg?.type === "fatal") finish({ exitCode: 1, signal: null, error: msg.error });
    });
    worker.onError((err) => finish({ exitCode: 1, signal: null, error: String(err?.message ?? err) }));
    if (opts.timeoutMs) {
      const t = setTimeout(() => finish({ exitCode: 124, signal: null, error: "timeout" }), opts.timeoutMs);
      if (t.unref) t.unref();
    }
  });

  worker.terminate();
  // The worker posts "exit" only after its final synchronous stdio_write, but
  // those bytes may still be queued in the Kernel pipe. Close the write ends so
  // the drain loops see EOF, then await them so no output is lost.
  if (hostDrains) {
    stdout.closeWrite();
    stderr.closeWrite();
    await Promise.all(drainDone);
  }
  // When reusing a caller-owned process, the caller owns exit/pipe lifecycle.
  if (!opts._reuseProc) {
    kernel.proc.exit(proc.pid, exit.exitCode, exit.signal);
    kernel.releaseChannel(proc.pid);
  } else {
    kernel.releaseChannel(proc.pid);
  }

  return {
    exitCode: exit.exitCode,
    signal: exit.signal,
    stdout: outBuf + dec.decode(),
    stderr: errBuf,
    error: exit.error,
  };
}

export { runNode };
