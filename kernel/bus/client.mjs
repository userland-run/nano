// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/bus/client.mjs — the process-side Syscall Bus client (spec §5).
// Runs in nodert workers (and tests). K4 delivers the async plane; the
// sync SAB plane rides the same opcode schemas (sab-channel.mjs, K5).

import { KernelError } from "../errno.mjs";
import { OP, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./opcodes.mjs";

class BusClient {
  /**
   * @param {{ pid: number, token: string, asyncPort: MessagePort, syncView?: DataView }} init
   */
  constructor(init) {
    this.pid = init.pid;
    this._token = init.token;
    this._port = init.asyncPort;
    this._nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    this._inflight = new Map();
    /** @type {Set<(ev: object) => void>} */
    this._eventListeners = new Set();
    this._helloAck = null;
    this._port.onmessage = (e) => this._onMessage(e.data);
  }

  /** Version handshake — must complete before any call (spec §5.2). */
  hello() {
    return new Promise((resolve, reject) => {
      this._helloWaiter = { resolve, reject };
      this._port.postMessage({
        hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, pid: this.pid, token: this._token },
      });
    });
  }

  /**
   * Async-plane call by opcode name, e.g. call("fs.open", {path, flags}).
   * @returns {Promise<any>} the result object; rejects with KernelError
   */
  call(opName, args, transfers) {
    const op = OP[opName];
    if (op === undefined) return Promise.reject(new Error(`unknown opcode ${opName}`));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._inflight.set(id, { resolve, reject });
      this._port.postMessage({ id, op, args }, transfers ? { transfer: transfers } : undefined);
    });
  }

  /** Subscribe to unsolicited events (watch, signal, child-exit, …). */
  onEvent(listener) {
    this._eventListeners.add(listener);
    return () => this._eventListeners.delete(listener);
  }

  close() {
    this._port.onmessage = null;
    this._port.close?.();
    const err = new Error("bus client closed");
    for (const { reject } of this._inflight.values()) reject(err);
    this._inflight.clear();
  }

  _onMessage(msg) {
    if (msg?.helloAck) {
      this._helloAck = msg.helloAck;
      this._helloWaiter?.resolve(msg.helloAck);
      return;
    }
    if (msg?.helloErr) {
      this._helloWaiter?.reject(new Error(msg.helloErr.reason));
      return;
    }
    if (msg?.id !== undefined) {
      const waiter = this._inflight.get(msg.id);
      if (!waiter) return;
      this._inflight.delete(msg.id);
      if (msg.err) waiter.reject(KernelError.fromJSON(msg.err));
      else waiter.resolve(msg.ok);
      return;
    }
    if (msg?.ev) {
      for (const l of this._eventListeners) l(msg);
    }
  }
}

export { BusClient };
