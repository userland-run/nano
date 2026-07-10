// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/net/ports.mjs — the loopback port table (spec §11.1, §11.4): the
// single registry joining VM listeners (VirtualServer injectors) and future
// nodert listeners, and the integration point for the ServeBridge.

import { ERRNO, KernelError } from "../errno.mjs";

const EPHEMERAL_START = 49152;
const EPHEMERAL_END = 65535;

class PortTable {
  constructor() {
    /** @type {Map<number, { port: number, ownerPid: number, kind: string, acceptor: any }>} */
    this._ports = new Map();
    this._nextEphemeral = EPHEMERAL_START;
    /** @type {Set<(ev: { pid: number, port: number }) => void>} */
    this._listeningListeners = new Set();
  }

  /**
   * Register a listener. port 0 → ephemeral allocation. `acceptor` is the
   * tier-specific way in: for the VM, `{ kind: "vm", inject(rawHTTP) }`
   * wrapping VirtualServer.injectConnection; for nodert (M1),
   * `{ kind: "node", pipeAccept() }`.
   * @returns {number} the bound port
   * @throws {KernelError} EADDRINUSE
   */
  listen(ownerPid, port, acceptor) {
    if (!port) port = this._allocEphemeral();
    if (this._ports.has(port)) {
      throw new KernelError(ERRNO.EADDRINUSE, undefined, `port ${port} in use`);
    }
    this._ports.set(port, { port, ownerPid, kind: acceptor?.kind ?? "unknown", acceptor });
    // Structured readiness event (§11.4) — race-free alternative to the
    // stdout /listening/i regex.
    const ev = { pid: ownerPid, port };
    for (const l of this._listeningListeners) {
      try {
        l(ev);
      } catch { /* listener errors must not break registration */ }
    }
    return port;
  }

  lookup(port) {
    return this._ports.get(port) ?? null;
  }

  close(ownerPid, port) {
    const e = this._ports.get(port);
    if (!e || e.ownerPid !== ownerPid) {
      throw new KernelError(ERRNO.EINVAL, undefined, `port ${port} not owned`);
    }
    this._ports.delete(port);
  }

  /** Drop every listener a process owned (exit/kill path). */
  closeAllFor(ownerPid) {
    for (const [port, e] of this._ports) {
      if (e.ownerPid === ownerPid) this._ports.delete(port);
    }
  }

  list() {
    return [...this._ports.values()].map(({ port, ownerPid, kind }) => ({ port, ownerPid, kind }));
  }

  /** Subscribe to structured `listening` events; returns unsubscribe. */
  onListening(listener) {
    this._listeningListeners.add(listener);
    return () => this._listeningListeners.delete(listener);
  }

  _allocEphemeral() {
    for (let i = 0; i <= EPHEMERAL_END - EPHEMERAL_START; i++) {
      const p = EPHEMERAL_START + ((this._nextEphemeral - EPHEMERAL_START + i) % (EPHEMERAL_END - EPHEMERAL_START + 1));
      if (!this._ports.has(p)) {
        this._nextEphemeral = p + 1;
        return p;
      }
    }
    throw new KernelError(ERRNO.EADDRNOTAVAIL, undefined, "ephemeral ports exhausted");
  }
}

export { PortTable };
