// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/services/registry.mjs — Kernel Service registry (spec §13,
// plan-defined). Services are host-side capabilities (not processes with a
// main()): SWC type-strip, zlib, DuckDB, llhttp, WASI tool runners. Any tier
// may invoke a service its caps allow (checked at the bus, §7.3).
//
// A service implements:
//   { id, version, methods: string[],
//     invoke(method, payload) -> result | Promise<result>,
//     openSession?(config) -> sessionId,
//     call?(sessionId, method, payload) -> result,
//     closeSession?(sessionId) }
// Stateless services need only invoke(); stateful ones add the session trio.

import { ERRNO, KernelError } from "../errno.mjs";

class ServiceRegistry {
  constructor() {
    /** @type {Map<string, any>} id → service */
    this._services = new Map();
    /** @type {Map<number, { service: any, sessionId: any, ownerPid: number }>} */
    this._sessions = new Map();
    this._nextSession = 1;
  }

  /** Register a service implementation. Returns an unregister fn. */
  register(service) {
    if (!service?.id) throw new Error("service needs an id");
    this._services.set(service.id, service);
    return () => this._services.delete(service.id);
  }

  get(id) {
    return this._services.get(id) ?? null;
  }

  list() {
    return [...this._services.values()].map((s) => ({
      id: s.id,
      version: s.version ?? "0.0.0",
      kind: s.kind ?? "wasm-service",
      methods: s.methods ?? [],
      stateful: typeof s.openSession === "function",
    }));
  }

  async invoke(id, method, payload) {
    const svc = this._services.get(id);
    if (!svc) throw new KernelError(ERRNO.ENOSYS, undefined, `no service '${id}'`);
    if (typeof svc.invoke !== "function") {
      throw new KernelError(ERRNO.ENOSYS, undefined, `service '${id}' has no invoke()`);
    }
    return svc.invoke(method, payload);
  }

  openSession(id, config, ownerPid) {
    const svc = this._services.get(id);
    if (!svc) throw new KernelError(ERRNO.ENOSYS, undefined, `no service '${id}'`);
    if (typeof svc.openSession !== "function") {
      throw new KernelError(ERRNO.ENOSYS, undefined, `service '${id}' is stateless`);
    }
    const sessionId = this._nextSession++;
    this._sessions.set(sessionId, { service: svc, sessionId: svc.openSession(config), ownerPid });
    return sessionId;
  }

  async sessionCall(sessionId, method, payload, callerPid) {
    const s = this._sessions.get(sessionId);
    if (!s) throw new KernelError(ERRNO.EINVAL, undefined, `no session ${sessionId}`);
    if (callerPid !== undefined && s.ownerPid !== callerPid) {
      throw new KernelError(ERRNO.EACCES, undefined, "session not owned");
    }
    return s.service.call(s.sessionId, method, payload);
  }

  closeSession(sessionId, callerPid) {
    const s = this._sessions.get(sessionId);
    if (!s) return;
    if (callerPid !== undefined && s.ownerPid !== callerPid) return;
    s.service.closeSession?.(s.sessionId);
    this._sessions.delete(sessionId);
  }

  /** Drop every session a process owned (exit/kill path). */
  closeAllFor(pid) {
    for (const [sessionId, s] of this._sessions) {
      if (s.ownerPid === pid) {
        s.service.closeSession?.(s.sessionId);
        this._sessions.delete(sessionId);
      }
    }
  }
}

export { ServiceRegistry };
