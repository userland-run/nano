// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/proc/signals.mjs — cross-tier signal routing (spec §7.4).
// node-kind: delivered as an async-plane event; nodert dispatches through
// signal_wrap → process.emit(signal). SIGKILL is never delivered to the
// guest: the Kernel runs the registered terminator (Worker.terminate) and
// records the exit. vm-init: forwarded to the VM's signal delegate.

import { ERRNO, KernelError } from "../errno.mjs";

class SignalRouter {
  /** @param {import("../kernel.mjs").Kernel} kernel */
  constructor(kernel) {
    this.kernel = kernel;
    /** @type {Map<number, () => void>} pid → hard-kill hook (Worker.terminate) */
    this._terminators = new Map();
    /** @type {(pid: number, signal: string) => void} VM-internal signal path */
    this._vmDelegate = null;
  }

  /** Register the hard-kill hook for a worker-backed process. */
  registerTerminator(pid, fn) {
    if (fn) this._terminators.set(pid, fn);
    else this._terminators.delete(pid);
  }

  /** Register the VM's signal mechanism for vm/vm-init processes. */
  setVmDelegate(fn) {
    this._vmDelegate = fn;
  }

  /**
   * kill(pid, sig) semantics across tiers (§7.4).
   * @param {number} pid @param {string} signal e.g. "SIGTERM"
   */
  kill(pid, signal = "SIGTERM") {
    const proc = this.kernel.proc.get(pid);
    if (!proc || proc.state !== "running") {
      throw new KernelError(ERRNO.ESRCH, undefined, `no running pid ${pid}`);
    }
    if (signal === "SIGKILL") {
      const terminate = this._terminators.get(pid);
      if (terminate) {
        try {
          terminate();
        } finally {
          this._terminators.delete(pid);
        }
      }
      this.kernel.releaseChannel(pid);
      this.kernel.proc.exit(pid, null, "SIGKILL");
      return;
    }
    if (proc.kind === "vm-init" || proc.kind === "vm") {
      if (this._vmDelegate) this._vmDelegate(pid, signal);
      else throw new KernelError(ERRNO.ENOSYS, undefined, "no VM signal delegate");
      return;
    }
    // node/boa/service: async-plane event; the tier applies Node's default
    // dispositions (SIGTERM terminates unless a listener exists, etc.).
    this.kernel.hub.sendEvent(pid, { ev: "signal", signal });
  }
}

export { SignalRouter };
