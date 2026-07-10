// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/persist/cas-store.mjs — content-addressable store (spec §6.4). Objects
// keyed by their content hash (sha256/sha512), written once, immutable, and
// verified on write against the expected integrity string. Package tarball
// entries land here; `node_modules` is materialized by HARDLINKING from the CAS
// (the pnpm model) so the VFS link() cost is O(entries) with no data copy. The
// CAS is a Kernel facility shared by the catalog installer and npm tooling.
//
// Backing: the CAS lives under a dedicated VFS mount ("/.cas" by default) so it
// persists with whatever backend that mount uses (mem now, opfs in K8-full).

async function sha(algo, bytes) {
  // WebCrypto in the Kernel Worker (browser) / node:crypto (headless).
  if (globalThis.crypto?.subtle) {
    const name = algo === "sha512" ? "SHA-512" : "SHA-256";
    const digest = await globalThis.crypto.subtle.digest(name, bytes);
    return new Uint8Array(digest);
  }
  const { createHash } = await import("node:crypto");
  return new Uint8Array(createHash(algo).update(bytes).digest());
}
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (u8) => {
  let bin = ""; for (const b of u8) bin += String.fromCharCode(b);
  const b64 = (globalThis.btoa ? globalThis.btoa(bin) : Buffer.from(u8).toString("base64"));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

class CasStore {
  /**
   * @param {import("../vfs/vfs.mjs").KernelVfs} vfs
   * @param {{ root?: string }} [opts]
   */
  constructor(vfs, opts = {}) {
    this.vfs = vfs;
    this.root = opts.root ?? "/.cas";
    this._pinned = new Set(); // integrity strings referenced by a live lockfile
    this._ensureDir(this.root);
    this._ensureDir(this.root + "/sha256");
    this._ensureDir(this.root + "/sha512");
  }

  _ensureDir(p) { try { this.vfs.rootMem.mkdir(p, 0o755); } catch {} }

  /** cas://sha256/<hex> path for an object. */
  _objPath(algo, digestHex) { return `${this.root}/${algo}/${digestHex}`; }

  /**
   * Store bytes, verifying against an npm integrity string when given
   * (e.g. "sha512-<base64>"). Returns { key, algo, hex, existed }.
   * @param {Uint8Array} bytes
   * @param {string} [integrity]
   */
  async put(bytes, integrity) {
    let algo = "sha256";
    if (integrity) { const m = /^(sha256|sha512)-/.exec(integrity); if (m) algo = m[1]; }
    const digest = await sha(algo, bytes);
    const h = hex(digest);
    if (integrity) {
      const expected = integrity.slice(integrity.indexOf("-") + 1);
      if (b64url(digest) !== expected.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")) {
        const err = new Error(`CAS integrity mismatch for ${integrity}`);
        err.code = "EINTEGRITY";
        throw err;
      }
    }
    const path = this._objPath(algo, h);
    const existed = this.vfs.rootMem.resolve(path) !== null;
    if (!existed) this.vfs.rootMem.createFile(path, bytes, 0o444);
    return { key: `${algo}/${h}`, algo, hex: h, integrity: `${algo}-${b64url(digest)}`, existed };
  }

  has(key) { return this.vfs.rootMem.resolve(`${this.root}/${key}`) !== null; }
  read(key) { const node = this.vfs.rootMem.resolve(`${this.root}/${key}`); return node?.data ?? null; }

  /**
   * Materialize a file at `destPath` by HARDLINKING the CAS object `key`
   * (pnpm model — O(1), no copy). Falls back to a copy across mounts.
   * @param {string} key @param {string} destPath @param {number} [mode]
   */
  link(key, destPath, mode) {
    const src = `${this.root}/${key}`;
    if (!this.has(key)) { const e = new Error(`CAS object ${key} not found`); e.code = "ENOENT"; throw e; }
    this._mkdirpFor(destPath);
    const r = this.vfs.rootMem.link(src, destPath);
    if (r < 0) {
      // Cross-backend or existing target → copy the bytes.
      const bytes = this.read(key);
      this.vfs.rootMem.createFile(destPath, bytes, mode ?? 0o644);
    } else if (mode != null) {
      this.vfs.rootMem.chmod(destPath, mode);
    }
    return destPath;
  }

  _mkdirpFor(path) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    let cur = "";
    for (const seg of dir.split("/").filter(Boolean)) { cur += "/" + seg; try { this.vfs.rootMem.mkdir(cur, 0o755); } catch {} }
  }

  /** Pin an integrity so eviction never removes it (lockfile-referenced). */
  pin(integrity) { this._pinned.add(integrity); }
  isPinned(integrity) { return this._pinned.has(integrity); }

  /** Stats for introspection. */
  stats() {
    let count = 0, bytes = 0;
    for (const algo of ["sha256", "sha512"]) {
      const dir = this.vfs.rootMem.resolve(`${this.root}/${algo}`);
      if (dir?.children) for (const child of dir.children.values()) { count++; bytes += child.size; }
    }
    return { count, bytes, pinned: this._pinned.size };
  }
}

export { CasStore, sha, hex, b64url };
