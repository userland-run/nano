// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/http.mjs — a functional HTTP/1.1 module (M1) over the net
// loopback module. createServer/request/get with IncomingMessage-like req and
// ServerResponse-like res (writeHead/setHeader/write/end). Full upstream
// lib/http.js (llhttp + net tcp_wrap) is a later phase; this makes a server
// reachable (the M1 exit criterion) and http.request work. DIV-HTTP-M0.

function makeHttp({ net, EventEmitter, Buffer }) {
  const CRLF = "\r\n";

  class IncomingMessage extends EventEmitter {
    constructor(socket) {
      super();
      this.socket = socket;
      this.headers = {};
      this.method = null; this.url = null; this.statusCode = null; this.statusMessage = null;
      this.httpVersion = "1.1";
      this._body = [];
    }
    setEncoding(enc) { this._encoding = enc; return this; }
    _pushBody(buf) {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
      this._body.push(b);
      this.emit("data", this._encoding ? b.toString(this._encoding) : b);
    }
    _endBody() { this.emit("end"); }
  }

  class ServerResponse extends EventEmitter {
    constructor(socket) {
      super();
      this.socket = socket;
      this.statusCode = 200; this.statusMessage = null;
      this._headers = {};
      this._headersSent = false;
      this.finished = false;
    }
    setHeader(name, value) { this._headers[name.toLowerCase()] = { name, value }; return this; }
    getHeader(name) { return this._headers[name.toLowerCase()]?.value; }
    removeHeader(name) { delete this._headers[name.toLowerCase()]; }
    writeHead(statusCode, statusMessage, headers) {
      this.statusCode = statusCode;
      if (typeof statusMessage === "object") { headers = statusMessage; statusMessage = undefined; }
      if (statusMessage) this.statusMessage = statusMessage;
      if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
      return this;
    }
    _flushHead(bodyLen) {
      if (this._headersSent) return;
      this._headersSent = true;
      const reason = this.statusMessage ?? STATUS_CODES[this.statusCode] ?? "";
      let head = `HTTP/1.1 ${this.statusCode} ${reason}${CRLF}`;
      if (!this._headers["content-length"] && !this._headers["transfer-encoding"] && bodyLen != null) {
        this.setHeader("Content-Length", String(bodyLen));
      }
      if (!this._headers["date"]) head += `Date: ${new Date().toUTCString()}${CRLF}`;
      if (!this._headers["connection"]) head += `Connection: close${CRLF}`;
      for (const { name, value } of Object.values(this._headers)) {
        for (const v of Array.isArray(value) ? value : [value]) head += `${name}: ${v}${CRLF}`;
      }
      head += CRLF;
      this.socket.write(head);
    }
    write(chunk, encoding) {
      if (!this._headersSent) this._flushHead(null);
      this.socket.write(chunk);
      return true;
    }
    end(chunk, encoding) {
      const body = chunk == null ? null : (typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      this._flushHead(body ? body.length : 0);
      if (body) this.socket.write(body);
      this.finished = true;
      this.socket.end();
      this.emit("finish");
      return this;
    }
  }

  class Server extends EventEmitter {
    constructor(opts, requestListener) {
      super();
      if (typeof opts === "function") { requestListener = opts; opts = {}; }
      if (requestListener) this.on("request", requestListener);
      this._net = net.createServer((sock) => this._onConnection(sock));
    }
    _onConnection(sock) {
      const parser = new RequestParser();
      let req = null, res = null;
      sock.on("data", (chunk) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        parser.push(buf, {
          onHeaders: (info) => {
            req = new IncomingMessage(sock);
            req.method = info.method; req.url = info.url; req.headers = info.headers;
            res = new ServerResponse(sock);
            this.emit("request", req, res);
          },
          onBody: (b) => req?._pushBody(b),
          onComplete: () => req?._endBody(),
        });
      });
      sock.on("end", () => req?._endBody());
    }
    listen(port, hostOrCb, cb) {
      const callback = typeof hostOrCb === "function" ? hostOrCb : cb;
      this._net.listen(port, () => { this.emit("listening"); if (callback) callback(); });
      return this;
    }
    address() { return this._net.address(); }
    close(cb) { this._net.close(cb); this.emit("close"); return this; }
  }

  class ClientRequest extends EventEmitter {
    constructor(options, cb) {
      super();
      if (typeof options === "string") options = parseUrl(options);
      this.method = (options.method ?? "GET").toUpperCase();
      this.path = options.path ?? "/";
      this.host = options.hostname ?? options.host ?? "127.0.0.1";
      this.port = options.port ?? 80;
      this._headers = { ...(options.headers ?? {}) };
      this._body = [];
      if (cb) this.once("response", cb);
    }
    setHeader(k, v) { this._headers[k] = v; }
    write(chunk) { this._body.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); return true; }
    end(chunk) {
      if (chunk != null) this.write(chunk);
      const body = Buffer.concat(this._body);
      const sock = net.connect(this.port, () => {
        let head = `${this.method} ${this.path} HTTP/1.1${CRLF}`;
        const hdrs = { host: `${this.host}:${this.port}`, ...lower(this._headers) };
        if (body.length && !hdrs["content-length"]) hdrs["content-length"] = String(body.length);
        hdrs["connection"] = hdrs["connection"] ?? "close";
        for (const [k, v] of Object.entries(hdrs)) head += `${k}: ${v}${CRLF}`;
        head += CRLF;
        sock.write(head);
        if (body.length) sock.write(body);
      });
      const parser = new ResponseParser();
      let res = null;
      sock.on("data", (chunk2) => {
        const buf = typeof chunk2 === "string" ? Buffer.from(chunk2) : chunk2;
        parser.push(buf, {
          onHeaders: (info) => {
            res = new IncomingMessage(sock);
            res.statusCode = info.statusCode; res.statusMessage = info.statusMessage; res.headers = info.headers;
            this.emit("response", res);
          },
          onBody: (b) => res?._pushBody(b),
          onComplete: () => res?._endBody(),
        });
      });
      sock.on("end", () => res?._endBody());
      sock.on("error", (e) => this.emit("error", e));
      return this;
    }
  }

  const request = (options, cb) => new ClientRequest(options, cb);
  const get = (options, cb) => { const r = new ClientRequest(options, cb); r.end(); return r; };

  return {
    Server, ServerResponse, IncomingMessage, ClientRequest,
    createServer: (opts, cb) => new Server(opts, cb),
    request, get,
    STATUS_CODES,
    METHODS: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"],
  };
}

// --- HTTP/1.1 parsers (headers + Content-Length body; enough for the loopback
// path). Chunked transfer-encoding is a later refinement. ---
class RequestParser {
  constructor() { this._buf = new Uint8Array(0); this._state = "head"; this._need = 0; this._got = 0; this._cbs = null; }
  push(chunk, cbs) {
    this._cbs = cbs;
    this._buf = concatU8(this._buf, chunk);
    this._parse();
  }
  _parse() {
    if (this._state === "head") {
      const idx = findDoubleCRLF(this._buf);
      if (idx < 0) return;
      const head = new TextDecoder().decode(this._buf.subarray(0, idx));
      this._buf = this._buf.subarray(idx + 4);
      const lines = head.split("\r\n");
      const [method, url] = lines[0].split(" ");
      const headers = {};
      for (const l of lines.slice(1)) { const c = l.indexOf(":"); if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim(); }
      this._need = parseInt(headers["content-length"] ?? "0", 10);
      this._cbs.onHeaders({ method, url, headers });
      this._state = "body";
    }
    if (this._state === "body") {
      if (this._buf.length) { this._cbs.onBody(bufFrom(this._buf)); this._got += this._buf.length; this._buf = new Uint8Array(0); }
      if (this._got >= this._need) { this._cbs.onComplete(); this._state = "done"; }
    }
  }
}
class ResponseParser {
  constructor() { this._buf = new Uint8Array(0); this._state = "head"; this._need = 0; this._got = 0; this._cbs = null; this._chunked = false; }
  push(chunk, cbs) { this._cbs = cbs; this._buf = concatU8(this._buf, chunk); this._parse(); }
  _parse() {
    if (this._state === "head") {
      const idx = findDoubleCRLF(this._buf);
      if (idx < 0) return;
      const head = new TextDecoder().decode(this._buf.subarray(0, idx));
      this._buf = this._buf.subarray(idx + 4);
      const lines = head.split("\r\n");
      const m = /HTTP\/1\.\d (\d+) ?(.*)/.exec(lines[0]) ?? [];
      const headers = {};
      for (const l of lines.slice(1)) { const c = l.indexOf(":"); if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim(); }
      this._need = headers["content-length"] != null ? parseInt(headers["content-length"], 10) : Infinity;
      this._cbs.onHeaders({ statusCode: parseInt(m[1], 10), statusMessage: m[2] ?? "", headers });
      this._state = "body";
    }
    if (this._state === "body") {
      if (this._buf.length) { this._cbs.onBody(bufFrom(this._buf)); this._got += this._buf.length; this._buf = new Uint8Array(0); }
      if (this._got >= this._need) { this._cbs.onComplete(); this._state = "done"; }
    }
  }
}

let _Buffer;
function bufFrom(u8) { return u8.slice(); }
function concatU8(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
function findDoubleCRLF(buf) { for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i; return -1; }
function lower(obj) { const o = {}; for (const [k, v] of Object.entries(obj)) o[k.toLowerCase()] = v; return o; }
function parseUrl(u) { const m = /^https?:\/\/([^:/]+)(?::(\d+))?(\/.*)?$/.exec(u) ?? []; return { hostname: m[1] ?? "127.0.0.1", port: m[2] ? parseInt(m[2], 10) : 80, path: m[3] ?? "/" }; }

const STATUS_CODES = {
  200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found",
  304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 500: "Internal Server Error", 503: "Service Unavailable",
};

export { makeHttp };
