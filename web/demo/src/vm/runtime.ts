// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// NanoVM runtime wrapper for the demo app.
// Manages a singleton NanoVM instance and provides high-level methods.

// @ts-ignore — nanovm.mjs is a JS module, no types
import { NanoVM } from "@container/nanovm.mjs";
import * as opfs from "./opfs";

let vmInstance: any = null;
let vmReady = false;
let initPromise: Promise<void> | null = null;
let nodeSnapshot: any = null;
let snapshotPromise: Promise<any> | null = null;

export async function ensureVM(): Promise<any> {
  if (vmInstance && vmReady) return vmInstance;
  if (initPromise) {
    await initPromise;
    return vmInstance;
  }

  initPromise = (async () => {
    // Fetch WASM chunks and concatenate (split to stay under GitHub's 100MB limit)
    const base = import.meta.env.BASE_URL;
    const chunks = await Promise.all(
      ["nano.wasm.aa", "nano.wasm.ab"].map(async (name) => {
        const res = await fetch(base + name);
        if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      })
    );
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const wasmBytes = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      wasmBytes.set(chunk, offset);
      offset += chunk.length;
    }

    vmInstance = await NanoVM.create({
      ramMB: 1800,
      wasm: wasmBytes.buffer,
    });

    // Load bundled devenv tarball if available
    const exports = vmInstance._exports || vmInstance.exports;
    if (exports?.vm_bundled_devenv_ptr && exports?.vm_bundled_devenv_size) {
      const devenvPtr = exports.vm_bundled_devenv_ptr();
      const devenvSize = exports.vm_bundled_devenv_size();
      if (devenvPtr > 0 && devenvSize > 0) {
        console.log(`[NanoVM] Loading bundled devenv (${(devenvSize / 1024 / 1024).toFixed(1)} MB compressed)...`);
        const wasmMemory = vmInstance._memory || vmInstance.memory;
        if (wasmMemory) {
          const tarGz = new Uint8Array(wasmMemory.buffer, devenvPtr, devenvSize);
          const tarGzCopy = new Uint8Array(tarGz);
          await vmInstance.loadTarGz(tarGzCopy);
          console.log(`[NanoVM] Devenv loaded into VFS`);
        }
      }
    }

    vmReady = true;
  })();

  await initPromise;
  return vmInstance;
}

export function getVM(): any {
  return vmInstance;
}

export async function runBusybox(
  command: string,
  opts: { onStdout?: (chunk: string) => void; stdin?: string } = {}
): Promise<{ exitCode: number; stdout: string }> {
  const vm = await ensureVM();
  return vm.run(command, {
    onStdout: opts.onStdout,
    stdin: opts.stdin,
    maxSteps: 20_000_000,
  });
}

/** Parse node args into either inline code or a file path. */
function parseNodeArgs(args: string[]): { kind: "code"; code: string } | { kind: "file"; path: string } | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e" && i + 1 < args.length) {
      return { kind: "code", code: args[i + 1] };
    }
    if (args[i] === "-p" && i + 1 < args.length) {
      return { kind: "code", code: `process.stdout.write(String(${args[i + 1]}))` };
    }
    // First non-flag arg is a file path
    if (!args[i].startsWith("-")) {
      return { kind: "file", path: args[i] };
    }
  }
  return null;
}

async function ensureNodeSnapshot(): Promise<any> {
  const vm = await ensureVM();
  if (nodeSnapshot) return nodeSnapshot;
  if (snapshotPromise) return snapshotPromise;

  snapshotPromise = (async () => {
    const t0 = performance.now();
    console.log("[NanoVM] Creating Node.js snapshot (cold start)...");
    nodeSnapshot = await vm.nodeSnapshot();
    console.log(`[NanoVM] Snapshot created in ${(performance.now() - t0).toFixed(0)}ms`);
    return nodeSnapshot;
  })();

  return snapshotPromise;
}

export async function runNode(
  args: string[],
  opts: { onStdout?: (chunk: string) => void; stdin?: string; maxSteps?: number } = {}
): Promise<{ exitCode: number; stdout: string }> {
  const vm = await ensureVM();
  const maxSteps = opts.maxSteps || 2_000_000_000;

  const parsed = parseNodeArgs(args);

  // If we can't map args to a snapshot script, fall back to cold start
  if (parsed === null) {
    return vm.node(...args, {
      onStdout: opts.onStdout,
      stdin: opts.stdin,
      maxSteps,
    });
  }

  let script: string;
  if (parsed.kind === "file") {
    // Use require() so the file gets proper module context
    // (require, __filename, __dirname, module, exports)
    script = `process.mainModule.require('${parsed.path}')`;
  } else {
    script = parsed.code;
  }

  // Sync OPFS user files into MemFS via extraFiles
  const extraFiles = await opfs.walkFiles("/examples");

  const snap = await ensureNodeSnapshot();
  const t0 = performance.now();
  const result = await vm.restoreAndRun(snap, script, {
    onStdout: opts.onStdout,
    maxSteps,
    extraFiles,
  });
  console.log(`[NanoVM] Node.js warm start completed in ${(performance.now() - t0).toFixed(0)}ms`);
  return result;
}

export async function addFile(path: string, content: string | Uint8Array) {
  if (path.startsWith("/examples/")) {
    const text = content instanceof Uint8Array
      ? new TextDecoder().decode(content)
      : content;
    await opfs.writeFile(path, text);
    return;
  }
  const vm = await ensureVM();
  vm.addFile(path, content);
}

export async function readFile(path: string): Promise<string | null> {
  if (path.startsWith("/examples/")) {
    return opfs.readFile(path);
  }
  const vm = await ensureVM();
  return vm.readFileString(path);
}

export async function listDir(path: string) {
  if (path === "/examples" || path.startsWith("/examples/")) {
    const entries = await opfs.listDir(path);
    if (entries) {
      return entries.map((e) => ({ name: e.name, type: e.type, size: 0 }));
    }
    return null;
  }
  const vm = await ensureVM();
  return vm.listDir(path);
}

/** Cancel any in-progress run loop without destroying the VM or snapshot. */
export function cancelRun() {
  if (vmInstance) {
    vmInstance.cancelRun();
  }
}

export async function resetVFS() {
  // Destroy and re-create to get a fresh FS
  nodeSnapshot = null;
  snapshotPromise = null;
  if (vmInstance) {
    vmInstance.cancelRun();
    vmInstance.destroy();
    vmInstance = null;
    vmReady = false;
    initPromise = null;
  }
  await ensureVM();
}
