// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/uv/loop.mjs — the libuv semantic layer (spec §10): the phase
// driver on a MessageChannel scheduler (never nested setTimeout — background
// tab clamp), a min-heap of timers, handle/request ref-counting for liveness,
// and the nextTick/microtask interleave trampoline.

class MinHeap {
  constructor() { this._a = []; }
  get size() { return this._a.length; }
  peek() { return this._a[0]; }
  push(item) {
    const a = this._a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].due <= a[i].due) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this._a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < a.length && a[l].due < a[s].due) s = l;
        if (r < a.length && a[r].due < a[s].due) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
  remove(item) {
    const i = this._a.indexOf(item);
    if (i < 0) return;
    const last = this._a.pop();
    if (i < this._a.length) { this._a[i] = last; /* re-heapify lazily on next pop */ }
  }
}

class EventLoop {
  constructor(opts = {}) {
    this.now = opts.now ?? (() => performance.now());
    this._timers = new MinHeap();
    this._immediates = [];
    this._closeCallbacks = [];
    this._pending = []; // deferred I/O error callbacks
    // Liveness counters (spec §10.4).
    this._refHandles = 0;   // long-lived refed handles (sockets, servers, stdin)
    this._refReqs = 0;      // in-flight refed async requests
    this._refTimers = 0;
    this._refImmediates = 0;
    this._running = false;
    this._stopped = false;
    this._exitCode = 0;
    this._nextTickQueue = [];
    this._onBeforeExit = opts.onBeforeExit ?? (() => {});
    this._onExit = opts.onExit ?? (() => {});
    // MessageChannel scheduler (macro-iteration re-entry).
    const mc = new MessageChannel();
    this._schedPort = mc.port2;
    mc.port1.onmessage = () => this._tick();
    if (mc.port1.start) mc.port1.start();
  }

  // ---- liveness ----
  refHandle() { this._refHandles++; }
  unrefHandle() { this._refHandles--; }
  refReq() { this._refReqs++; this._schedule(); }
  unrefReq() { this._refReqs--; }
  get alive() {
    return this._refHandles + this._refReqs + this._refTimers + this._refImmediates > 0
      || this._timers.size > 0 || this._immediates.length > 0 || this._nextTickQueue.length > 0;
  }

  // ---- nextTick / microtask interleave (spec §10.1) ----
  nextTick(cb, ...args) {
    this._nextTickQueue.push(args.length ? () => cb(...args) : cb);
    this._schedule();
  }
  _drainTicks() {
    while (this._nextTickQueue.length) {
      const cb = this._nextTickQueue.shift();
      try { cb(); } catch (e) { this._onError(e); }
    }
  }
  /** Run one callback, then drain nextTicks; the caller `await null`s to drain microtasks. */
  _runCallback(cb) {
    try { cb(); } catch (e) { this._onError(e); }
    this._drainTicks();
  }

  // ---- timers ----
  setTimer(cb, ms, repeat = false, ref = true) {
    const timer = { cb, due: this.now() + Math.max(0, ms), ms, repeat, ref, canceled: false };
    this._timers.push(timer);
    if (ref) this._refTimers++;
    this._schedule();
    return timer;
  }
  clearTimer(timer) {
    if (!timer || timer.canceled) return;
    timer.canceled = true;
    if (timer.ref) this._refTimers--;
    this._timers.remove(timer);
  }
  refTimer(timer) { if (timer && !timer.ref && !timer.canceled) { timer.ref = true; this._refTimers++; } }
  unrefTimer(timer) { if (timer && timer.ref && !timer.canceled) { timer.ref = false; this._refTimers--; } }

  setImmediate(cb, ref = true) {
    const imm = { cb, ref, canceled: false };
    this._immediates.push(imm);
    if (ref) this._refImmediates++;
    this._schedule();
    return imm;
  }
  clearImmediate(imm) {
    if (!imm || imm.canceled) return;
    imm.canceled = true;
    if (imm.ref) this._refImmediates--;
  }

  // ---- driver ----
  start() {
    this._running = true;
    this._schedule();
  }
  stop(code = 0) {
    this._stopped = true;
    this._exitCode = code;
    this._onExit(code);
  }
  _schedule() {
    if (!this._scheduled && this._running && !this._stopped) {
      this._scheduled = true;
      this._schedPort.postMessage(0);
    }
  }
  async _tick() {
    this._scheduled = false;
    if (this._stopped) return;

    // Settle nextTicks + microtasks to a fixpoint before any phase runs or we
    // decide to exit. A stream/async-iterator ping-pongs between the nextTick
    // queue and the microtask queue across several turns; keep draining while
    // either keeps producing work so we never exit mid-chain (Node's
    // "microtasks settle between turns" semantics, taken to a fixpoint).
    let guard = 0;
    do {
      this._drainTicks();
      await null;
    } while (this._nextTickQueue.length && ++guard < 100000);
    if (this._stopped) return;

    // timers phase
    const nowT = this.now();
    while (this._timers.size && this._timers.peek().due <= nowT) {
      const t = this._timers.pop();
      if (t.canceled) continue;
      if (t.ref) this._refTimers--;
      this._runCallback(t.cb);
      await null; // drain microtasks between callbacks (§10.1)
      if (t.repeat && !t.canceled) {
        t.due = this.now() + t.ms;
        if (t.ref) this._refTimers++;
        this._timers.push(t);
      }
      if (this._stopped) return;
    }

    // pending (deferred I/O error) phase
    const pend = this._pending.splice(0);
    for (const cb of pend) { this._runCallback(cb); await null; if (this._stopped) return; }

    // check (setImmediate) phase — snapshot so newly-queued run next turn
    const imms = this._immediates.splice(0);
    for (const imm of imms) {
      if (imm.canceled) continue;
      if (imm.ref) this._refImmediates--;
      this._runCallback(imm.cb);
      await null;
      if (this._stopped) return;
    }

    // close callbacks phase
    const closes = this._closeCallbacks.splice(0);
    for (const cb of closes) { this._runCallback(cb); await null; if (this._stopped) return; }

    // Loop continuation / exit decision (§10.4).
    if (this.alive) {
      this._schedule();
      return;
    }
    // Appears idle. A pending promise chain tied to a stream/async-iterator can
    // schedule its next nextTick a couple of microtask turns later than our
    // drain concluded (promises aren't observable to the loop). Give a bounded
    // grace: settle a few more turns; if work reappears, keep running.
    for (let i = 0; i < 8 && !this.alive && !this._stopped; i++) {
      await null;
      this._drainTicks();
    }
    if (this.alive) { this._schedule(); return; }
    // Truly idle → beforeExit; if it queued work, continue.
    this._onBeforeExit();
    if (this.alive) this._schedule();
    else if (!this._stopped) this.stop(this._exitCode);
  }

  onClose(cb) { this._closeCallbacks.push(cb); this._schedule(); }
  deferError(cb) { this._pending.push(cb); this._schedule(); }
  _onError(e) { (this.onUncaught ?? ((err) => { throw err; }))(e); }
}

export { EventLoop, MinHeap };
