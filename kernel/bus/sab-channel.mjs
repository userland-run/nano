// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/bus/sab-channel.mjs — the sync Syscall Bus plane (spec §5.1,
// Appendix C as plan-defined). One SharedArrayBuffer per process:
//
//   i32 status  @0   IDLE=0 REQUEST=1 RESPONSE=2 RESPONSE_CHUNK=3 ERROR=4
//                    REQUEST_CHUNK=5
//   u16 op      @4 · u16 flags @6 · u32 seq @8
//   u32 payloadLen @12 (total bytes of json+pad+blob)
//   u32 chunkOff   @16
//   u32 jsonLen    @20 · u32 blobLen @24
//   payload window @64 (default 256 KiB)
//
// Payload = UTF-8 JSON, 8-aligned pad, optional binary blob. Payloads
// larger than the window stream through it in chunks in either direction.
// The client thread blocks in Atomics.wait (workers only); the Kernel
// NEVER blocks — it services via Atomics.waitAsync (§4.2), with a
// re-arm-on-current-value loop that is immune to missed transitions.
//
// One in-flight sync request per process — the semantics of a blocked
// thread — so the per-channel state machine needs no queues.

import { ERRNO, KernelError } from "../errno.mjs";
import { OP } from "./opcodes.mjs";

const HEADER = 64;
const DEFAULT_WINDOW = 256 * 1024;

const ST = {
  IDLE: 0,
  REQUEST: 1,
  RESPONSE: 2,
  RESPONSE_CHUNK: 3,
  ERROR: 4,
  REQUEST_CHUNK: 5,
};

const OFF = { status: 0, op: 4, flags: 6, seq: 8, payloadLen: 12, chunkOff: 16, jsonLen: 20, blobLen: 24 };

const enc = new TextEncoder();
const dec = new TextDecoder();

const align8 = (n) => (n + 7) & ~7;

/** Serialize {json, blob} → one payload buffer + header lengths. */
function encodePayload(obj, blob) {
  const jsonBytes = enc.encode(JSON.stringify(obj ?? {}));
  const blobLen = blob ? blob.byteLength : 0;
  const total = align8(jsonBytes.length) + blobLen;
  const buf = new Uint8Array(total);
  buf.set(jsonBytes, 0);
  if (blob) buf.set(new Uint8Array(blob.buffer ?? blob, blob.byteOffset ?? 0, blobLen), align8(jsonBytes.length));
  return { buf, jsonLen: jsonBytes.length, blobLen };
}

function decodePayload(buf, jsonLen, blobLen) {
  const obj = jsonLen ? JSON.parse(dec.decode(buf.subarray(0, jsonLen))) : {};
  const blob = blobLen ? buf.slice(align8(jsonLen), align8(jsonLen) + blobLen) : null;
  return { obj, blob };
}

class SabViews {
  constructor(sab) {
    this.i32 = new Int32Array(sab, 0, HEADER / 4);
    this.u16 = new Uint16Array(sab, 0, HEADER / 2);
    this.u32 = new Uint32Array(sab, 0, HEADER / 4);
    this.window = new Uint8Array(sab, HEADER);
  }
}

// ============================================================
// Kernel side — non-blocking servicing
// ============================================================

class SabChannel {
  /**
   * @param {import("./hub.mjs").SyscallBusHub} hub
   * @param {import("../types.d.mts").Process} proc
   * @param {SharedArrayBuffer} sab
   * @param {() => boolean} [isReady] gate (async-plane hello completed)
   */
  constructor(hub, proc, sab, isReady) {
    this.hub = hub;
    this.proc = proc;
    this.v = new SabViews(sab);
    this.isReady = isReady ?? (() => true);
    this._closed = false;
    // In-progress transfers:
    this._rx = null; // { buf, got } accumulating a chunked request
    this._tx = null; // { buf, off, jsonLen, blobLen, isError } chunked response
    this._pump();
  }

  close() {
    this._closed = true;
    // Wake the pump so its waitAsync loop can observe _closed and exit.
    Atomics.notify(this.v.i32, 0);
  }

  async _pump() {
    const status = this.v.i32;
    while (!this._closed) {
      const cur = Atomics.load(status, 0);
      if (this._tx && cur === ST.REQUEST) {
        // Chunk ack from the client: send the next response chunk.
        this._sendTxChunk();
        continue;
      }
      if (!this._tx && (cur === ST.REQUEST || cur === ST.REQUEST_CHUNK)) {
        await this._handle(cur);
        continue;
      }
      const w = Atomics.waitAsync(status, 0, cur);
      if (w.async) await w.value;
      // Loop re-reads the current value — immune to missed transitions.
    }
  }

  async _handle(kind) {
    const { i32, u16, u32, window } = this.v;
    const payloadLen = u32[OFF.payloadLen / 4];
    const chunkOff = u32[OFF.chunkOff / 4];
    const chunkLen = Math.min(window.length, payloadLen - chunkOff);

    if (kind === ST.REQUEST_CHUNK || (kind === ST.REQUEST && (chunkOff > 0 || payloadLen > window.length))) {
      // Accumulate a chunked request.
      if (!this._rx) this._rx = { buf: new Uint8Array(payloadLen) };
      this._rx.buf.set(window.subarray(0, chunkLen), chunkOff);
      if (kind === ST.REQUEST_CHUNK) {
        // Ack the chunk: back to IDLE so the client writes the next one.
        Atomics.store(i32, 0, ST.IDLE);
        Atomics.notify(i32, 0);
        return;
      }
    }

    // Final request chunk (or an unchunked request).
    const op = u16[OFF.op / 2];
    const jsonLen = u32[OFF.jsonLen / 4];
    const blobLen = u32[OFF.blobLen / 4];
    let payload;
    if (this._rx) {
      payload = this._rx.buf;
      this._rx = null;
    } else {
      payload = window.slice(0, payloadLen);
    }

    let responseObj;
    let responseBlob = null;
    let isError = false;
    try {
      if (!this.isReady()) throw new KernelError(ERRNO.EACCES, "ERR_NO_HELLO");
      const { obj, blob } = decodePayload(payload, jsonLen, blobLen);
      // The blob is the request's single binary argument by convention.
      if (blob) obj.data = blob.buffer;
      const result = await this.hub.dispatch(this.proc, op, obj);
      responseObj = { ...result };
      if (responseObj.data instanceof ArrayBuffer) {
        responseBlob = new Uint8Array(responseObj.data);
        delete responseObj.data;
      }
    } catch (e) {
      isError = true;
      responseObj = (e instanceof KernelError ? e : new KernelError(ERRNO.EIO, undefined, String(e?.message ?? e))).toJSON();
    }

    const encoded = encodePayload(responseObj, responseBlob);
    this._tx = { ...encoded, off: 0, isError };
    this._sendTxChunk();
  }

  _sendTxChunk() {
    const { i32, u32, window } = this.v;
    const tx = this._tx;
    const chunkLen = Math.min(window.length, tx.buf.length - tx.off);
    window.set(tx.buf.subarray(tx.off, tx.off + chunkLen), 0);
    u32[OFF.payloadLen / 4] = tx.buf.length;
    u32[OFF.chunkOff / 4] = tx.off;
    u32[OFF.jsonLen / 4] = tx.jsonLen;
    u32[OFF.blobLen / 4] = tx.blobLen;
    tx.off += chunkLen;
    const done = tx.off >= tx.buf.length;
    const st = done ? (tx.isError ? ST.ERROR : ST.RESPONSE) : ST.RESPONSE_CHUNK;
    if (done) this._tx = null;
    // Status is stored last; the pump loop picks up the client's chunk ack.
    Atomics.store(i32, 0, st);
    Atomics.notify(i32, 0);
  }
}

// ============================================================
// Client side — blocks the calling thread (workers only)
// ============================================================

class SyncCaller {
  /**
   * @param {SharedArrayBuffer} sab
   * @param {{ timeoutMs?: number }} [opts]
   */
  constructor(sab, opts = {}) {
    this.v = new SabViews(sab);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this._seq = 0;
  }

  /**
   * Blocking call. `args.data` (ArrayBuffer/TypedArray) rides as the binary
   * blob; a binary result comes back as `result.data` (ArrayBuffer).
   * @throws {KernelError}
   */
  callSync(opName, args = {}) {
    const op = OP[opName];
    if (op === undefined) throw new Error(`unknown opcode ${opName}`);
    const { i32, u16, u32, window } = this.v;

    let blob = null;
    let obj = args;
    if (args.data !== undefined) {
      const d = args.data;
      blob = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      obj = { ...args };
      delete obj.data;
    }
    const { buf, jsonLen, blobLen } = encodePayload(obj, blob);

    // --- send (chunked if needed) ---
    let off = 0;
    while (true) {
      const chunkLen = Math.min(window.length, buf.length - off);
      window.set(buf.subarray(off, off + chunkLen), 0);
      u16[OFF.op / 2] = op;
      u32[OFF.seq / 4] = ++this._seq;
      u32[OFF.payloadLen / 4] = buf.length;
      u32[OFF.chunkOff / 4] = off;
      u32[OFF.jsonLen / 4] = jsonLen;
      u32[OFF.blobLen / 4] = blobLen;
      off += chunkLen;
      const last = off >= buf.length;
      Atomics.store(i32, 0, last ? ST.REQUEST : ST.REQUEST_CHUNK);
      Atomics.notify(i32, 0);
      if (last) break;
      // Wait for the kernel to drain this chunk (status back to IDLE).
      this._wait(ST.REQUEST_CHUNK);
      if (Atomics.load(i32, 0) !== ST.IDLE) {
        throw new KernelError(ERRNO.EIO, undefined, "sync-plane protocol error (send)");
      }
    }

    // --- receive (chunked if needed) ---
    this._wait(ST.REQUEST);
    let rx = null;
    while (true) {
      const st = Atomics.load(i32, 0);
      const payloadLen = u32[OFF.payloadLen / 4];
      const chunkOff = u32[OFF.chunkOff / 4];
      const chunkLen = Math.min(window.length, payloadLen - chunkOff);
      if (st === ST.RESPONSE || st === ST.ERROR) {
        let payload;
        if (rx) {
          rx.set(window.subarray(0, chunkLen), chunkOff);
          payload = rx;
        } else {
          payload = window.slice(0, chunkLen);
        }
        const rJsonLen = u32[OFF.jsonLen / 4];
        const rBlobLen = u32[OFF.blobLen / 4];
        Atomics.store(i32, 0, ST.IDLE);
        const { obj: resultObj, blob: resultBlob } = decodePayload(payload, rJsonLen, rBlobLen);
        if (st === ST.ERROR) throw KernelError.fromJSON(resultObj);
        if (resultBlob) resultObj.data = resultBlob.buffer;
        return resultObj;
      }
      if (st === ST.RESPONSE_CHUNK) {
        if (!rx) rx = new Uint8Array(payloadLen);
        rx.set(window.subarray(0, chunkLen), chunkOff);
        Atomics.store(i32, 0, ST.REQUEST); // ack: next chunk please
        Atomics.notify(i32, 0);
        this._wait(ST.REQUEST);
        continue;
      }
      throw new KernelError(ERRNO.EIO, undefined, `sync-plane protocol error (status ${st})`);
    }
  }

  _wait(whileValue) {
    const r = Atomics.wait(this.v.i32, 0, whileValue, this.timeoutMs);
    if (r === "timed-out") {
      throw new KernelError(ERRNO.ETIMEDOUT, undefined, "sync call timed out");
    }
  }
}

const SYNC_WINDOW = DEFAULT_WINDOW;
const SYNC_HEADER = HEADER;

export { SabChannel, SyncCaller, SYNC_WINDOW, SYNC_HEADER, ST };
