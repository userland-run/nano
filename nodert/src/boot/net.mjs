// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/net.mjs — a functional `net` module (M1) over Kernel
// loopback pipes (spec §11.1). createServer/Server/Socket/connect on
// 127.0.0.1. Sockets are EventEmitter-backed duplex-ish objects reading via
// the ASYNC bus plane (non-blocking) and writing via proc.pipe_write. Full
// upstream lib/net.js (tcp_wrap/LibuvStreamWrap) is a later step; this covers
// the http server/client path and nodert↔nodert TCP. DIV-NET-M0.

function makeNet({ sync, busAsync, Buffer, EventEmitter, setImmediate }) {
  const dec = new TextDecoder();

  class Socket extends EventEmitter {
    constructor(pipes) {
      super();
      this._readPipe = pipes?.readPipe ?? null;
      this._writePipe = pipes?.writePipe ?? null;
      this.readable = true; this.writable = true;
      this.destroyed = false;
      this._encoding = null;
      this.remoteAddress = "127.0.0.1";
      this.remotePort = pipes?.remotePort ?? 0;
      this.localPort = pipes?.localPort ?? 0;
      this._refed = false;
      if (this._readPipe != null) { globalThis.__nodert_ref?.(); this._refed = true; this._startReading(); }
    }
    setEncoding(enc) { this._encoding = enc; return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
    address() { return { address: "127.0.0.1", port: this.localPort, family: "IPv4" }; }

    async _startReading() {
      try {
        for (;;) {
          if (this.destroyed) break;
          const r = await busAsync.call("proc.pipe_read", { pipeId: this._readPipe });
          if (r.eof) { this.readable = false; this._unref(); this.emit("end"); this.emit("close", false); break; }
          if (r.bytes > 0) {
            const buf = Buffer.from(r.data);
            this.emit("data", this._encoding ? buf.toString(this._encoding) : buf);
          }
        }
      } catch (e) {
        if (!this.destroyed) this.emit("error", e);
      }
    }
    write(chunk, encoding, cb) {
      if (this.destroyed || this._writePipe == null) return false;
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer ?? chunk, chunk.byteOffset ?? 0, chunk.byteLength ?? chunk.length);
      try { sync("proc.pipe_write", { pipeId: this._writePipe, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
      catch (e) { if (cb) cb(e); return false; }
      const callback = typeof encoding === "function" ? encoding : cb;
      if (callback) queueMicrotask(callback);
      return true;
    }
    end(chunk, encoding, cb) {
      if (chunk != null) this.write(chunk, encoding);
      if (this._writePipe != null) { try { sync("proc.pipe_close", { pipeId: this._writePipe }); } catch {} }
      this.writable = false;
      const callback = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : cb;
      if (callback) queueMicrotask(callback);
      return this;
    }
    _unref() { if (this._refed) { this._refed = false; globalThis.__nodert_unref?.(); } }
    destroy(err) {
      if (this.destroyed) return this;
      this.destroyed = true; this.readable = false; this.writable = false; this._unref();
      if (this._writePipe != null) { try { sync("proc.pipe_close", { pipeId: this._writePipe }); } catch {} }
      if (err) this.emit("error", err);
      this.emit("close", !!err);
      return this;
    }
    pause() { return this; }
    resume() { return this; }
    ref() { return this; }
    unref() { return this; }
  }

  class Server extends EventEmitter {
    constructor(opts, connectionListener) {
      super();
      if (typeof opts === "function") { connectionListener = opts; opts = {}; }
      if (connectionListener) this.on("connection", connectionListener);
      this._port = null;
      this._unsub = null;
    }
    listen(port, hostOrCb, cb) {
      const callback = typeof hostOrCb === "function" ? hostOrCb : cb;
      const p = typeof port === "object" ? port.port : port;
      const r = sync("net.listen", { port: p ?? 0 });
      this._port = r.port;
      globalThis.__nodert_ref?.(); this._refed = true;
      // Each 'connection' event from the Kernel becomes a server Socket.
      this._unsub = busAsync.onEvent((msg) => {
        if (msg.ev === "connection" && msg.port === this._port) {
          const sock = new Socket({ readPipe: msg.readPipe, writePipe: msg.writePipe, remotePort: msg.remotePort, localPort: this._port });
          this.emit("connection", sock);
        }
      });
      setImmediate(() => { this.emit("listening"); if (callback) callback(); });
      return this;
    }
    address() { return { address: "127.0.0.1", port: this._port, family: "IPv4" }; }
    close(cb) {
      if (this._refed) { this._refed = false; globalThis.__nodert_unref?.(); }
      if (this._port != null) { try { sync("net.close_listener", { port: this._port }); } catch {} }
      this._unsub?.();
      this.emit("close");
      if (cb) queueMicrotask(cb);
      return this;
    }
    ref() { return this; }
    unref() { return this; }
  }

  function connect(port, hostOrCb, cb) {
    const p = typeof port === "object" ? port.port : port;
    const callback = typeof hostOrCb === "function" ? hostOrCb : cb;
    const r = sync("net.connect_loopback", { port: p });
    const sock = new Socket({ readPipe: r.readPipe, writePipe: r.writePipe, localPort: r.localPort });
    setImmediate(() => { sock.emit("connect"); if (callback) callback(); });
    return sock;
  }

  return {
    Socket, Server,
    createServer: (opts, cb) => new Server(opts, cb),
    connect, createConnection: connect,
    isIP: (s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0),
    isIPv4: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s),
    isIPv6: () => false,
  };
}

export { makeNet };
