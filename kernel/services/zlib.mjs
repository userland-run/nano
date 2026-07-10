// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/services/zlib.mjs — the zlib Kernel Service (spec §8.8, §13).
// Real gzip/deflate backed by the platform: the browser's native
// CompressionStream/DecompressionStream (no wasm needed), or node:zlib under
// Node. `node:zlib` on the nodert tier maps onto this service. A pluggable
// wasm backend can replace the platform impl where byte-exact zlib framing
// matters (the spec keeps zlib-wasm authoritative; this is the fast default).

async function createZlibService() {
  const impl = await pickBackend();
  return {
    id: "zlib",
    version: "1.0.0",
    kind: "wasm-service",
    methods: ["gzip", "gunzip", "deflate", "inflate", "deflateRaw", "inflateRaw", "brotliCompress", "brotliDecompress"],
    async invoke(method, payload) {
      const data = toU8(payload?.data ?? payload);
      const out = await impl(method, data);
      // Result binary rides as an ArrayBuffer (transferable).
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    },
  };
}

function toU8(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === "string") return new TextEncoder().encode(v);
  throw new Error("zlib: unsupported payload");
}

async function pickBackend() {
  // Browser: native streams for gzip/deflate; wasm/brotli fallback noted.
  if (typeof CompressionStream !== "undefined") {
    const via = async (fmt, data) => runStream(new CompressionStream(fmt), data);
    const unvia = async (fmt, data) => runStream(new DecompressionStream(fmt), data);
    return async (method, data) => {
      switch (method) {
        case "gzip": return via("gzip", data);
        case "gunzip": return unvia("gzip", data);
        case "deflate": return via("deflate", data);
        case "inflate": return unvia("deflate", data);
        case "deflateRaw": return via("deflate-raw", data);
        case "inflateRaw": return unvia("deflate-raw", data);
        default: throw new Error(`zlib: ${method} needs the wasm backend in this environment`);
      }
    };
  }
  // Node (headless/tests): node:zlib covers everything incl. brotli.
  const z = await import("node:zlib");
  const map = {
    gzip: z.gzipSync, gunzip: z.gunzipSync, deflate: z.deflateSync, inflate: z.inflateSync,
    deflateRaw: z.deflateRawSync, inflateRaw: z.inflateRawSync,
    brotliCompress: z.brotliCompressSync, brotliDecompress: z.brotliDecompressSync,
  };
  return async (method, data) => {
    const fn = map[method];
    if (!fn) throw new Error(`zlib: unknown method ${method}`);
    return new Uint8Array(fn(data));
  };
}

async function runStream(stream, data) {
  const writer = stream.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export { createZlibService };
