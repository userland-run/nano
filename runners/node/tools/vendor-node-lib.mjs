#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.
// NOTE: the OUTPUT under vendor/ is upstream Node.js code (MIT) — see
// vendor/node-lib/LICENSE and the repo NOTICE.

/**
 * Vendor upstream Node.js lib/ for the nodert tier (UL-SPEC/nodert §8, P2:
 * "never fork Node's JavaScript").
 *
 * Fetches the pinned Node source tarball (same source of truth as
 * build/node-riscv/build.sh, so `process.version` parity with the VM image is
 * automatic), extracts lib/ * *.js + lib/internal/per_context/* byte-identical,
 * and packs them into one brotli bundle with a lazy-eval index:
 *
 *   vendor/node-lib/node-lib-<ver>.bundle.br  brotli(concat of module sources)
 *   vendor/node-lib/index.json                { id: [offset, length, sha256] }
 *   vendor/node-lib/MANIFEST.json             tag + tarball/bundle/file hashes
 *   vendor/node-lib/LICENSE                   upstream Node LICENSE
 *   vendor/cjs-module-lexer/                  deps/cjs-module-lexer (pure JS)
 *
 * Usage:
 *   node tools/vendor-node-lib.mjs             # (re)generate
 *   node tools/vendor-node-lib.mjs --verify    # CI: fail on any divergence
 *   node tools/vendor-node-lib.mjs --version v25.4.0
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, constants } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const VENDOR = join(root, "vendor");
const CACHE = join(root, ".cache");

const args = process.argv.slice(2);
const VERIFY = args.includes("--verify");
const verIdx = args.indexOf("--version");
const VERSION = verIdx >= 0 ? args[verIdx + 1] : "v25.4.0";

const TARBALL_URL = `https://nodejs.org/dist/${VERSION}/node-${VERSION}.tar.gz`;
const PREFIX = `node-${VERSION}/`;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchTarball() {
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, `node-${VERSION}.tar.gz`);
  if (existsSync(cached)) {
    console.log(`using cached ${cached}`);
    return readFileSync(cached);
  }
  console.log(`fetching ${TARBALL_URL} …`);
  const res = await fetch(TARBALL_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(cached, buf);
  console.log(`cached ${buf.length} bytes → ${cached}`);
  return buf;
}

/** Minimal ustar/GNU tar reader — returns Map<path, Buffer> for kept paths. */
function extractTar(tar, keep) {
  const files = new Map();
  let offset = 0;
  let longName = "";
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const nameRaw = header.toString("utf8", 0, 100).replace(/\0.*/s, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*/s, "");
    const sizeOctal = header.toString("utf8", 124, 136).replace(/\0.*/s, "").trim();
    const typeFlag = String.fromCharCode(header[156]);
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    offset += 512;

    if (typeFlag === "L") {
      longName = tar.toString("utf8", offset, offset + size).replace(/\0.*/s, "");
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    const name = longName || (prefix ? prefix + "/" + nameRaw : nameRaw);
    longName = "";
    if ((typeFlag === "0" || typeFlag === "\0") && keep(name)) {
      files.set(name, Buffer.from(tar.subarray(offset, offset + size)));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

function moduleId(path) {
  // node-v25.4.0/lib/internal/bootstrap/realm.js → internal/bootstrap/realm
  return path.slice(PREFIX.length + "lib/".length).replace(/\.js$/, "");
}

async function build() {
  const tarball = await fetchTarball();
  const tarballSha256 = sha256(tarball);
  console.log(`tarball sha256 ${tarballSha256}`);
  const tar = gunzipSync(tarball, { maxOutputLength: 1024 * 1024 * 1024 });

  const files = extractTar(tar, (name) => {
    if (!name.startsWith(PREFIX)) return false;
    const rel = name.slice(PREFIX.length);
    if (rel === "LICENSE") return true;
    if (rel.startsWith("lib/") && rel.endsWith(".js")) return true;
    if (rel.startsWith("deps/cjs-module-lexer/") && !rel.includes("/src/") &&
        /\.(js|mjs|json)$|LICENSE$/.test(rel)) return true;
    return false;
  });

  const libPaths = [...files.keys()]
    .filter((p) => p.startsWith(PREFIX + "lib/"))
    .sort();
  if (libPaths.length === 0) throw new Error("no lib/ files found in tarball");

  // Concatenate sources; record [byteOffset, byteLength, sha256] per module.
  const index = { version: VERSION, modules: {} };
  const chunks = [];
  let offset = 0;
  for (const p of libPaths) {
    const src = files.get(p);
    index.modules[moduleId(p)] = [offset, src.length, sha256(src)];
    chunks.push(src);
    offset += src.length;
  }
  const raw = Buffer.concat(chunks);
  const bundle = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 9,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });

  const manifest = {
    tag: VERSION,
    source: TARBALL_URL,
    tarballSha256,
    moduleCount: libPaths.length,
    rawBytes: raw.length,
    bundleSha256: sha256(bundle),
  };

  return { files, index, bundle, manifest };
}

function writeOutputs({ files, index, bundle, manifest }) {
  const libDir = join(VENDOR, "node-lib");
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(libDir, `node-lib-${VERSION}.bundle.br`), bundle);
  writeFileSync(join(libDir, "index.json"), JSON.stringify(index));
  writeFileSync(join(libDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  const license = files.get(PREFIX + "LICENSE");
  if (license) writeFileSync(join(libDir, "LICENSE"), license);

  const lexerDir = join(VENDOR, "cjs-module-lexer");
  for (const [p, buf] of files) {
    if (!p.startsWith(PREFIX + "deps/cjs-module-lexer/")) continue;
    const rel = p.slice((PREFIX + "deps/cjs-module-lexer/").length);
    const out = join(lexerDir, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buf);
  }
  console.log(
    `wrote ${manifest.moduleCount} modules, raw ${(manifest.rawBytes / 1e6).toFixed(1)} MB → bundle ${(bundle.length / 1e6).toFixed(1)} MB`
  );
}

function verifyOutputs({ index, manifest }) {
  const libDir = join(VENDOR, "node-lib");
  const problems = [];
  const check = (cond, msg) => cond || problems.push(msg);

  const manifestPath = join(libDir, "MANIFEST.json");
  check(existsSync(manifestPath), "MANIFEST.json missing — run `npm run vendor`");
  if (existsSync(manifestPath)) {
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
    check(onDisk.tag === manifest.tag, `tag mismatch: ${onDisk.tag} vs ${manifest.tag}`);
    check(
      onDisk.tarballSha256 === manifest.tarballSha256,
      "tarball hash mismatch — upstream tag content changed?!"
    );
    check(
      onDisk.bundleSha256 === manifest.bundleSha256,
      "bundle hash differs from a fresh build — vendored lib/ was modified (P2 violation)"
    );
  }
  const bundlePath = join(libDir, `node-lib-${VERSION}.bundle.br`);
  check(existsSync(bundlePath), "bundle missing");
  if (existsSync(bundlePath)) {
    const raw = brotliDecompressSync(readFileSync(bundlePath), {
      maxOutputLength: 1024 * 1024 * 1024,
    });
    const onDiskIndex = JSON.parse(readFileSync(join(libDir, "index.json"), "utf8"));
    for (const [id, [off, len, hash]] of Object.entries(onDiskIndex.modules)) {
      const fresh = index.modules[id];
      if (!fresh) {
        problems.push(`module ${id} in vendored index but not in the tag`);
        continue;
      }
      if (fresh[2] !== hash) problems.push(`module ${id} sha256 differs from the tag`);
      if (sha256(raw.subarray(off, off + len)) !== hash)
        problems.push(`module ${id} bundle bytes don't match its index hash`);
    }
    for (const id of Object.keys(index.modules)) {
      if (!onDiskIndex.modules[id]) problems.push(`module ${id} in the tag but missing from the vendored index`);
    }
  }
  if (problems.length) {
    console.error(`✗ vendored node-lib diverges from ${VERSION}:`);
    for (const p of problems.slice(0, 20)) console.error("  • " + p);
    if (problems.length > 20) console.error(`  … and ${problems.length - 20} more`);
    process.exit(1);
  }
  console.log(`✓ vendored node-lib is byte-identical to ${VERSION} (${manifest.moduleCount} modules)`);
}

const result = await build();
if (VERIFY) verifyOutputs(result);
else writeOutputs(result);
