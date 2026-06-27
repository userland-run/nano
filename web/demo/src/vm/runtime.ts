// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// NanoVM runtime wrapper for the demo app.
// Manages a singleton NanoVM instance and provides high-level methods.

// @ts-ignore — nanovm.mjs is a JS module, no types
import { NanoVM } from "@container/nanovm.mjs";
// @ts-ignore — @sdk resolves to the built SDK bundle (vite alias)
import { Catalog } from "@sdk";
import * as opfs from "./opfs";

// Apps installed from the catalog into the guest VFS at boot. node is the JS
// runtime; typescript/eslint run on it. prettier is pending the full-ICU node.
const CATALOG_APPS = ["node@25.4.0", "typescript@5.9.3", "eslint@10.0.0"];

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
    // The slim nano.wasm (~2.3 MB) — node/devenv are no longer embedded.
    const base = import.meta.env.BASE_URL;
    const res = await fetch(base + "nano.wasm");
    if (!res.ok) throw new Error(`Failed to fetch nano.wasm: ${res.status}`);
    const wasmBytes = new Uint8Array(await res.arrayBuffer());

    vmInstance = await NanoVM.create({
      ramMB: 1800,
      wasm: wasmBytes.buffer,
    });

    // Install the toolchain from the catalog into the guest VFS. Each manifest is
    // Ed25519-verified and chunks are cached in OPFS, so repeat boots are fast.
    // Installs are non-fatal — a CDN hiccup degrades a tool, it can't brick boot.
    const catalog = new Catalog();
    const target = { writeFile: (p: string, bytes: Uint8Array) => vmInstance.addFile(p, bytes) };
    for (const ref of CATALOG_APPS) {
      try {
        const m = await catalog.install(target, ref);
        console.log(`[catalog] installed ${m.name}@${m.version}`);
      } catch (e) {
        console.warn(`[catalog] could not install ${ref}:`, e);
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
