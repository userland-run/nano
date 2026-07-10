// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/worker_threads.mjs — worker_threads over the Kernel (spec
// §10.3). A `new Worker(file)` spawns a nested nodert worker as a Kernel
// process (kind:"node"); messaging rides a Kernel IPC pipe pair with
// JSON-serialized structured-ish messages. workerData is passed at spawn.
// Full V8-serialize / SAB transfer is a later refinement (DIV-WT-JSON).

const NL = 10; // newline framing for JSON messages

function makeWorkerThreads({ sync, busAsync, Buffer, EventEmitter, init }) {
  const isMainThread = !init.isWorker;
  const threadId = init.pid ?? 0;

  // A message port over a Kernel pipe pair: JSON lines, async reads.
  class PipePort extends EventEmitter {
    constructor(readPipe, writePipe) {
      super();
      this._read = readPipe; this._write = writePipe; this._buf = "";
      this._closed = false;
      if (readPipe != null) { globalThis.__nodert_ref?.(); this._pump(); }
    }
    postMessage(value) {
      if (this._write == null || this._closed) return;
      const line = JSON.stringify({ v: value }) + "\n";
      sync("proc.pipe_write", { pipeId: this._write, data: new TextEncoder().encode(line).buffer });
    }
    async _pump() {
      try {
        for (;;) {
          if (this._closed) break;
          const r = await busAsync.call("proc.pipe_read", { pipeId: this._read });
          if (r.eof) { this.emit("close"); this.close(); break; }
          this._buf += new TextDecoder().decode(new Uint8Array(r.data));
          let nl;
          while ((nl = this._buf.indexOf("\n")) >= 0) {
            const line = this._buf.slice(0, nl); this._buf = this._buf.slice(nl + 1);
            if (line) { try { this.emit("message", JSON.parse(line).v); } catch {} }
          }
        }
      } catch { if (!this._closed) this.emit("close"); }
    }
    close() { if (this._closed) return; this._closed = true; globalThis.__nodert_unref?.(); if (this._write != null) { try { sync("proc.pipe_close", { pipeId: this._write }); } catch {} } }
    start() {}
    ref() { return this; } unref() { return this; }
  }

  // Inside a worker: parentPort is the child side of the IPC channel.
  const parentPort = init.isWorker && init.ipcRead != null
    ? new PipePort(init.ipcRead, init.ipcWrite)
    : null;
  const workerData = init.workerData ?? null;

  class Worker extends EventEmitter {
    constructor(filename, options = {}) {
      super();
      const isEval = options.eval;
      const argv = isEval ? ["node", "-e", String(filename)] : ["node", String(filename)];
      const r = sync("proc.spawn", {
        argv, cwd: options.cwd ?? undefined, env: options.env ?? undefined,
        wait: false, ipc: true, isWorker: true, workerData: options.workerData ?? null,
      });
      const res = r.result ?? r;
      this.threadId = res.pid ?? 0;
      this._port = new PipePort(res.ipcRead, res.ipcWrite);
      this._port.on("message", (m) => this.emit("message", m));
      this._port.on("close", () => this.emit("exit", 0));
      // stdout/stderr of the worker route to the parent (Node semantics).
      if (res.stdout != null) drainToConsole(res.stdout, false);
      if (res.stderr != null) drainToConsole(res.stderr, true);
      // child-exit → 'exit'
      busAsync?.onEvent((msg) => { if (msg.ev === "child-exit" && msg.pid === this.threadId) { this.emit("exit", msg.exitCode ?? 0); this._port.close(); } });
    }
    postMessage(value) { this._port.postMessage(value); }
    terminate() { sync("proc.kill", { pid: this.threadId, signal: "SIGKILL" }); this._port.close(); return Promise.resolve(0); }
    ref() { return this; } unref() { return this; }
  }

  function drainToConsole(pipeId, isErr) {
    (async () => {
      try { for (;;) { const r = await busAsync.call("proc.pipe_read", { pipeId }); if (r.eof) break; if (r.bytes > 0) { const s = new TextDecoder().decode(new Uint8Array(r.data)); (isErr ? globalThis.process.stderr : globalThis.process.stdout).write(s); } } } catch {}
    })();
  }

  const MessageChannel = class MessageChannel {
    constructor() { const { port1, port2 } = new globalThis.MessageChannel(); this.port1 = port1; this.port2 = port2; }
  };

  return { isMainThread, threadId, parentPort, workerData, Worker, MessageChannel, MessagePort: globalThis.MessagePort, setEnvironmentData: () => {}, getEnvironmentData: () => undefined };
}

export { makeWorkerThreads };
