// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/host/shell-delegate.mjs — a lean POSIX-ish `sh` registered as the
// "vm" spawn delegate, enough to run npm lifecycle scripts and demonstrate the
// cross-tier chain (spec §12.3): nodert `execSync("sh -c '…'")` routes here,
// the script runs, and any `node …` it invokes routes BACK to the nodert tier
// through the same router — stdio bridged through Kernel pipes end-to-end.
//
// DIVERGENCE (DIV-SH-LEAN): this is NOT BusyBox. It handles the lifecycle-
// script surface (sequential `;`/`&&`/`||`, `VAR=val` prefixes, a few builtins,
// and command invocation via proc.spawn). The REAL BusyBox `sh` is the "vm"
// delegate in the terminal/SDK where the live NanoVM is registered; this lean
// shell is the headless/portable stand-in with identical cross-tier routing.

const BUILTINS = new Set(["echo", "true", "false", "cd", "pwd", "export", ":", "exit"]);

function registerShellDelegate(kernel) {
  return kernel.router.registerDelegate("vm", async (req) => {
    const { argv, cwd, env, caps, parent, wait } = req;
    const cmd = basename(argv[0]);
    // `sh -c "<script>"` (or busybox sh -c) — the lifecycle-script entry.
    let script;
    if ((cmd === "sh" || cmd === "bash" || cmd === "busybox") && argv.includes("-c")) {
      script = argv[argv.indexOf("-c") + 1] ?? "";
    } else if (cmd === "sh" || cmd === "bash") {
      script = ""; // interactive sh not supported headless
    } else {
      // A bare command routed to the vm tier (e.g. `busybox echo`): run it directly.
      script = argv.map(shQuote).join(" ");
    }
    const shellEnv = { ...(env ?? {}) };
    const result = await runScript(kernel, script, { cwd: cwd ?? "/", env: shellEnv, caps, parentPid: parent?.pid ?? 1, timeoutMs: req.timeoutMs });
    if (wait) return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    // Async: the lean sh runs to completion synchronously-ish; return a done result.
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr, pid: 0 };
  });
}

async function runScript(kernel, script, ctx) {
  let stdout = "", stderr = "", code = 0;
  for (const stmt of splitStatements(script)) {
    if (stmt.op === "&&" && code !== 0) continue;
    if (stmt.op === "||" && code === 0) continue;
    const r = await runCommand(kernel, stmt.cmd, ctx);
    stdout += r.stdout; stderr += r.stderr; code = r.code;
  }
  return { stdout, stderr, code };
}

async function runCommand(kernel, cmdline, ctx) {
  const tokens = tokenize(cmdline);
  if (tokens.length === 0) return { stdout: "", stderr: "", code: 0 };
  // Leading VAR=val assignments.
  const env = { ...ctx.env };
  while (tokens.length && /^[A-Za-z_][\w]*=/.test(tokens[0])) {
    const t = tokens.shift(); const eq = t.indexOf("="); env[t.slice(0, eq)] = expand(t.slice(eq + 1), env);
  }
  if (tokens.length === 0) { Object.assign(ctx.env, env); return { stdout: "", stderr: "", code: 0 }; }
  const argv = tokens.map((t) => expand(t, env));
  const cmd = basename(argv[0]);

  if (BUILTINS.has(cmd)) return runBuiltin(cmd, argv, ctx, env);

  // Route + delegate — `node …` goes to the nodert tier, another `sh -c`
  // recurses here. wait:true captures output (the sync-parent path, §12.2).
  const route = kernel.router.route(argv);
  const delegate = kernel.router.delegateFor(route.tier);
  if (!delegate) return { stdout: "", stderr: `${cmd}: command not found\n`, code: 127 };
  const parent = kernel.proc.get(ctx.parentPid) ?? kernel.proc.get(1);
  try {
    const res = await delegate({ parent, argv, cwd: ctx.cwd, env, caps: ctx.caps, wait: true, timeoutMs: ctx.timeoutMs });
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.exitCode ?? 0 };
  } catch (e) {
    return { stdout: "", stderr: `${cmd}: ${e.message}\n`, code: 127 };
  }
}

function runBuiltin(cmd, argv, ctx, env) {
  switch (cmd) {
    case "echo": {
      let args = argv.slice(1), nl = true;
      if (args[0] === "-n") { nl = false; args = args.slice(1); }
      return { stdout: args.join(" ") + (nl ? "\n" : ""), stderr: "", code: 0 };
    }
    case "true": case ":": return { stdout: "", stderr: "", code: 0 };
    case "false": return { stdout: "", stderr: "", code: 1 };
    case "pwd": return { stdout: ctx.cwd + "\n", stderr: "", code: 0 };
    case "cd": ctx.cwd = argv[1] ? join(ctx.cwd, argv[1]) : "/"; return { stdout: "", stderr: "", code: 0 };
    case "export": for (const a of argv.slice(1)) { const eq = a.indexOf("="); if (eq > 0) ctx.env[a.slice(0, eq)] = a.slice(eq + 1); } return { stdout: "", stderr: "", code: 0 };
    case "exit": return { stdout: "", stderr: "", code: parseInt(argv[1] ?? "0", 10) || 0 };
    default: return { stdout: "", stderr: "", code: 0 };
  }
}

// --- lean parsing ---
function splitStatements(script) {
  // Split on ; && || and newlines, keeping the operator that PRECEDED each part.
  const out = []; let buf = "", op = ";";
  for (let i = 0; i < script.length; i++) {
    const c = script[i], c2 = script[i + 1];
    if (c === "&" && c2 === "&") { push(); op = "&&"; i++; }
    else if (c === "|" && c2 === "|") { push(); op = "||"; i++; }
    else if (c === ";" || c === "\n") { push(); op = ";"; }
    else buf += c;
  }
  push();
  function push() { if (buf.trim()) out.push({ op, cmd: buf.trim() }); buf = ""; }
  return out;
}
function tokenize(s) {
  const out = []; let cur = "", q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "\\") { cur += s[++i] ?? ""; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
function expand(s, env) {
  return s.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_, a, b) => env[a ?? b] ?? "");
}
function shQuote(s) { return /[\s"']/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s; }
function basename(p) { return String(p).slice(String(p).lastIndexOf("/") + 1); }
function join(a, b) { if (b.startsWith("/")) return b; return (a.endsWith("/") ? a : a + "/") + b; }

export { registerShellDelegate, splitStatements, tokenize, expand, basename, BUILTINS, runBuiltin };
