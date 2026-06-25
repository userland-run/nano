#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Bundles npm package tests into single-file scripts that can run in NanoVM.
 * Each bundle is a self-contained JS file with the npm package inlined.
 *
 * Usage: npm run build  (from the bundles/ directory)
 * Output: ../tests/bundle-*.js
 */
import { build } from 'esbuild';
import { readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, 'src');
const outDir = resolve(__dirname, '..', 'tests');

const sources = readdirSync(srcDir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));

for (const src of sources) {
  const name = basename(src, '.mjs').replace(/\.js$/, '');
  const outFile = resolve(outDir, `bundle-${name}.js`);

  try {
    await build({
      entryPoints: [resolve(srcDir, src)],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      outfile: outFile,
      minify: false,
      // Don't bundle Node.js built-ins
      external: ['fs', 'path', 'crypto', 'zlib', 'os', 'util', 'assert', 'vm',
                  'stream', 'events', 'buffer', 'url', 'querystring', 'child_process',
                  'http', 'https', 'net', 'tls', 'dns', 'tty', 'worker_threads'],
    });
    console.log(`  ✓ bundle-${name}.js`);
  } catch (e) {
    console.error(`  ✗ bundle-${name}.js: ${e.message}`);
  }
}

console.log('\nDone. Bundles written to test/nodejs/tests/');
