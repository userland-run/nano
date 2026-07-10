// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/proc/pipes.mjs — Kernel pipe objects (spec §7.1, §11.1): the byte
// transport for cross-tier stdio and loopback connections. A pipe is a
// unidirectional chunk queue with async readable-wakeups; a loopback
// connection is two pipes crossed (§11.1).

class Pipe {
  constructor(id) {
    this.id = id;
    /** @type {Uint8Array[]} */
    this._chunks = [];
    this._pos = 0;
    this._writeClosed = false;
    /** @type {Array<() => void>} */
    this._wakers = [];
  }

  get readable() {
    return this._chunks.length > 0;
  }

  get ended() {
    return this._writeClosed && this._chunks.length === 0;
  }

  /** @param {Uint8Array} bytes */
  write(bytes) {
    if (this._writeClosed) throw new Error("pipe write end closed");
    if (bytes.length === 0) return;
    this._chunks.push(bytes.slice());
    this._wake();
  }

  /** Close the write end; readers drain the queue then see EOF. */
  closeWrite() {
    this._writeClosed = true;
    this._wake();
  }

  /**
   * @param {number} maxLen
   * @returns {Uint8Array | null | "eof"} bytes, null (open, nothing queued),
   *   or "eof" once the queue is drained after closeWrite.
   */
  read(maxLen) {
    if (!this._chunks.length) return this._writeClosed ? "eof" : null;
    const out = new Uint8Array(Math.min(maxLen, this._queuedBytes()));
    let copied = 0;
    while (copied < out.length && this._chunks.length) {
      const c = this._chunks[0];
      const n = Math.min(c.length - this._pos, out.length - copied);
      out.set(c.subarray(this._pos, this._pos + n), copied);
      this._pos += n;
      copied += n;
      if (this._pos >= c.length) {
        this._chunks.shift();
        this._pos = 0;
      }
    }
    return out;
  }

  /** Resolves when data or EOF is available. */
  waitReadable() {
    if (this._chunks.length || this._writeClosed) return Promise.resolve();
    return new Promise((resolve) => this._wakers.push(resolve));
  }

  _queuedBytes() {
    let n = -this._pos;
    for (const c of this._chunks) n += c.length;
    return n;
  }

  _wake() {
    const wakers = this._wakers;
    this._wakers = [];
    for (const w of wakers) w();
  }
}

class PipeRegistry {
  constructor() {
    /** @type {Map<number, Pipe>} */
    this._pipes = new Map();
    this._nextId = 1;
  }

  /** One unidirectional pipe; both "fds" name the same Pipe object. */
  create() {
    const pipe = new Pipe(this._nextId++);
    this._pipes.set(pipe.id, pipe);
    return pipe;
  }

  get(id) {
    return this._pipes.get(id) ?? null;
  }

  /** A crossed pipe pair for a loopback connection (§11.1). */
  createPair() {
    return { aToB: this.create(), bToA: this.create() };
  }

  destroy(id) {
    const pipe = this._pipes.get(id);
    if (pipe) {
      pipe.closeWrite();
      this._pipes.delete(id);
    }
  }
}

export { Pipe, PipeRegistry };
