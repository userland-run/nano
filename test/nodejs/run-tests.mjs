#!/usr/bin/env node
/**
 * Node.js test suite for NanoVM
 * Runs each test file inside the guest VM and reports results.
 *
 * Usage:
 *   node test/nodejs/run-tests.mjs              # run all tests
 *   node test/nodejs/run-tests.mjs math         # run only tests matching "math"
 *   node test/nodejs/run-tests.mjs --list       # list available tests
 */
import { execFileSync } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const runner = resolve(root, 'test/run.mjs');
const nodeElf = resolve(root, 'images/node');

if (!existsSync(nodeElf)) {
  console.error('ERROR: images/node binary not found. Build it first with: bash build/node-riscv/build.sh');
  process.exit(1);
}

// Test definitions
const tests = [
  // === Basics ===
  { name: 'version',        cmd: ['node', '--version'],      expect: /v\d+/ },
  { name: 'hello',          file: 'tests/hello.js',          expect: /PASS/ },
  { name: 'math',           file: 'tests/math.js',           expect: /PASS/ },
  { name: 'string',         file: 'tests/string.js',         expect: /PASS/ },
  { name: 'json',           file: 'tests/json.js',           expect: /PASS/ },
  { name: 'array',          file: 'tests/array.js',          expect: /PASS/ },
  // === Node.js APIs ===
  { name: 'buffer',         file: 'tests/buffer.js',         expect: /PASS/ },
  { name: 'process-info',   file: 'tests/process-info.js',   expect: /PASS/ },
  { name: 'path',           file: 'tests/path.js',           expect: /PASS/ },
  { name: 'events',         file: 'tests/events.js',         expect: /PASS/ },
  { name: 'url',            file: 'tests/url.js',            expect: /PASS/ },
  { name: 'error',          file: 'tests/error-handling.js',  expect: /PASS/ },
  // === Async ===
  { name: 'promise',        file: 'tests/promise.js',        expect: /PASS/ },
  { name: 'timers',         file: 'tests/timers.js',         expect: /PASS/ },
  { name: 'stream',         file: 'tests/stream.js',         expect: /PASS/ },
  // === Filesystem ===
  { name: 'fs-read',        file: 'tests/fs-read.js',        expect: /PASS/ },
  { name: 'fs-write',       file: 'tests/fs-write.js',       expect: /PASS/ },
  { name: 'fs-advanced',    file: 'tests/fs-advanced.js',    expect: /PASS/ },
  // === ES6+ Language Features ===
  { name: 'classes',        file: 'tests/classes.js',        expect: /PASS/ },
  { name: 'iterators',      file: 'tests/iterators.js',      expect: /PASS/ },
  { name: 'proxy-reflect',  file: 'tests/proxy-reflect.js',  expect: /PASS/ },
  { name: 'typed-arrays',   file: 'tests/typed-arrays.js',   expect: /PASS/ },
  { name: 'regex',          file: 'tests/regex.js',          expect: /PASS/ },
  { name: 'collections',    file: 'tests/collections.js',    expect: /PASS/ },
  { name: 'async-patterns', file: 'tests/async-patterns.js', expect: /PASS/ },
  // === Node.js Modules ===
  { name: 'crypto',         file: 'tests/crypto.js',         expect: /PASS/ },
  { name: 'zlib',           file: 'tests/zlib.js',           expect: /PASS/ },
  { name: 'vm-module',      file: 'tests/vm-module.js',      expect: /PASS/ },
  { name: 'assert-util',    file: 'tests/assert-util.js',    expect: /PASS/ },
  // === Node.js Tooling & CLI ===
  { name: 'eval',            cmd: ['node', '-e', 'console.log(6*7)'], expect: /42/ },
  { name: 'print',           cmd: ['node', '-p', 'Math.PI.toFixed(4)'], expect: /3\.1416/ },
  { name: 'eval-require',    cmd: ['node', '-e', 'const p=require("path");console.log(p.basename("/a/b/c.txt"))'], expect: /c\.txt/ },
  { name: 'eval-json',       cmd: ['node', '-e', 'console.log(JSON.stringify({a:1,b:[2,3]}))'], expect: /\{"a":1,"b":\[2,3\]\}/ },
  { name: 'module-system',   file: 'tests/module-system.js',    expect: /PASS/ },
  { name: 'os-module',       file: 'tests/os-module.js',        expect: /PASS/ },
  { name: 'perf-hooks',      file: 'tests/perf-hooks.js',       expect: /PASS/ },
  { name: 'diagnostics',     file: 'tests/diagnostics.js',      expect: /PASS/ },
  { name: 'worker-threads',  file: 'tests/worker-threads.js',   expect: /PASS/ },
  { name: 'esm-dynamic',     file: 'tests/esm-dynamic.js',      expect: /PASS/ },
  { name: 'node-api',        file: 'tests/node-api.js',         expect: /PASS/ },
  { name: 'net-http',        file: 'tests/net-http.js',         expect: /PASS/ },
  // === npm Packages (bundled) ===
  { name: 'react-ssr',      file: 'tests/bundle-react-ssr.js',   expect: /PASS/ },
  { name: 'lodash',         file: 'tests/bundle-lodash-test.js', expect: /PASS/ },
  { name: 'zod',            file: 'tests/bundle-zod-test.js',    expect: /PASS/ },
  { name: 'marked',         file: 'tests/bundle-marked-test.js', expect: /PASS/ },
  { name: 'chalk',          file: 'tests/bundle-chalk-test.js',  expect: /PASS/ },
];

const filter = process.argv[2];

if (filter === '--list') {
  tests.forEach(t => console.log(`  ${t.name}`));
  process.exit(0);
}

let passed = 0, failed = 0, skipped = 0;

console.log('NanoVM Node.js Test Suite');
console.log('========================\n');

for (const test of tests) {
  if (filter && !test.name.includes(filter)) { skipped++; continue; }

  const args = [runner, nodeElf];
  if (test.file) {
    const localPath = resolve(__dirname, test.file);
    args.push('--load', `${localPath}:/test.js`, '--cmd', 'node', '/test.js');
  } else {
    args.push('--cmd', ...test.cmd);
  }

  const label = test.name.padEnd(16);
  process.stdout.write(`  ${label} `);

  try {
    const out = execFileSync('node', args, {
      timeout: 120_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (test.expect && !test.expect.test(out)) {
      console.log(`FAIL  (output: ${out.trim().slice(0, 80)})`);
      failed++;
    } else {
      console.log(`PASS  ${out.trim().slice(0, 60)}`);
      passed++;
    }
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim().split('\n').pop() : '';
    console.log(`FAIL  (exit ${e.status}${stderr ? ': ' + stderr.slice(0, 60) : ''})`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped of ${tests.length} total`);
process.exit(failed > 0 ? 1 : 0);
