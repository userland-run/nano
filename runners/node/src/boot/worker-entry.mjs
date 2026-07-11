// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/worker-entry.mjs — the classic-worker entrypoint (spec §8.1).
// Establishes the Syscall Bus client (async hello + sync SAB caller), loads
// the binding fixtures, and hands control to the boot orchestrator. Runs in a
// worker_threads Worker under Node (tests) or a Web Worker in the browser.

import { workerContext, isNode } from "../platform.mjs";
import { BusClient } from "../../../../kernel/bus/client.mjs";
import { SyncCaller } from "../../../../kernel/bus/sab-channel.mjs";
import { boot } from "./boot.mjs";

const ctx = await workerContext();
const init = ctx.workerData;

async function loadFixtures() {
  if (init.fixtures) return init.fixtures;
  if (isNode) {
    const { readFileSync } = await import("node:fs");
    const dir = new URL("../../fixtures/generated/", import.meta.url);
    const read = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    return { options: read("options.json"), config: read("config.json"), constants: read("constants.json"), errno: read("errno.json") };
  }
  return {};
}

try {
  // Async plane: hello handshake (gates the sync SAB plane in the Kernel).
  const async = new BusClient({ pid: init.pid, token: init.token, asyncPort: init.asyncPort });
  await async.hello();

  // Sync plane: blocking calls over the SAB (Atomics.wait — legal in workers).
  const caller = new SyncCaller(init.channelSAB);
  const sync = (op, args) => caller.callSync(op, args);

  const fixtures = await loadFixtures();
  const code = await boot({ init, sync, async, fixtures });

  ctx.post({ type: "exit", code: typeof code === "number" ? code : 0 });
} catch (e) {
  ctx.post({ type: "fatal", error: (e && e.stack) ? e.stack : String(e) });
}
