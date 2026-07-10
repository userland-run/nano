#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Produce the browser-loadable gzip variant of the node-lib bundle (K9-browser).
// The canonical bundle is brotli (.br) — smallest over the wire and read by the
// Node/worker_threads disk path. Browsers, however, have no brotli in
// DecompressionStream (only gzip/deflate), and cannot readFileSync. So the host
// loader fetches a gzip sibling and inflates it with DecompressionStream("gzip").
// This tool decompresses the .br and re-compresses it as .gz IN PLACE next to it
// so the two are byte-identical once inflated. Regenerate whenever the .br
// bundle changes (i.e. after tools/vendor-node-lib.mjs).
//
// Usage: node tools/make-gz-bundle.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { brotliDecompressSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "vendor", "node-lib");
const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
const brPath = join(dir, `node-lib-${index.version}.bundle.br`);
const gzPath = join(dir, `node-lib-${index.version}.bundle.gz`);

if (!existsSync(brPath)) {
  console.error(`make-gz-bundle: ${brPath} missing — run tools/vendor-node-lib.mjs first`);
  process.exit(1);
}

const decompressed = brotliDecompressSync(readFileSync(brPath), { maxOutputLength: 1 << 30 });
const gz = gzipSync(decompressed, { level: 9 });
writeFileSync(gzPath, gz);
console.error(
  `make-gz-bundle: ${(decompressed.length / 1024 / 1024).toFixed(2)}MB → ` +
    `${(gz.length / 1024).toFixed(0)}K gzip → ${gzPath}`,
);
