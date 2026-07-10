// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/bus/port-channel.mjs — kernel side of the async plane (spec §5.1):
// structured-clone messages with u32 correlation ids over a MessagePort.
// Requests {id, op, args} answer with {id, ok} or {id, err}; unsolicited
// events {ev, ...} share the port. ArrayBuffers ride as transferables.

import { KernelError, ERRNO } from "../errno.mjs";
import { PROTOCOL_MAJOR } from "./opcodes.mjs";

class PortChannel {
  /**
   * @param {import("./hub.mjs").SyscallBusHub} hub
   * @param {import("../types.d.mts").Process} proc
   * @param {MessagePort} port
   * @param {string} token per-spawn nonce the client must echo in its hello
   */
  constructor(hub, proc, port, token) {
    this.hub = hub;
    this.proc = proc;
    this.port = port;
    this.token = token;
    this._helloDone = false;
    port.onmessage = (e) => this._onMessage(e.data);
    hub.setEventSink(proc.pid, (ev, transfers) =>
      port.postMessage(ev, transfers ? { transfer: transfers } : undefined)
    );
  }

  close() {
    this.hub.setEventSink(this.proc.pid, null);
    this.port.onmessage = null;
    this.port.close?.();
  }

  async _onMessage(msg) {
    if (msg?.hello) {
      const { major, pid, token } = msg.hello;
      if (major !== PROTOCOL_MAJOR) {
        this.port.postMessage({ helloErr: { reason: `unsupported major ${major}` } });
        this.close();
        return;
      }
      if (pid !== this.proc.pid || token !== this.token) {
        this.port.postMessage({ helloErr: { reason: "pid/token mismatch" } });
        this.close();
        return;
      }
      this._helloDone = true;
      this.port.postMessage({ helloAck: this.hub.kernel.protocol });
      return;
    }
    if (msg?.id === undefined) return;
    if (!this._helloDone) {
      this.port.postMessage({ id: msg.id, err: errJson(new KernelError(ERRNO.EACCES, "ERR_NO_HELLO")) });
      return;
    }
    try {
      const result = await this.hub.dispatch(this.proc, msg.op, msg.args);
      const transfers = collectTransfers(result);
      this.port.postMessage(
        { id: msg.id, ok: result },
        transfers.length ? { transfer: transfers } : undefined
      );
    } catch (e) {
      const ke = e instanceof KernelError ? e : new KernelError(ERRNO.EIO, undefined, String(e?.message ?? e));
      this.port.postMessage({ id: msg.id, err: errJson(ke) });
    }
  }
}

const errJson = (ke) => ke.toJSON();

/** Bulk data MUST ride as transferables (spec §5.1). */
function collectTransfers(result) {
  const out = [];
  if (result && typeof result === "object") {
    for (const v of Object.values(result)) {
      if (v instanceof ArrayBuffer) out.push(v);
    }
  }
  return out;
}

export { PortChannel };
