// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/persist/node-modules.mjs — materialize node_modules by HARDLINKING
// package files from the CAS (spec §6.4, pnpm model). Each package's files are
// stored once in the CAS (keyed by content hash) and hardlinked into
// node_modules/<pkg>/… — so N projects sharing a dependency version share one
// inode, and materialization is O(entries) with no data copy.

/**
 * @param {import("../kernel.mjs").Kernel} kernel
 * @param {string} projectDir  e.g. "/app"
 * @param {Record<string, { files: Record<string, { bytes?: Uint8Array, key?: string, mode?: number, integrity?: string }>, packageJson?: object }>} packages
 * @returns {Promise<{ linked: number, packages: string[] }>}
 */
async function materializePackages(kernel, projectDir, packages) {
  const cas = kernel.cas;
  const nmRoot = `${projectDir.replace(/\/$/, "")}/node_modules`;
  let linked = 0;
  const names = [];

  for (const [name, pkg] of Object.entries(packages)) {
    const pkgDir = `${nmRoot}/${name}`;
    // package.json (written from the object or from a files entry).
    const pj = pkg.packageJson ?? (pkg.files["package.json"] ? JSON.parse(new TextDecoder().decode(await bytesOf(cas, pkg.files["package.json"]))) : { name });
    for (const [rel, entry] of Object.entries(pkg.files)) {
      const bytes = await bytesOf(cas, entry);
      const key = entry.key ?? (await cas.put(bytes, entry.integrity)).key;
      if (entry.integrity) cas.pin(entry.integrity);
      cas.link(key, `${pkgDir}/${rel}`, entry.mode ?? 0o644);
      linked++;
    }
    // Bin symlinks into node_modules/.bin (npx / lifecycle scripts).
    const bin = pj.bin;
    if (bin) {
      const binDir = `${nmRoot}/.bin`;
      for (const [binName, binPath] of Object.entries(typeof bin === "string" ? { [pj.name ?? name]: bin } : bin)) {
        try { kernel.vfs.rootMem.mkdir(binDir, 0o755); } catch {}
        const target = `${pkgDir}/${String(binPath).replace(/^\.\//, "")}`;
        try { kernel.vfs.rootMem.createSymlink(`${binDir}/${binName}`, target); } catch {}
      }
    }
    names.push(name);
  }
  return { linked, packages: names };
}

async function bytesOf(cas, entry) {
  if (entry.bytes) return entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
  if (entry.key && cas.has(entry.key)) return cas.read(entry.key);
  throw new Error("node_modules materialize: entry has neither bytes nor a CAS key");
}

export { materializePackages };
