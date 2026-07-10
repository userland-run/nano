// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/lib-bundle.mjs — loads the vendored Node lib/ bundle and
// exposes lazy per-module compilation (spec §8.1). Modules are eval'd through
// host Function with Node's builtin wrapper params; source text is upstream,
// byte-identical (P2).

import { isNode } from "../platform.mjs";

let index = null;
let raw = null;

/** Initialize from an already-decompressed bundle (browser passes bytes). */
function initFromBytes(indexJson, rawBytes) {
  index = indexJson;
  raw = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
}

/** Node/worker_threads: read + brotli-decompress the vendored bundle from disk. */
async function initFromDisk() {
  const { readFileSync } = await import("node:fs");
  const { brotliDecompressSync } = await import("node:zlib");
  const dir = new URL("../../vendor/node-lib/", import.meta.url);
  index = JSON.parse(readFileSync(new URL("index.json", dir), "utf8"));
  raw = brotliDecompressSync(readFileSync(new URL(`node-lib-${index.version}.bundle.br`, dir)), {
    maxOutputLength: 1 << 30,
  });
}

async function ensureInit(init) {
  if (index) return;
  if (init?.libIndex && init?.libBytes) {
    initFromBytes(init.libIndex, init.libBytes);
  } else if (isNode) {
    await initFromDisk();
  } else {
    throw new Error("nodert lib bundle not provided");
  }
}

function hasModule(id) {
  return index != null && Object.prototype.hasOwnProperty.call(index.modules, id.replace(/^node:/, ""));
}

function sourceOf(id) {
  const norm = id.replace(/^node:/, "");
  const e = index?.modules[norm];
  if (!e) return null;
  return new TextDecoder().decode(raw.subarray(e[0], e[0] + e[1]));
}

const builtinIds = () => (index ? Object.keys(index.modules) : []);

const version = () => index?.version ?? null;

export { ensureInit, initFromBytes, hasModule, sourceOf, builtinIds, version };
