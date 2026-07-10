// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/kernel.mjs — the tier-agnostic OS layer (spec UL-SPEC/nodert §4).
//
// The Kernel owns all cross-process state: VFS, Syscall Bus hub, process
// table, port table, capability engine, signal router, service registry.
// It is a plain class instantiated in whatever thread hosts the VM
// (terminal: main thread; SDK: the nano worker) — "the Kernel runs
// wherever the VM runs". The dedicated Kernel Worker topology is a
// transport change only (§4.2).
//
// K0 scaffold: subsystems land phase by phase (K2 vfs, K3 proc/caps,
// K4/K5 bus, K6 net, K7 pipes/signals/router).

import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./bus/opcodes.mjs";
import { KernelVfs } from "./vfs/vfs.mjs";

class Kernel {
  /** @param {import("./types.d.mts").KernelOptions} [opts] */
  constructor(opts = {}) {
    this.opts = opts;
    this.protocol = { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR };

    this.vfs = new KernelVfs(opts.mounts);
    this.proc = null; // K3: kernel/proc/table.mjs
    this.caps = null; // K3: kernel/caps/caps.mjs
    this.hub = null; // K4/K5: kernel/bus/hub.mjs
    this.ports = null; // K6: kernel/net/ports.mjs
    this.fetchBridge = null; // K6: kernel/net/fetch-bridge.mjs
    this.signals = null; // K7: kernel/proc/signals.mjs
    this.services = null; // registry for Kernel Services (SWC, DuckDB, …)
  }
}

export { Kernel };
