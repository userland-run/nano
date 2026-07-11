// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/engine.mjs — the front-door ENGINE SELECTOR (spec §14).
//
// The Kernel's SpawnRouter (kernel/proc/router.mjs) routes *child spawns* to a
// tier. This is the complementary top-level policy for the `node()` ENTRYPOINT
// that an embedder calls directly (SDK `nano.node(argv, { engine })`): pick
// which engine runs a Node program, with three modes —
//
//   "vm"     — always the RISC-V emulator (fidelity oracle, native addons, the
//              things nodert can't do). Requires an injected `vmRun`.
//   "host" — always the host-engine tier (JIT speed). Errors surface as-is.
//   "auto"   — try nodert; on a documented ERR_NODE_HOST_UNSUPPORTED (an
//              unavailable Kernel Service like rspack, or a routing pin), fall
//              back to the VM. This is the §14 default once M2 exit is met.
//
// Routing pins (S4) force specific programs to a tier regardless of the mode —
// e.g. { jest: "vm", "node-gyp": "vm" } keeps contextify/addon-heavy tools on
// the emulator. Pins key on the *program* (argv0 basename) or the *entry*
// script/bin basename, so `node node_modules/.bin/jest` pins on "jest".
//
// `vmRun` is INJECTED (not imported) so this stays headless-testable with a
// stub and so the SDK can wire the real emulated-node path without this module
// depending on NanoVM. The nodert path uses `runNode` directly.

import { runNode } from "./runtime.mjs";

const UNSUPPORTED = "ERR_NODE_HOST_UNSUPPORTED";

/**
 * @param {import("../../../../kernel/kernel.mjs").Kernel} kernel
 * @param {{
 *   engine?: "vm"|"host"|"auto",
 *   pins?: Record<string, "vm"|"host">,
 *   vmRun?: (argv: string[], opts: object) => Promise<{ exitCode: number, stdout: string, stderr: string, signal?: string|null }>,
 *   timeoutMs?: number,
 * }} [config]
 */
function createNodeEngine(kernel, config = {}) {
  const defaultEngine = config.engine ?? "auto";
  const pins = new Map(Object.entries(config.pins ?? {}));
  const vmRun = config.vmRun ?? null;
  const defaultTimeout = config.timeoutMs;

  /** The program/entry names a call touches, for pin lookup (argv0 + entry). */
  function keysForArgv(argv) {
    const keys = [];
    const a0 = basename(argv?.[0] ?? "");
    if (a0) keys.push(a0);
    if (a0 === "node" || a0 === "nodejs") {
      const e = entryOf(argv);
      if (e) keys.push(basename(e));
    }
    return keys;
  }

  /**
   * Resolve the engine for a specific call WITHOUT running it (introspection;
   * also drives the actual dispatch). `opts.engine` overrides the default;
   * pins override everything (they are policy, not preference).
   */
  function which(argv, opts = {}) {
    for (const k of keysForArgv(argv)) {
      const pinned = pins.get(k);
      if (pinned) return { engine: pinned, reason: "pin", key: k };
    }
    const requested = opts.engine ?? defaultEngine;
    return { engine: requested, reason: "default" };
  }

  /**
   * Run a Node program. `argv` is the full argv INCLUDING "node" (e.g.
   * ["node","-e",code] or ["node","app.js","--flag"]) so pins can inspect it.
   * @returns {Promise<{ exitCode, stdout, stderr, signal?, engine, fellBack? }>}
   */
  async function node(argv, opts = {}) {
    const decision = which(argv, opts);
    const timeoutMs = opts.timeoutMs ?? defaultTimeout;

    if (decision.engine === "vm") {
      return { ...(await runOnVm(argv, opts, timeoutMs)), engine: "vm" };
    }

    // nodert (explicit) or auto: run on the host engine first.
    const res = await runOnNodert(argv, opts, timeoutMs);

    if (decision.engine === "host") {
      // No fallback: surface an unsupported failure honestly.
      return { ...res, engine: "host" };
    }

    // auto: fall back to the VM only on a documented unsupported signal, and
    // only if a VM runner is actually wired.
    if (isUnsupported(res) && vmRun) {
      const vmRes = await runOnVm(argv, opts, timeoutMs);
      return { ...vmRes, engine: "vm", fellBack: true };
    }
    return { ...res, engine: "host" };
  }

  async function runOnNodert(argv, opts, timeoutMs) {
    const { source, entryPath } = classifyEntry(argv, opts);
    try {
      const r = await runNode(kernel, {
        argv,
        source,
        entryPath,
        env: opts.env ?? {},
        cwd: opts.cwd ?? "/",
        caps: opts.caps,
        inputType: opts.inputType,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
        timeoutMs,
      });
      return r;
    } catch (e) {
      // A thrown KernelError/Error carrying the unsupported marker becomes a
      // normalized result so `auto` can fall back uniformly.
      if (errName(e) === UNSUPPORTED) {
        return { exitCode: 1, stdout: "", stderr: String(e?.message ?? e), signal: null, error: UNSUPPORTED };
      }
      throw e;
    }
  }

  async function runOnVm(argv, opts, timeoutMs) {
    if (!vmRun) {
      throw Object.assign(new Error("engine 'vm' requested but no vmRun was wired into createNodeEngine"), { code: "ERR_NO_VM_ENGINE" });
    }
    return vmRun(argv, { env: opts.env ?? {}, cwd: opts.cwd ?? "/", caps: opts.caps, onStdout: opts.onStdout, onStderr: opts.onStderr, timeoutMs });
  }

  /** Pin (or unpin with null) a program to a tier at runtime — S4. */
  function pin(command, engine) {
    if (engine) pins.set(command, engine);
    else pins.delete(command);
  }
  function routing() { return Object.fromEntries(pins); }

  return { engine: defaultEngine, node, which, pin, routing, get hasVm() { return !!vmRun; } };
}

/** Detect the "run this on the VM instead" signal in a nodert result. */
function isUnsupported(res) {
  if (!res) return false;
  if (errName(res.error) === UNSUPPORTED) return true;
  // A guest that printed the marker to stderr and exited non-zero (a service
  // adapter surfacing ERR_NODE_HOST_UNSUPPORTED to the program) also triggers it.
  return res.exitCode !== 0 && typeof res.stderr === "string" && res.stderr.includes(UNSUPPORTED);
}

function errName(e) {
  if (!e) return null;
  if (typeof e === "string") return e.includes(UNSUPPORTED) ? UNSUPPORTED : null;
  return e.code === UNSUPPORTED || e.name === UNSUPPORTED ? UNSUPPORTED : null;
}

/** Split a node argv into { source, entryPath } for the nodert driver. */
function classifyEntry(argv, opts) {
  if (opts.source != null) return { source: opts.source, entryPath: opts.entryPath ?? null };
  if (opts.entryPath != null) return { source: null, entryPath: opts.entryPath };
  const i = argv.findIndex((a) => a === "-e" || a === "--eval");
  if (i >= 0) return { source: argv[i + 1] ?? "", entryPath: null };
  const entry = entryOf(argv);
  return { source: null, entryPath: entry };
}

/** First non-flag argument after "node" — the entry script/bin, or null. */
function entryOf(argv) {
  for (let i = 1; i < (argv?.length ?? 0); i++) {
    const a = argv[i];
    if (a === "-e" || a === "--eval" || a === "-p" || a === "--print") return null; // inline
    if (a === "-") return null;
    if (a.startsWith("-")) continue; // a flag (best-effort; unary flags only)
    return a;
  }
  return null;
}

function basename(p) { return String(p).slice(String(p).lastIndexOf("/") + 1); }

export { createNodeEngine };
