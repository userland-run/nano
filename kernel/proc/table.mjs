// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/proc/table.mjs — the Kernel process table (spec §7.1–§7.2).
// pid 1 is the root context (the SDK embedder); orphans reparent to it.
// The VM registers once as kind "vm-init" and owns a pid-namespace prefix
// reservation for future internal-pid mirroring.

import { ERRNO, KernelError } from "../errno.mjs";
import { trustedDev } from "../caps/profiles.mjs";
import { capsSubsetViolation, normalizeCaps } from "../caps/caps.mjs";

class ProcessTable {
  /** @param {import("../types.d.mts").Capabilities} [rootCaps] */
  constructor(rootCaps) {
    /** @type {Map<number, any>} pid → Process */
    this._procs = new Map();
    this._nextPid = 2;
    /** @type {Map<number, Array<(info: any) => void>>} waiters keyed by waited pid */
    this._waiters = new Map();
    /** @type {Map<number, (info: any) => void>} SIGCHLD-style listener per parent pid */
    this._childExitListeners = new Map();

    this._procs.set(1, {
      pid: 1,
      kind: "service",
      ppid: 1,
      argv: ["<root>"],
      cwd: "/",
      env: {},
      caps: rootCaps ? normalizeCaps(rootCaps) : trustedDev(),
      stdio: ["tty", "tty", "tty"],
      state: "running",
    });
  }

  get(pid) {
    return this._procs.get(pid);
  }

  /**
   * Register a new process. Enforces capability attenuation against the
   * parent (spec §7.3): escalation is rejected at spawn.
   * @returns {import("../types.d.mts").Process}
   */
  register(spec) {
    const ppid = spec.ppid ?? 1;
    const parent = this._procs.get(ppid);
    if (!parent) throw new KernelError(ERRNO.ESRCH, undefined, `no parent ${ppid}`);
    const caps = spec.caps ? normalizeCaps(spec.caps) : parent.caps;
    const violation = capsSubsetViolation(caps, parent.caps);
    if (violation) {
      throw KernelError.capDenied(violation, `child caps escalate ${violation}`);
    }
    const proc = {
      pid: this._nextPid++,
      kind: spec.kind,
      ppid,
      argv: spec.argv ?? [],
      cwd: spec.cwd ?? parent.cwd,
      env: spec.env ?? { ...parent.env },
      caps,
      stdio: spec.stdio ?? ["tty", "tty", "tty"],
      state: "running",
    };
    this._procs.set(proc.pid, proc);
    return proc;
  }

  /** Record an exit: running → zombie, notify parent + waiters (§7.2). */
  exit(pid, exitCode, signal = null) {
    const proc = this._procs.get(pid);
    if (!proc || proc.state !== "running") return;
    proc.state = "zombie";
    proc.exitCode = exitCode;
    proc.signal = signal;
    // Reparent this process's live children to the root context.
    for (const p of this._procs.values()) {
      if (p.ppid === pid && p.state === "running") p.ppid = 1;
    }
    const info = { pid, exitCode, signal };
    const onChildExit = this._childExitListeners.get(proc.ppid);
    if (onChildExit) queueMicrotask(() => onChildExit(info));
    const waiters = this._waiters.get(pid);
    if (waiters) {
      this._waiters.delete(pid);
      this._reap(pid);
      for (const w of waiters) queueMicrotask(() => w(info));
    }
  }

  /**
   * Wait for a child to exit; reaps the zombie (§7.2).
   * @returns {Promise<{pid: number, exitCode: number|null, signal: string|null}>}
   */
  waitpid(pid, waiterPid) {
    const proc = this._procs.get(pid);
    if (!proc) return Promise.reject(new KernelError(ERRNO.ECHILD, undefined, `no pid ${pid}`));
    if (waiterPid !== undefined && proc.ppid !== waiterPid) {
      return Promise.reject(new KernelError(ERRNO.ECHILD, undefined, `${pid} is not a child`));
    }
    if (proc.state === "zombie") {
      this._reap(pid);
      return Promise.resolve({ pid, exitCode: proc.exitCode, signal: proc.signal });
    }
    if (proc.state === "reaped") {
      return Promise.reject(new KernelError(ERRNO.ECHILD, undefined, `${pid} already reaped`));
    }
    return new Promise((resolve) => {
      if (!this._waiters.has(pid)) this._waiters.set(pid, []);
      this._waiters.get(pid).push(resolve);
    });
  }

  _reap(pid) {
    const proc = this._procs.get(pid);
    if (proc) proc.state = "reaped";
  }

  /** Install the SIGCHLD-equivalent listener for a parent pid (async plane). */
  onChildExit(ppid, listener) {
    this._childExitListeners.set(ppid, listener);
  }

  /** Cross-tier `ps` (§7.1): running + zombie processes, no reaped ones. */
  list() {
    return [...this._procs.values()]
      .filter((p) => p.state !== "reaped")
      .map((p) => ({
        pid: p.pid,
        kind: p.kind,
        ppid: p.ppid,
        argv: [...p.argv],
        cwd: p.cwd,
        state: p.state,
        exitCode: p.exitCode,
      }));
  }
}

/** vm-init pid-namespace prefix reservation (spec §7.1, plan-defined). */
const VM_PID_SHIFT = 12;
const vmPidRange = (pid) => ({ start: pid << VM_PID_SHIFT, end: (pid + 1) << VM_PID_SHIFT });

export { ProcessTable, VM_PID_SHIFT, vmPidRange };
