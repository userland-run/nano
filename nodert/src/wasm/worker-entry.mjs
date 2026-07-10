// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/wasm/worker-entry.mjs — the wasm-tier worker (UL-SPEC/wasm-tier
// §4.1). Connects the Syscall Bus (hello + sync SAB), instantiates the
// wasip1 module with the WASI shim bound to the Kernel, and calls _start.

import { workerContext } from "../platform.mjs";
import { BusClient } from "../../../kernel/bus/client.mjs";
import { SyncCaller } from "../../../kernel/bus/sab-channel.mjs";
import { createWasiShim } from "./wasi-shim.mjs";

const ctx = await workerContext();
const init = ctx.workerData;

try {
  const async = new BusClient({ pid: init.pid, token: init.token, asyncPort: init.asyncPort });
  await async.hello();
  const caller = new SyncCaller(init.channelSAB);
  const sync = (op, args) => caller.callSync(op, args);

  let instance = null;
  let exitCode = 0;
  const { shim, WasiExit } = createWasiShim({
    argv: init.argv,
    env: init.env,
    preopens: init.preopens ?? [],
    sync,
    getMemory: () => instance.exports.memory,
    onExit: (c) => { exitCode = c; },
    trace: init.wasiTrace ? (msg) => { try { sync("proc.stdio_write", { fd: 2, data: new TextEncoder().encode("[wasi] " + msg + "\n").buffer }); } catch {} } : null,
  });

  const module = await WebAssembly.compile(new Uint8Array(init.wasmBytes));
  const imports = { wasi_snapshot_preview1: shim, wasi_unstable: shim };
  instance = await WebAssembly.instantiate(module, imports);

  try {
    if (typeof instance.exports._start === "function") instance.exports._start();
    else if (typeof instance.exports.main === "function") instance.exports.main();
  } catch (e) {
    if (e instanceof WasiExit) exitCode = e.code;
    else {
      // A wasm trap (unreachable/OOB) → exit 134 with the message on stderr (§4.1 X3).
      try { sync("proc.stdio_write", { fd: 2, data: new TextEncoder().encode(String(e?.message ?? e) + "\n").buffer }); } catch {}
      exitCode = 134;
    }
  }
  try { sync("proc.exit", { code: exitCode }); } catch {}
  ctx.post({ type: "exit", code: exitCode });
} catch (e) {
  ctx.post({ type: "fatal", error: (e && e.stack) ? e.stack : String(e) });
}
