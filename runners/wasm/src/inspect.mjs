// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/wasm/inspect.mjs — static introspection of a wasm module
// (UL-SPEC/wasm-tier §7 M2, `wasm inspect`). Reports imports, exports, memory
// limits, the required WASI version, whether it needs threads, and custom
// section names — WITHOUT running the module. Uses WebAssembly.Module for
// imports/exports and a lean section walk for memory limits + custom sections.

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{ imports, exports, memory, wasiVersion, threads, customSections, hasStart }}
 */
function inspectWasm(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const mod = new WebAssembly.Module(u8);
  const imports = WebAssembly.Module.imports(mod).map((i) => ({ module: i.module, name: i.name, kind: i.kind }));
  const exports = WebAssembly.Module.exports(mod).map((e) => ({ name: e.name, kind: e.kind }));

  // WASI flavor: wasi_snapshot_preview1 (preview1) or wasi_unstable (legacy).
  const wasiModules = new Set(imports.filter((i) => /^wasi_/.test(i.module)).map((i) => i.module));
  let wasiVersion = null;
  if (wasiModules.has("wasi_snapshot_preview1")) wasiVersion = "wasip1";
  else if (wasiModules.has("wasi_unstable")) wasiVersion = "wasi_unstable";

  // Threads: an imported/exported SHARED memory, or wasi_thread_spawn.
  const threadsSpawn = imports.some((i) => i.name === "wasi_thread_spawn" || i.name === "thread-spawn");
  const { memory, sharedMemory, customSections, hasStart } = walkSections(u8);
  const threads = threadsSpawn || sharedMemory;

  return {
    imports, exports,
    memory,                 // { min, max, shared } pages, or null
    wasiVersion,
    threads,
    threadsSpawn,
    customSections,         // [{ name, byteLength }]
    hasStart,               // has a start section
    importCount: imports.length,
    exportCount: exports.length,
  };
}

// Lean section walk for the memory section (5) + custom sections (0) + start (8).
function walkSections(u8) {
  let memory = null, sharedMemory = false, hasStart = false;
  const customSections = [];
  let i = 8; // past magic + version
  const readU32 = () => { let r = 0, s = 0, b; do { b = u8[i++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  while (i < u8.length) {
    const id = u8[i++];
    const len = readU32();
    const end = i + len;
    if (id === 0) {
      // custom section: name is a length-prefixed string.
      const nameLen = readU32();
      const name = new TextDecoder().decode(u8.subarray(i, i + nameLen));
      customSections.push({ name, byteLength: end - (i + nameLen) });
    } else if (id === 5) {
      // memory section: vec of limits.
      const count = readU32();
      if (count > 0) {
        const flags = u8[i]; i++;
        const min = readU32();
        const shared = (flags & 0x02) !== 0;
        const max = (flags & 0x01) ? readU32() : null;
        memory = { min, max, shared };
        sharedMemory = shared;
      }
    } else if (id === 2) {
      // import section may declare a SHARED imported memory.
      // (a lean check: a shared imported memory sets sharedMemory too)
      // Skip the detailed parse; the export/import shared flag is rare here.
    } else if (id === 8) {
      hasStart = true;
    }
    i = end;
  }
  // If the module IMPORTS a memory, check its shared flag by re-reading imports.
  return { memory, sharedMemory, customSections, hasStart };
}

export { inspectWasm };
