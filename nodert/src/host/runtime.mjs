// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/runtime.mjs — the main-thread driver for the nodert tier.
// Given a Kernel, it registers a `node` process, wires stdio pipes, allocates
// a Syscall Bus channel, spawns the worker, and runs a script — collecting
// stdout/stderr and the exit code. This is what the SDK's nano.node({engine:
// "nodert"}) calls under the hood (spec §14).

import { spawnWorker } from "../platform.mjs";

const workerEntry = new URL("../boot/worker-entry.mjs", import.meta.url).href;

/**
 * Run a Node program on the nodert tier.
 * @param {import("../../../kernel/kernel.mjs").Kernel} kernel
 * @param {{ argv: string[], source?: string, entryPath?: string, env?: object,
 *           cwd?: string, caps?: object, ppid?: number,
 *           onStdout?: (b: Uint8Array) => void, onStderr?: (b: Uint8Array) => void,
 *           timeoutMs?: number }} opts
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, signal: string|null }>}
 */
async function runNode(kernel, opts) {
  const { argv, source, entryPath, env = {}, cwd = "/", caps, ppid = 1 } = opts;

  // Kernel pipes for the child's stdio; the host drains stdout/stderr.
  const stdin = kernel.pipes.create();
  const stdout = kernel.pipes.create();
  const stderr = kernel.pipes.create();

  const proc = kernel.registerProcess({
    kind: "node",
    argv,
    cwd,
    env: { ...env },
    caps,
    ppid,
    stdio: [stdin.id, stdout.id, stderr.id],
  });

  const chan = kernel.allocChannel(proc.pid);

  let outBuf = "";
  let errBuf = "";
  const dec = new TextDecoder();
  const drain = (pipe, onData, append) => {
    (async () => {
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
    })();
  };
  drain(stdout, opts.onStdout, (s) => { outBuf += s; });
  drain(stderr, opts.onStderr, (s) => { errBuf += s; });

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
    source: source ?? null,
    entryPath: entryPath ?? null,
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
  kernel.proc.exit(proc.pid, exit.exitCode, exit.signal);
  kernel.releaseChannel(proc.pid);

  return {
    exitCode: exit.exitCode,
    signal: exit.signal,
    stdout: outBuf + dec.decode(),
    stderr: errBuf,
    error: exit.error,
  };
}

export { runNode };
