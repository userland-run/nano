#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Generate nodert binding fixtures FROM THE VM ORACLE (UL-SPEC/nodert §16, P3).
 *
 * Runs the real Node v25.4.0 RISC-V binary inside NanoVM with
 * --expose-internals and dumps the binding surfaces that nodert must
 * reproduce exactly, so bindings consume recorded truth instead of guesses:
 *
 *   fixtures/generated/options.json    internalBinding('options') full surface
 *   fixtures/generated/config.json     internalBinding('config')
 *   fixtures/generated/constants.json  internalBinding('constants')
 *   fixtures/generated/errno.json      internalBinding('uv').getErrorMap()
 *
 * Requires: ../images/node (Git LFS) and ../wasm/nano.wasm (any build).
 *
 * Usage: node tools/gen-fixtures.mjs [--check]
 *   --check  regenerate in-memory and fail if checked-in fixtures differ
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const nodertRoot = join(here, "..");
const nanoRoot = join(nodertRoot, "..");
const RUNNER = join(nanoRoot, "test", "run.mjs");
const NODE_ELF = join(nanoRoot, "images", "node");
const OUT_DIR = join(nodertRoot, "fixtures", "generated");
const CHECK = process.argv.includes("--check");

// Runs inside the guest. Sentinel-wrapped JSON so runner noise around it is
// ignorable. Maps → objects; BigInt/function/symbol/undefined made JSON-safe.
const GUEST_SCRIPT = `
const { internalBinding } = require("internal/test/binding");
const safe = (v, depth) => {
  if (depth > 12) return "[depth]";
  if (v === undefined) return null;
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (typeof v === "function") return "[function]";
  if (typeof v === "symbol") return v.toString();
  // Brand-check instead of instanceof: internals hand out Maps whose
  // prototype is not the realm Map (SafeMap / snapshot-context Maps).
  if (Object.prototype.toString.call(v) === "[object Map]") {
    const o = {};
    Map.prototype.forEach.call(v, (val, k) => { o[String(k)] = safe(val, depth + 1); });
    return o;
  }
  if (Array.isArray(v)) return v.map((x) => safe(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = safe(v[k], depth + 1);
    return o;
  }
  return v;
};
const ob = internalBinding("options");
const info = ob.getCLIOptionsInfo();
const uv = internalBinding("uv");
const out = {
  meta: {
    version: process.version,
    platform: process.platform,
    arch: process.arch,
    // The dump runs with these flags — consumers must treat the recorded
    // VALUES of these options as invocation artifacts, not defaults.
    // (The -e script body is dropped: it would embed the output sentinel.)
    dumpArgv: process.execArgv.filter((a) => a.startsWith("--")).concat("-e"),
  },
  options: {
    values: safe(ob.getCLIOptionsValues(), 0),
    info: { options: safe(info.options, 0), aliases: safe(info.aliases, 0) },
    embedder: safe(ob.getEmbedderOptions(), 0),
    envOptionsInputType: safe(ob.getEnvOptionsInputType(), 0),
    namespaceOptionsInputType: safe(ob.getNamespaceOptionsInputType(), 0),
    envSettings: safe(ob.envSettings, 0),
    types: safe(ob.types, 0),
  },
  config: safe({ ...internalBinding("config") }, 0),
  constants: safe(internalBinding("constants"), 0),
  errno: safe(uv.getErrorMap(), 0),
};
// Sentinels assembled at runtime so the script body (echoed into argv dumps
// or error traces) can never contain the literal marker.
const S = "___FIX" + "TURES___";
const E = "___E" + "ND___";
console.log(S + JSON.stringify(out) + E);
`;

function runGuest() {
  if (!existsSync(NODE_ELF)) throw new Error(`missing ${NODE_ELF} (git lfs pull?)`);
  console.error("running node --expose-internals inside NanoVM (takes ~1 min)…");
  const stdout = execFileSync(
    process.execPath,
    [RUNNER, NODE_ELF, "--cmd", "node", "--expose-internals", "-e", GUEST_SCRIPT],
    {
      env: { ...process.env, NANOVM_RAM_MB: process.env.NANOVM_RAM_MB || "1800" },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const m = /___FIXTURES___([\s\S]*?)___END___/.exec(stdout);
  if (!m) throw new Error("no fixture sentinel in guest output");
  return JSON.parse(m[1]);
}

const FILES = {
  "options.json": (d) => ({ meta: d.meta, ...d.options }),
  "config.json": (d) => ({ meta: d.meta, config: d.config }),
  "constants.json": (d) => ({ meta: d.meta, constants: d.constants }),
  "errno.json": (d) => ({ meta: d.meta, errno: d.errno }),
};

const dump = runGuest();
if (dump.meta.version !== "v25.4.0") {
  throw new Error(`guest version ${dump.meta.version} != pinned v25.4.0`);
}

let failed = false;
mkdirSync(OUT_DIR, { recursive: true });
for (const [name, pick] of Object.entries(FILES)) {
  const body = JSON.stringify(pick(dump), null, 1) + "\n";
  const path = join(OUT_DIR, name);
  if (CHECK) {
    const onDisk = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (onDisk !== body) {
      console.error(`✗ ${name} differs from a fresh VM dump`);
      failed = true;
    } else {
      console.error(`✓ ${name} matches the VM oracle`);
    }
  } else {
    writeFileSync(path, body);
    console.error(`wrote ${name} (${(body.length / 1024).toFixed(0)} KB)`);
  }
}
if (failed) process.exit(1);
