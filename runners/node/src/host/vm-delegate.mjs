// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/vm-delegate.mjs — register a LIVE NanoVM (real BusyBox) as
// the Kernel "vm" spawn delegate, running over the SHARED VFS (spec §12,
// UL-SPEC/applets §4). The delegate is a CROSS-TIER SHELL: it splits an
// `sh -c "<script>"` into statements and dispatches each to the right tier —
// pure-busybox commands/pipelines (echo, tr, sort, cat, grep, `busybox X`, …)
// run in the warm resident emulator (real BusyBox, no per-command VM boot,
// UL-SPEC/applets E1); a `node …` statement routes back to the nodert tier —
// so `node build.js` inside a lifecycle script runs at JIT speed. Both tiers
// share one VFS, so files cross freely. This delivers the full §12.3 chain
// with REAL BusyBox applets and real nodert node.
//
// (A single busybox PIPELINE `echo … | tr …` runs as one unit in the VM — pipes
// are the emulator's job; cross-tier splitting is per top-level statement.)

import { splitStatements, tokenize, expand, basename as shBasename, BUILTINS, runBuiltin } from "./shell-delegate.mjs";

/**
 * @param {import("../../../../kernel/kernel.mjs").Kernel} kernel
 * @param {any} vm  a NanoVM constructed with { kernel } so it shares the VFS
 * @param {{ maxSteps?: number }} [opts]
 * @returns {() => void} unregister
 */
function registerVmDelegate(kernel, vm, opts = {}) {
  let tmpSeq = 0;
  const maxSteps = opts.maxSteps ?? 200_000_000;

  // Run one busybox command/pipeline in the resident VM (real BusyBox). The
  // command is staged as a temp .sh so pipes/quoting survive run()'s split.
  async function runInVm(cmdline, cwd, env) {
    const path = `/tmp/.vmsh-${tmpSeq++}.sh`;
    ensureTmp(kernel);
    const envLines = Object.entries(env ?? {}).map(([k, v]) => `export ${k}=${shQuote(String(v))}`).join("\n");
    const prelude = (cwd && cwd !== "/" ? `cd ${shQuote(cwd)}\n` : "") + (envLines ? envLines + "\n" : "");
    kernel.vfs.rootMem.createFile(path, prelude + cmdline + "\n");
    let stdout = "";
    const r = await vm.run(`sh ${path}`, { onStdout: (s) => (stdout += s), maxSteps });
    try { kernel.vfs.rootMem.unlink(path, 0); } catch {}
    return { exitCode: r.exitCode ?? 0, stdout, stderr: "" };
  }

  return kernel.router.registerDelegate("vm", async (req) => {
    const { argv, cwd, env, caps, parent, wait } = req;
    const cmd = shBasename(argv[0]);

    let script;
    if ((cmd === "sh" || cmd === "bash" || cmd === "busybox") && argv.includes("-c")) {
      script = argv[argv.indexOf("-c") + 1] ?? "";
    } else {
      // A bare command routed to the vm tier — run it directly in busybox.
      return runInVm(argv.map(shQuote).join(" "), cwd, env);
    }

    // Cross-tier statement dispatch: node → nodert, everything else → real VM.
    const ctx = { cwd: cwd ?? "/", env: { ...(env ?? {}) }, caps, parentPid: parent?.pid ?? 1 };
    let stdout = "", stderr = "", code = 0;
    for (const stmt of splitStatements(script)) {
      if (stmt.op === "&&" && code !== 0) continue;
      if (stmt.op === "||" && code === 0) continue;
      const r = await runStatement(stmt.cmd, ctx);
      stdout += r.stdout; stderr += r.stderr; code = r.code;
    }
    return { exitCode: code, stdout, stderr };

    async function runStatement(cmdline, ctx) {
      // A single pipeline stays in busybox. If the WHOLE statement is a lone
      // `node …` (no pipe/redirect), route it to the nodert tier.
      const hasPipeOrRedirect = /[|<>]/.test(stripStrings(cmdline));
      const tokens = tokenize(cmdline);
      const env2 = { ...ctx.env };
      let ti = 0;
      while (ti < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[ti])) { const t = tokens[ti++]; const e = t.indexOf("="); env2[t.slice(0, e)] = expand(t.slice(e + 1), env2); }
      const argv0 = tokens[ti] ? expand(tokens[ti], env2) : "";
      const base = shBasename(argv0);

      if (!hasPipeOrRedirect && base === "node") {
        const nArgv = tokens.slice(ti).map((t) => expand(t, env2));
        const route = kernel.router.route(nArgv);
        const delegate = kernel.router.delegateFor(route.tier === "node" ? "node" : "node");
        if (delegate) {
          const res = await delegate({ parent: kernel.proc.get(ctx.parentPid) ?? kernel.proc.get(1), argv: nArgv, cwd: ctx.cwd, env: env2, caps: ctx.caps, wait: true, timeoutMs: req.timeoutMs });
          return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.exitCode ?? 0 };
        }
      }
      if (!hasPipeOrRedirect && BUILTINS.has(base)) {
        return mapBuiltin(runBuiltin(base, tokens.slice(ti).map((t) => expand(t, env2)), ctx, env2));
      }
      // Everything else → real BusyBox (applets, pipelines, redirects).
      return mapBuiltin(await runInVm(cmdline, ctx.cwd, env2));
    }
  });

  function mapBuiltin(r) { return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? r.exitCode ?? 0 }; }
}

function stripStrings(s) {
  let out = "", i = 0;
  while (i < s.length) { const c = s[i]; if (c === '"' || c === "'") { const q = c; i++; while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; } i++; out += " "; } else { out += c; i++; } }
  return out;
}

function ensureTmp(kernel) { try { kernel.vfs.rootMem.mkdir("/tmp", 0o777); } catch {} }
function basename(p) { return String(p).slice(String(p).lastIndexOf("/") + 1); }
function shQuote(s) { return /[\s"'$`\\]/.test(s) ? `'${String(s).replace(/'/g, "'\\''")}'` : s; }

/**
 * Convenience: create a NanoVM sharing `kernel`, install the busybox ELF into
 * the shared VFS, and register it as the vm delegate. Returns { vm, unregister }.
 * @param {import("../../../../kernel/kernel.mjs").Kernel} kernel
 * @param {{ NanoVM: any, wasm: Uint8Array, busybox?: Uint8Array, ramMB?: number }} cfg
 */
async function createVmDelegate(kernel, cfg) {
  const vm = await cfg.NanoVM.create({ wasm: cfg.wasm, ramMB: cfg.ramMB ?? 512, kernel });
  if (cfg.busybox && !vm._busyboxElf) {
    kernel.vfs.rootMem.createExecutable("/bin/busybox", cfg.busybox);
  }
  const unregister = registerVmDelegate(kernel, vm);
  return { vm, unregister };
}

export { registerVmDelegate, createVmDelegate };
