#!/usr/bin/env node
// Generate nano-syscalls.json — the authoritative set of syscall numbers nano
// implements — by parsing the markdown tables in docs/syscalls.md. Every table
// row whose first column is an integer is an implemented syscall; the "Virtual
// Server Exports" table uses `vm_*` names in its first column and is skipped
// naturally (no integer there).
//
// Usage:  node tools/gen-syscalls-json.mjs [docs/syscalls.md] [Cargo.toml] > nano-syscalls.json
//
// The conformance gate (catalog/tools/gate.mjs) consumes this file: a submission
// passes only if every syscall it invokes appears in `supported`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const docsPath = process.argv[2] ?? resolve(repoRoot, 'docs/syscalls.md');
const cargoPath = process.argv[3] ?? resolve(repoRoot, 'Cargo.toml');

function readVersion(path) {
  const txt = readFileSync(path, 'utf8');
  // First `version = "x.y.z"` under [package].
  const m = txt.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error(`could not find version in ${path}`);
  return m[1];
}

function parseSyscalls(md) {
  const nums = new Set();
  for (const line of md.split('\n')) {
    // Markdown table data row: | <nr> | <name> | <notes> |
    const m = line.match(/^\s*\|\s*(\d+)\s*\|\s*([A-Za-z0-9_]+)\s*\|/);
    if (m) nums.add(Number(m[1]));
  }
  return [...nums].sort((a, b) => a - b);
}

const supported = parseSyscalls(readFileSync(docsPath, 'utf8'));
if (supported.length === 0) {
  console.error(`error: no syscall rows parsed from ${docsPath}`);
  process.exit(1);
}

const out = {
  nano_version: readVersion(cargoPath),
  source: 'docs/syscalls.md',
  supported,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
