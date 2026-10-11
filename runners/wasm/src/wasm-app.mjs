// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// runners/wasm/src/wasm-app.mjs — register core `apps/` tools (ripgrep,
// coreutils, …) compiled to wasm32-wasip1 as named commands on the wasm tier.
//
// Unlike the generic wasm-delegate (which routes a `foo.wasm` PATH entry), a
// core app is a NAMED command (`rg`) invoked with a working directory, and it
// must see the filesystem exactly like a normal Unix process: relative paths
// against its cwd AND absolute paths (/work/a.jpg) against the VFS root. So it
// gets the root preopen(s) derived from its capabilities (caps.fs.scopes →
// "/" for an unscoped process; still structurally + Kernel-scope limited) PLUS
// its cwd preopened as "." (see the shim's rootFallback note), and PWD=cwd in
// its environment (Go's wasip1 runtime resolves relative paths against $PWD).
// One "wasm-app" tier delegate serves a registry of name → module bytes; each
// registered name is pinned to that tier so `proc.spawn(["rg", …])` — and a
// guest shell's execve — routes here.

import { runWasm, scopesToPreopens } from "./wasm-runtime.mjs";

const TIER = "wasm-app";
/** Default wall-clock limit for one app run — generous: batch image/PDF jobs. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Preopens for a wasm-app process: the caps-derived roots + the cwd as ".". */
function appPreopens(kernel, caps, cwd) {
  const procCaps = caps ? kernel.caps.normalizeCaps(caps) : kernel.profiles.trustedDev();
  const roots = scopesToPreopens(procCaps);
  const dir = normCwd(cwd);
  const hasRoot = roots.some((p) => p.guestPath === "/");
  if (!hasRoot) {
    // Scoped process: no root to fall back to — expose cwd as "." when it lies
    // inside a scope (paths stay structurally confined to the scopes).
    const inside = roots.some((p) => dir === p.hostPath.replace(/\/$/, "") || dir.startsWith(p.hostPath.replace(/\/$/, "") + "/"));
    return inside && dir !== "/" ? [...roots, { guestPath: ".", hostPath: dir, readonly: roots[0]?.readonly ?? false }] : roots;
  }
  if (dir === "/") return roots;
  const rootRo = roots.find((p) => p.guestPath === "/").readonly;
  return [...roots, { guestPath: ".", hostPath: dir, readonly: rootRo, rootFallback: true }];
}

function normCwd(cwd) {
  const out = [];
  for (const seg of String(cwd || "/").split("/")) { if (!seg || seg === ".") continue; if (seg === "..") out.pop(); else out.push(seg); }
  return "/" + out.join("/");
}

/**
 * @param {import("../../../kernel/kernel.mjs").Kernel} kernel
 * @returns {{ register: (name: string, wasmBytes: Uint8Array) => () => void, apps: Map<string, Uint8Array> }}
 */
function createWasmAppRunner(kernel) {
  /** @type {Map<string, Uint8Array>} command name → wasm module bytes */
  const apps = new Map();

  // req: { parent, argv, cwd, env, caps, wait, timeoutMs?, stdin? (bytes|string,
  // wait mode), onStdout?/onStderr? (Uint8Array chunks, wait mode) }.
  // wait → { exitCode, stdout, stderr, stdoutBytes, stderrBytes };
  // async → { pid, stdin, stdout, stderr } Kernel pipe ids (the caller writes /
  // closes stdin, drains stdout/stderr; exit via kernel.proc.waitpid(pid)).
  kernel.router.registerDelegate(TIER, async (req) => {
    const { parent, argv, wait } = req;
    const cwd = normCwd(req.cwd);
    const caps = req.caps;
    const env = { ...(req.env ?? {}) };
    env.PWD = cwd; // the spawn cwd is authoritative (Go resolves relative paths against $PWD)
    const name = basename(argv[0] ?? "");
    const wasmBytes = apps.get(name);
    if (!wasmBytes) {
      const msg = `${name}: not found\n`;
      return { exitCode: 127, stdout: "", stderr: msg, stdoutBytes: new Uint8Array(0), stderrBytes: new TextEncoder().encode(msg) };
    }
    const preopens = appPreopens(kernel, caps, cwd);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (wait) {
      const r = await runWasm(kernel, {
        wasmBytes, argv, cwd, env, caps, preopens, ppid: parent?.pid ?? 1, timeoutMs,
        stdinBytes: req.stdin ?? null, onStdout: req.onStdout, onStderr: req.onStderr,
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, stdoutBytes: r.stdoutBytes, stderrBytes: r.stderrBytes, error: r.error };
    }
    // Async spawn: the parent drains the returned pipes (child_process.spawn,
    // or a guest shell's execve bridge).
    const stdin = kernel.pipes.create(), stdout = kernel.pipes.create(), stderr = kernel.pipes.create();
    const child = kernel.registerProcess({ kind: "wasm", argv, cwd, env, caps, ppid: parent?.pid ?? 1, stdio: [stdin.id, stdout.id, stderr.id] });
    runWasm(kernel, { wasmBytes, argv, cwd, env, caps, preopens, ppid: parent?.pid ?? 1, _reuseProc: child, _stdout: stdout, _stderr: stderr, _stdin: stdin, timeoutMs })
      .then((r) => {
        if (r.error && r.error !== "timeout") { try { stderr.write(new TextEncoder().encode(`${name}: ${String(r.error).split("\n")[0]}\n`)); } catch {} }
        stdout.closeWrite(); stderr.closeWrite(); kernel.proc.exit(child.pid, r.exitCode ?? 0);
      })
      .catch(() => { stdout.closeWrite(); stderr.closeWrite(); kernel.proc.exit(child.pid, 1); });
    return { pid: child.pid, stdin: stdin.id, stdout: stdout.id, stderr: stderr.id };
  });

  return {
    apps,
    /**
     * Register a core app: pin its name → the wasm-app tier + store its bytes.
     * A guest shell only exec()s what it finds on PATH, so when nothing named
     * `name` is installed there yet, a small executable placeholder is created
     * at /usr/local/bin/<name> (removed again on unregister). The exec itself
     * never reads it — the routing pin sends it to this tier.
     */
    register(name, wasmBytes) {
      apps.set(name, wasmBytes);
      kernel.router.pin(name, TIER);
      const stub = ensurePathStub(kernel, name);
      return () => {
        apps.delete(name);
        kernel.router.pin(name, null);
        if (stub) { try { kernel.vfs.unlink(stub, 0); } catch { /* already gone */ } }
      };
    },
  };
}

const PATH_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"];
const STUB = new TextEncoder().encode("#!/bin/sh\n# wasm-app placeholder: exec is routed to the wasm-app tier\nexit 127\n");

/** Create /usr/local/bin/<name> when `name` is not on PATH yet; returns its path or null. */
function ensurePathStub(kernel, name) {
  if (!name || name.includes("/")) return null;
  const exists = (p) => { try { kernel.vfs.stat(p, false); return true; } catch { return false; } };
  if (PATH_DIRS.some((d) => exists(`${d}/${name}`))) return null;
  try {
    for (const d of ["/usr", "/usr/local", "/usr/local/bin"]) if (!exists(d)) kernel.vfs.mkdir(d, 0o755);
    const path = `/usr/local/bin/${name}`;
    kernel.vfs.rootMem.createFile(path, STUB, 0o755);
    return path;
  } catch { return null; }
}

function basename(p) { return String(p).slice(String(p).lastIndexOf("/") + 1); }

export { createWasmAppRunner, appPreopens, TIER as WASM_APP_TIER, DEFAULT_TIMEOUT_MS as WASM_APP_DEFAULT_TIMEOUT_MS };
