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
import { SyscallBusHub } from "./bus/hub.mjs";
import { PortChannel } from "./bus/port-channel.mjs";
import { KernelVfs } from "./vfs/vfs.mjs";
import { ProcessTable } from "./proc/table.mjs";
import * as caps from "./caps/caps.mjs";
import * as profiles from "./caps/profiles.mjs";

class Kernel {
  /** @param {import("./types.d.mts").KernelOptions} [opts] */
  constructor(opts = {}) {
    this.opts = opts;
    this.protocol = { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR };

    this.vfs = new KernelVfs(opts.mounts);
    this.proc = new ProcessTable(opts.caps);
    this.caps = caps;
    this.profiles = profiles;
    this.hub = new SyscallBusHub(this);
    /** @type {Map<number, PortChannel>} pid → kernel-side channel */
    this._channels = new Map();
    this.ports = null; // K6: kernel/net/ports.mjs
    this.fetchBridge = null; // K6: kernel/net/fetch-bridge.mjs
    this.signals = null; // K7: kernel/proc/signals.mjs
    this.services = null; // registry for Kernel Services (SWC, DuckDB, …)
  }

  /**
   * Register an execution context as a Kernel process (spec §7.1).
   * Default caps by kind: vm-init/vm/node → trusted-dev (current behavior
   * unchanged), boa → deny-by-default. Attenuation is enforced by the table.
   * @returns {import("./types.d.mts").Process}
   */
  registerProcess(spec) {
    const caps =
      spec.caps ??
      (spec.kind === "boa" ? this.profiles.boaDefault() : this.profiles.trustedDev());
    return this.proc.register({ ...spec, caps });
  }

  /**
   * Allocate a Syscall Bus channel for a process (spec §5.1). Returns the
   * client's half: transfer `port` into the process's Worker and hand
   * `{pid, token, port}` to its BusClient. The kernel side stays attached
   * here. (The sync SAB half of the channel lands in K5.)
   */
  allocChannel(pid) {
    const proc = this.proc.get(pid);
    if (!proc) throw new Error(`allocChannel: unknown pid ${pid}`);
    const token = randomToken();
    const { port1, port2 } = new MessageChannel();
    const channel = new PortChannel(this.hub, proc, port1, token);
    this._channels.set(pid, channel);
    return { pid, token, port: port2 };
  }

  /** Tear down a process's channel (exit/kill path). */
  releaseChannel(pid) {
    const channel = this._channels.get(pid);
    if (channel) {
      channel.close();
      this._channels.delete(pid);
    }
    this.hub.releaseProcess(pid);
  }
}

function randomToken() {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { Kernel };
