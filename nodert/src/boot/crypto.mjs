// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/crypto.mjs — node:crypto subset (spec §8.8, M1). createHash/
// createHmac are SYNC streaming APIs, so they can't use WebCrypto's async
// subtle.digest — sha256/sha1 are implemented in pure JS. randomBytes/
// randomUUID/randomFillSync use crypto.getRandomValues. The BoringSSL-wasm
// service backs the rest (legacy ciphers, DH, scrypt) in a later phase.

function makeCrypto(Buffer) {
  const enc = new TextEncoder();
  const toBytes = (d, encoding) => typeof d === "string" ? (encoding === "hex" ? hexToBytes(d) : encoding === "base64" ? b64ToBytes(d) : enc.encode(d)) : new Uint8Array(d.buffer ?? d, d.byteOffset ?? 0, d.byteLength ?? d.length);

  class Hash {
    constructor(algo) {
      this.algo = algo.toLowerCase().replace(/-/g, "");
      this._chunks = [];
      if (!HASHES[this.algo]) throw new Error(`Digest method not supported: ${algo}`);
    }
    update(data, encoding) { this._chunks.push(toBytes(data, encoding)); return this; }
    digest(encoding) {
      const all = concat(this._chunks);
      const out = HASHES[this.algo](all);
      return encoding ? encodeBytes(out, encoding) : Buffer.from(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    }
  }

  class Hmac {
    constructor(algo, key) {
      this.algo = algo.toLowerCase().replace(/-/g, "");
      const h = HASHES[this.algo];
      if (!h) throw new Error(`Digest method not supported: ${algo}`);
      const block = 64; // sha1/sha256 block size
      let k = toBytes(key);
      if (k.length > block) k = h(k);
      const kp = new Uint8Array(block); kp.set(k);
      this._opad = kp.map((b) => b ^ 0x5c);
      this._ipad = kp.map((b) => b ^ 0x36);
      this._chunks = [this._ipad];
    }
    update(data, encoding) { this._chunks.push(toBytes(data, encoding)); return this; }
    digest(encoding) {
      const inner = HASHES[this.algo](concat(this._chunks));
      const out = HASHES[this.algo](concat([this._opad, inner]));
      return encoding ? encodeBytes(out, encoding) : Buffer.from(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    }
  }

  const randomBytes = (size, cb) => {
    const buf = Buffer.allocUnsafe(size);
    globalThis.crypto.getRandomValues(buf);
    if (cb) { queueMicrotask(() => cb(null, buf)); return; }
    return buf;
  };

  return {
    createHash: (algo) => new Hash(algo),
    createHmac: (algo, key) => new Hmac(algo, key),
    randomBytes,
    randomFillSync: (buf, offset = 0, size = buf.length - offset) => { const t = new Uint8Array(buf.buffer, buf.byteOffset + offset, size); globalThis.crypto.getRandomValues(t); return buf; },
    randomFill: (buf, cb) => { globalThis.crypto.getRandomValues(buf); queueMicrotask(() => cb(null, buf)); },
    randomUUID: () => globalThis.crypto.randomUUID(),
    randomInt: (min, max) => { if (max === undefined) { max = min; min = 0; } return min + Math.floor(Math.random() * (max - min)); },
    getHashes: () => Object.keys(HASHES),
    constants: {},
    webcrypto: globalThis.crypto,
    getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
    timingSafeEqual: (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; },
  };

  function hexToBytes(s) { const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; }
  function b64ToBytes(s) { const bin = globalThis.atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }
  function encodeBytes(bytes, encoding) {
    if (encoding === "hex") return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (encoding === "base64") { let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return globalThis.btoa(bin); }
    return new TextDecoder("latin1").decode(bytes);
  }
}

function concat(chunks) {
  let len = 0; for (const c of chunks) len += c.length;
  const out = new Uint8Array(len); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// --- pure-JS SHA-256 and SHA-1 (sync; the common createHash algorithms) ---
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256(msg) {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const padded = pad(msg, 8, false);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const view = new DataView(padded.buffer);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return u32beToBytes(H);
}
function sha1(msg) {
  const H = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const padded = pad(msg, 8, false);
  const w = new Uint32Array(80);
  const rol = (x, n) => (x << n) | (x >>> (32 - n));
  const view = new DataView(padded.buffer);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4);
    for (let t = 16; t < 80; t++) w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let [a, b, c, d, e] = H;
    for (let t = 0; t < 80; t++) {
      let f, k;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (rol(a, 5) + f + e + k + w[t]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = tmp;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
  }
  return u32beToBytes(H);
}
function pad(msg, lenBytes, littleEndian) {
  const bitLen = msg.length * 8;
  const withOne = msg.length + 1;
  const total = Math.ceil((withOne + 8) / 64) * 64;
  const out = new Uint8Array(total);
  out.set(msg);
  out[msg.length] = 0x80;
  const dv = new DataView(out.buffer);
  dv.setUint32(total - 4, bitLen >>> 0, littleEndian);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), littleEndian);
  return out;
}
function u32beToBytes(H) {
  const out = new Uint8Array(H.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < H.length; i++) dv.setUint32(i * 4, H[i]);
  return out;
}

const HASHES = { sha256, sha1 };

export { makeCrypto };
