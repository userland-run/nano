// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/buffer.mjs — a lean Buffer (M0). Subclass of Uint8Array
// backed by the host-native `buffer` binding primitives. Upstream lib/buffer.js
// runs verbatim in M1 once its full dependency closure (streams/blob) lands;
// this covers the M0 corpus (from/alloc/toString/write/concat/compare/slice/
// read-write ints). Divergence-registry note: DIV-BUF-M0.

function makeBuffer(internalBinding) {
  const b = internalBinding("buffer");
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  class Buffer extends Uint8Array {
    static alloc(size, fill, encoding) {
      const buf = new Buffer(size);
      if (fill !== undefined) buf.fill(fill, 0, size, encoding);
      return buf;
    }
    static allocUnsafe(size) { return new Buffer(size); }
    static allocUnsafeSlow(size) { return new Buffer(size); }

    static from(value, encodingOrOffset, length) {
      if (typeof value === "string") return fromString(value, encodingOrOffset);
      if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
        const off = encodingOrOffset ?? 0;
        const len = length ?? value.byteLength - off;
        const buf = new Buffer(len);
        buf.set(new Uint8Array(value, off, len));
        return buf;
      }
      if (ArrayBuffer.isView(value)) { const buf = new Buffer(value.length); buf.set(value); return buf; }
      if (Array.isArray(value)) return new Buffer(value);
      if (value && typeof value === "object" && typeof value.length === "number") return new Buffer(Array.from(value));
      throw new TypeError("Buffer.from: unsupported argument");
    }

    static concat(list, totalLength) {
      if (totalLength === undefined) { totalLength = 0; for (const x of list) totalLength += x.length; }
      const out = new Buffer(totalLength);
      let off = 0;
      for (const x of list) { if (off >= totalLength) break; out.set(x.subarray(0, Math.min(x.length, totalLength - off)), off); off += x.length; }
      return out;
    }

    static isBuffer(o) { return o instanceof Buffer; }
    static isEncoding(e) { return ["utf8", "utf-8", "ascii", "latin1", "binary", "base64", "base64url", "hex", "ucs2", "ucs-2", "utf16le", "utf-16le"].includes(String(e).toLowerCase()); }
    static byteLength(str, encoding) {
      if (typeof str !== "string") return str.byteLength ?? str.length;
      if (encoding === "hex") return str.length >> 1;
      if (encoding === "base64" || encoding === "base64url") return Math.floor(str.replace(/=+$/, "").length * 3 / 4);
      if (encoding === "ascii" || encoding === "latin1" || encoding === "binary") return str.length;
      return b.byteLengthUtf8(str);
    }

    toString(encoding = "utf8", start = 0, end = this.length) {
      const view = this.subarray(start, end);
      encoding = String(encoding).toLowerCase();
      if (encoding === "utf8" || encoding === "utf-8") return dec.decode(view);
      if (encoding === "hex") return [...view].map((x) => x.toString(16).padStart(2, "0")).join("");
      if (encoding === "base64") return base64(view, false);
      if (encoding === "base64url") return base64(view, true);
      if (encoding === "ascii") return [...view].map((x) => String.fromCharCode(x & 0x7f)).join("");
      if (encoding === "latin1" || encoding === "binary") return [...view].map((x) => String.fromCharCode(x)).join("");
      if (encoding === "ucs2" || encoding === "ucs-2" || encoding === "utf16le" || encoding === "utf-16le") {
        let s = ""; for (let i = 0; i + 1 < view.length; i += 2) s += String.fromCharCode(view[i] | (view[i + 1] << 8)); return s;
      }
      return dec.decode(view);
    }

    write(string, offset = 0, length, encoding = "utf8") {
      if (typeof offset === "string") { encoding = offset; offset = 0; length = this.length; }
      else if (typeof length === "string") { encoding = length; length = this.length - offset; }
      if (length === undefined) length = this.length - offset;
      encoding = String(encoding).toLowerCase();
      if (encoding === "hex") { let n = 0; for (let i = 0; i < length && i * 2 + 1 < string.length; i++) { this[offset + i] = parseInt(string.substr(i * 2, 2), 16); n++; } return n; }
      if (encoding === "latin1" || encoding === "ascii" || encoding === "binary") return b.latin1WriteStatic(this, string, offset, length);
      return b.utf8WriteStatic(this, string, offset, length);
    }

    fill(value, start = 0, end = this.length, encoding) {
      if (typeof value === "string") { const bytes = enc.encode(value); for (let i = start; i < end; i++) this[i] = bytes[(i - start) % bytes.length]; return this; }
      return super.fill(value, start, end);
    }

    equals(other) { return b.compare(this, other) === 0; }
    compare(other) { return b.compare(this, other); }
    copy(target, ts = 0, ss = 0, se = this.length) { return b.copy(this, target, ts, ss, se); }
    slice(start, end) { return this.subarray(start, end); }
    subarray(start, end) { const s = super.subarray(start, end); Object.setPrototypeOf(s, Buffer.prototype); return s; }
    indexOf(val, byteOffset, encoding) {
      if (typeof val === "number") return b.indexOfNumber(this, val & 0xff, byteOffset ?? 0, true);
      const needle = typeof val === "string" ? enc.encode(val) : val;
      return b.indexOfBuffer(this, needle, byteOffset ?? 0, null, true);
    }
    includes(val, byteOffset, encoding) { return this.indexOf(val, byteOffset, encoding) !== -1; }

    readUInt8(o = 0) { return this[o]; }
    readInt8(o = 0) { return (this[o] << 24) >> 24; }
    readUInt16LE(o = 0) { return this[o] | (this[o + 1] << 8); }
    readUInt16BE(o = 0) { return (this[o] << 8) | this[o + 1]; }
    readUInt32LE(o = 0) { return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000; }
    readUInt32BE(o = 0) { return this[o] * 0x1000000 + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]); }
    readBigUInt64LE(o = 0) { return new DataView(this.buffer, this.byteOffset).getBigUint64(o, true); }
    readDoubleLE(o = 0) { return new DataView(this.buffer, this.byteOffset).getFloat64(o, true); }
    writeUInt8(v, o = 0) { this[o] = v & 0xff; return o + 1; }
    writeUInt16LE(v, o = 0) { this[o] = v & 0xff; this[o + 1] = (v >>> 8) & 0xff; return o + 2; }
    writeUInt32LE(v, o = 0) { new DataView(this.buffer, this.byteOffset).setUint32(o, v, true); return o + 4; }
    writeBigUInt64LE(v, o = 0) { new DataView(this.buffer, this.byteOffset).setBigUint64(o, v, true); return o + 8; }
    writeDoubleLE(v, o = 0) { new DataView(this.buffer, this.byteOffset).setFloat64(o, v, true); return o + 8; }

    toJSON() { return { type: "Buffer", data: [...this] }; }
    get [Symbol.toStringTag]() { return "Uint8Array"; }
  }

  function fromString(str, encoding = "utf8") {
    encoding = String(encoding || "utf8").toLowerCase();
    if (encoding === "hex") { const out = new Buffer(str.length >> 1); for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16); return out; }
    if (encoding === "base64" || encoding === "base64url") return Buffer.from(fromBase64(str).buffer);
    if (encoding === "latin1" || encoding === "binary" || encoding === "ascii") { const out = new Buffer(str.length); for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff; return out; }
    if (encoding === "ucs2" || encoding === "ucs-2" || encoding === "utf16le" || encoding === "utf-16le") { const out = new Buffer(str.length * 2); const dv = new DataView(out.buffer); for (let i = 0; i < str.length; i++) dv.setUint16(i * 2, str.charCodeAt(i), true); return out; }
    return Buffer.from(enc.encode(str).buffer);
  }
  function base64(view, url) {
    let bin = ""; for (const x of view) bin += String.fromCharCode(x);
    let s = globalThis.btoa(bin);
    if (url) s = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return s;
  }
  function fromBase64(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = globalThis.atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  Buffer.poolSize = 8192;
  return Buffer;
}

export { makeBuffer };
