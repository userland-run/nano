// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/lib-loader.mjs — host-side loader for the node-lib bundle +
// binding fixtures (K9-browser). Under Node/worker_threads the worker reads the
// vendored bundle from disk itself; a BROWSER worker cannot (no fs, no brotli in
// DecompressionStream), so the HOST loads the bytes on the main thread and hands
// them to the worker in its init message (lib-bundle.initFromBytes +
// worker-entry loadFixtures both already accept init-provided data).
//
//   Node:    read node-lib-<v>.bundle.br + brotliDecompressSync (canonical path)
//   Browser: fetch node-lib-<v>.bundle.gz + DecompressionStream("gzip")
//            (browsers ship gzip/deflate, not brotli — hence the .gz sibling
//            produced by tools/make-gz-bundle.mjs)
//
// Assets resolve relative to THIS module (…/nodert/vendor/node-lib and
// …/nodert/fixtures/generated), so a vendored copy Just Works wherever it lands.
// The result is cached: one decode serves every nodert spawn.

import { isNode } from "../platform.mjs";

const NODE_LIB_DIR = new URL("../../vendor/node-lib/", import.meta.url);
const FIXTURES_DIR = new URL("../../fixtures/generated/", import.meta.url);
const FIXTURE_FILES = { options: "options.json", config: "config.json", constants: "constants.json", errno: "errno.json" };

let cached = null;

/**
 * Load the node-lib bundle (decompressed) + binding fixtures for handing to a
 * nodert worker. Idempotent (cached). Pass `opts.fetch` to inject the fetcher
 * in tests; pass `opts.force` to bypass the cache.
 * @returns {Promise<{ libIndex: object, libBytes: Uint8Array, fixtures: object }>}
 */
async function loadLibBundle(opts = {}) {
  if (cached && !opts.force) return cached;
  const result = isNode && !opts.forceBrowser ? await loadFromDisk() : await loadByFetch(opts.fetch ?? globalThis.fetch);
  if (!opts.force) cached = result;
  return result;
}

async function loadFromDisk() {
  const { readFileSync } = await import("node:fs");
  const { brotliDecompressSync } = await import("node:zlib");
  const libIndex = JSON.parse(readFileSync(new URL("index.json", NODE_LIB_DIR), "utf8"));
  const libBytes = brotliDecompressSync(readFileSync(new URL(`node-lib-${libIndex.version}.bundle.br`, NODE_LIB_DIR)), {
    maxOutputLength: 1 << 30,
  });
  const fixtures = {};
  for (const [k, f] of Object.entries(FIXTURE_FILES)) fixtures[k] = JSON.parse(readFileSync(new URL(f, FIXTURES_DIR), "utf8"));
  return { libIndex, libBytes, fixtures };
}

async function loadByFetch(fetchFn) {
  if (typeof fetchFn !== "function") throw new Error("nodert: no fetch available to load the lib bundle in this environment");
  const libIndex = await (await fetchFn(new URL("index.json", NODE_LIB_DIR))).json();
  const gzResp = await fetchFn(new URL(`node-lib-${libIndex.version}.bundle.gz`, NODE_LIB_DIR));
  const libBytes = await gunzip(new Uint8Array(await gzResp.arrayBuffer()));
  const fixtures = {};
  for (const [k, f] of Object.entries(FIXTURE_FILES)) fixtures[k] = await (await fetchFn(new URL(f, FIXTURES_DIR))).json();
  return { libIndex, libBytes, fixtures };
}

/** Inflate a gzip byte array via the platform DecompressionStream (browser+Node). */
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export { loadLibBundle };
