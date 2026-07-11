#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Differential harness (spec §16). Runs a corpus of scripts on the nodert
 * tier and on an oracle, then diffs stdout + exit code.
 *
 * Oracle modes:
 *   default   — host Node (fast; validates JS-semantic fidelity of pure-JS
 *               scripts: console/Buffer/timers/process/ordering).
 *   --vm      — the real Node v25.4.0 in NanoVM via test/run.mjs (the spec's
 *               reference oracle; slow, needs images/node; runs the full
 *               corpus incl. fs against a seeded VFS).
 *
 * A diff is a FAILURE unless annotated with a divergence-registry id in the
 * corpus entry's `div` field (mechanizing G4).
 *
 * Usage: node nodert/test/differential.mjs [--vm]
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel } from "../../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const useVm = process.argv.includes("--vm");

// Corpus: each entry may seed files (path→contents) into the VFS/oracle.
// `pure: true` means no fs — safe to run against the host-node oracle.
const CORPUS = [
  { name: "hello", pure: true, src: `console.log("hello world")` },
  { name: "multi-arg", pure: true, src: `console.log("a", 1, true, null, undefined)` },
  { name: "format-s-d", pure: true, src: `console.log("%s=%d", "x", 42)` },
  { name: "array-inspect", pure: true, src: `console.log([1, "two", [3, 4]])` },
  { name: "object-inspect", pure: true, src: `console.log({a: 1, nested: {b: 2}})` },
  { name: "process-argv", pure: true, src: `console.log(process.argv.length >= 2)` },
  { name: "buffer-hex", pure: true, src: `console.log(Buffer.from("hi").toString("hex"))` },
  { name: "buffer-base64", pure: true, src: `console.log(Buffer.from("hello").toString("base64"))` },
  { name: "buffer-concat", pure: true, src: `console.log(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]).toString())` },
  { name: "buffer-compare", pure: true, src: `console.log(Buffer.from("a").compare(Buffer.from("b")))` },
  { name: "json", pure: true, src: `console.log(JSON.stringify({x: [1, 2], y: "z"}))` },
  { name: "exit-code", pure: true, src: `console.log("k"); process.exit(2)`, exit: 2 },
  { name: "ordering-immediate-timeout", pure: true, src: `setImmediate(() => console.log("imm")); setTimeout(() => console.log("to"), 0); console.log("sync")` },
  { name: "ordering-nexttick-promise", pure: true, src: `Promise.resolve().then(() => console.log("promise")); process.nextTick(() => console.log("tick")); console.log("sync")` },
  // The VM's emulated `**` has an FP-precision quirk (1024.0000000000002);
  // nodert matches real x86 Node exactly (1024). DIV-VM-POW: the VM diverges,
  // not nodert — annotated so the VM-oracle run doesn't fail on it.
  { name: "math", pure: true, div: "DIV-VM-POW", src: `console.log(Math.max(1, 9, 4), (2 ** 10), Number.isInteger(3.0))` },
  { name: "string-methods", pure: true, src: `console.log("Hello".toUpperCase(), "a,b,c".split(",").length, "  x  ".trim())` },
  { name: "date-utc", pure: true, src: `console.log(new Date(0).toISOString())` },
  { name: "try-catch", pure: true, src: `try { null.x } catch (e) { console.log(e.constructor.name) }` },
  { name: "async-await", pure: true, src: `(async () => { const v = await Promise.resolve(7); console.log(v * 2) })()` },
  { name: "path-upstream", pure: true, src: `const p = require("path"); console.log(p.join("/a", "b", "../c"), p.dirname("/x/y/z"))` },
  { name: "fs-read", src: `console.log(require("fs").readFileSync("/seed.txt", "utf8").trim())`, seed: { "/seed.txt": "seeded\n" } },
  { name: "fs-write-read", src: `const fs=require("fs"); fs.writeFileSync("/tmp/o.txt","data"); console.log(fs.readFileSync("/tmp/o.txt","utf8"))`, seedDirs: ["/tmp"] },
  { name: "fs-readdir", src: `const fs=require("fs"); console.log(fs.readdirSync("/d").sort().join(","))`, seed: { "/d/a": "", "/d/b": "" } },
  // crypto (M1) — hash/hmac outputs byte-checked against the oracle
  { name: "crypto-sha256", pure: true, src: `console.log(require("crypto").createHash("sha256").update("hello world").digest("hex"))` },
  { name: "crypto-sha1", pure: true, src: `console.log(require("crypto").createHash("sha1").update("The quick brown fox").digest("hex"))` },
  { name: "crypto-hmac", pure: true, src: `console.log(require("crypto").createHmac("sha256","secret").update("message").digest("hex"))` },
  { name: "crypto-base64-digest", pure: true, src: `console.log(require("crypto").createHash("sha256").update("abc").digest("base64"))` },
  // streams (M1)
  { name: "stream-transform", pure: true, src: `const {Readable,Transform}=require("stream"); const up=new Transform({transform(c,e,cb){cb(null,c.toString().toUpperCase())}}); let o=""; up.on("data",d=>o+=d); up.on("end",()=>console.log(o)); Readable.from(["ab","cd"]).pipe(up)` },
];

async function runOnNodert(entry) {
  const kernel = new Kernel();
  if (entry.seedDirs) for (const d of entry.seedDirs) kernel.vfs.mkdir(d, 0o777);
  if (entry.seed) for (const [p, c] of Object.entries(entry.seed)) kernel.vfs.rootMem.createFile(p, c);
  const r = await runNode(kernel, { argv: ["node", "-e", entry.src], source: entry.src, cwd: "/", env: {}, timeoutMs: 20000 });
  return { stdout: r.stdout, exit: r.exitCode };
}

function runOnHostNode(entry) {
  // Seed files into host fs at the same absolute paths is unsafe; the pure
  // corpus has no fs, so the host oracle only runs pure entries.
  try {
    const out = execFileSync(process.execPath, ["-e", entry.src], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    return { stdout: out, exit: 0 };
  } catch (e) {
    return { stdout: e.stdout ?? "", exit: e.status ?? 1 };
  }
}

function runOnVm(entry) {
  // The real Node v25.4.0 in NanoVM, seeded via a launcher that writes files.
  const RUNNER = join(here, "..", "..", "test", "run.mjs");
  const NODE_ELF = join(here, "..", "..", "images", "node");
  const seedJs = [];
  if (entry.seedDirs) for (const d of entry.seedDirs) seedJs.push(`require('fs').mkdirSync(${JSON.stringify(d)},{recursive:true});`);
  if (entry.seed) for (const [p, c] of Object.entries(entry.seed)) {
    const dir = p.slice(0, p.lastIndexOf("/")) || "/";
    seedJs.push(`require('fs').mkdirSync(${JSON.stringify(dir)},{recursive:true});require('fs').writeFileSync(${JSON.stringify(p)},${JSON.stringify(c)});`);
  }
  const wrapped = seedJs.join("") + entry.src;
  try {
    const out = execFileSync(process.execPath, [RUNNER, NODE_ELF, "--cmd", "node", "-e", wrapped], {
      encoding: "utf8", timeout: 180000, env: { ...process.env, NANOVM_RAM_MB: "1800" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 << 20,
    });
    return { stdout: out, exit: 0 };
  } catch (e) {
    return { stdout: e.stdout ?? "", exit: e.status ?? 1 };
  }
}

let passed = 0, failed = 0, skipped = 0;
const oracle = useVm ? runOnVm : runOnHostNode;

for (const entry of CORPUS) {
  if (!useVm && !entry.pure) { skipped++; continue; }
  const got = await runOnNodert(entry);
  const want = oracle(entry);
  const outOk = got.stdout === want.stdout;
  const exitOk = got.exit === want.exit && got.exit === (entry.exit ?? got.exit);
  if (outOk && exitOk) {
    passed++;
    console.log(`  PASS: ${entry.name}`);
  } else if (entry.div) {
    passed++;
    console.log(`  PASS: ${entry.name} (divergence ${entry.div})`);
  } else {
    failed++;
    console.error(`  FAIL: ${entry.name}`);
    console.error(`    nodert: exit=${got.exit} out=${JSON.stringify(got.stdout)}`);
    console.error(`    oracle: exit=${want.exit} out=${JSON.stringify(want.stdout)}`);
  }
}

console.log(`\n=== differential (${useVm ? "VM oracle" : "host-node oracle"}): ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
process.exit(failed > 0 ? 1 : 0);
