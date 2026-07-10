// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/applets/native.mjs — kernel-native applet substitutes (UL-SPEC/applets
// S1 class 2): JS implementations of the hot I/O-and-scan applets, run in the
// Kernel with DIRECT (function-call) VFS access — no Worker, no bus hops, no
// emulation. They reproduce BusyBox-observable behavior at JS speed (S3), and
// are only routed to when they pass the difftest gate against the BusyBox
// oracle (S2); any unsupported flag falls back per-invocation to the VM applet.
//
// These are pure functions over an fs facade + argv; the runner (applets.mjs)
// wires them to Kernel pipes, process registration, and cooperative slicing.

/**
 * Each applet: (argv, io) => exitCode. `io` provides:
 *   read(path) → string | throws            (VFS read via the Kernel)
 *   list(path) → string[]                    (readdir)
 *   stat(path) → { size, isDir, mtime }
 *   write(str)  → void                       (stdout)
 *   err(str)    → void                       (stderr)
 *   stdin()     → string                     (collected stdin, or "")
 *   cwd, env
 * A declared flag surface lives on each applet's `.flags`; the runner checks
 * argv against it and bails to the VM on anything undeclared (S2).
 */

const dec = new TextDecoder();

function cat(argv, io) {
  const files = argv.slice(1).filter((a) => !a.startsWith("-"));
  const opts = flags(argv);
  let n = 0, code = 0;
  const emit = (text) => {
    if (!opts.n && !opts.b) { io.write(text); return; }
    for (const line of splitKeepNl(text)) { n++; io.write(String(n).padStart(6) + "\t" + line); }
  };
  if (files.length === 0) { emit(io.stdin()); return 0; }
  for (const f of files) {
    if (f === "-") { emit(io.stdin()); continue; }
    try { emit(io.read(resolve(io, f))); }
    catch { io.err(`cat: can't open '${f}': No such file or directory\n`); code = 1; }
  }
  return code;
}
cat.flags = new Set(["-n", "-b"]); // declared surface; -A/-e/-v bail to VM

function echo(argv, io) {
  let args = argv.slice(1), nl = true, interpret = false;
  while (args[0] === "-n" || args[0] === "-e" || args[0] === "-E") {
    if (args[0] === "-n") nl = false; else if (args[0] === "-e") interpret = true; else interpret = false;
    args = args.slice(1);
  }
  let s = args.join(" ");
  if (interpret) s = s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
  io.write(s + (nl ? "\n" : ""));
  return 0;
}
echo.flags = new Set(["-n", "-e", "-E"]);

function wc(argv, io) {
  const opts = flags(argv);
  const files = argv.slice(1).filter((a) => !a.startsWith("-"));
  const only = opts.l || opts.w || opts.c || opts.m;
  const one = (text, name) => {
    const lines = (text.match(/\n/g) || []).length;
    const words = (text.trim().match(/\S+/g) || []).length;
    const bytes = new TextEncoder().encode(text).length;
    const chars = [...text].length;
    const cols = [];
    if (opts.l) cols.push(lines);
    if (opts.w) cols.push(words);
    if (opts.c) cols.push(bytes);
    if (opts.m) cols.push(chars);
    if (!only) cols.push(lines, words, bytes);
    // BusyBox: a single selected column has no padding; multiple columns are
    // each right-justified in a width-9 field, space-separated (byte-verified).
    const body = (only && cols.length === 1)
      ? String(cols[0])
      : cols.map((c) => String(c).padStart(9)).join(" ");
    io.write(body + (name ? " " + name : "") + "\n");
  };
  if (files.length === 0) { one(io.stdin(), ""); return 0; }
  let code = 0;
  for (const f of files) { try { one(io.read(resolve(io, f)), f); } catch { io.err(`wc: ${f}: No such file or directory\n`); code = 1; } }
  return code;
}
wc.flags = new Set(["-l", "-w", "-c", "-m"]);

function head(argv, io) {
  const opts = flags(argv);
  const num = numArg(argv, "-n") ?? 10;
  const files = argv.slice(1).filter((a) => !a.startsWith("-") && !/^\d+$/.test(a));
  const emit = (text) => io.write(splitKeepNl(text).slice(0, num).join(""));
  if (files.length === 0) { emit(io.stdin()); return 0; }
  let code = 0;
  for (const f of files) { try { emit(io.read(resolve(io, f))); } catch { io.err(`head: ${f}: No such file or directory\n`); code = 1; } }
  return code;
}
head.flags = new Set(["-n"]);

function tail(argv, io) {
  const num = numArg(argv, "-n") ?? 10;
  const files = argv.slice(1).filter((a) => !a.startsWith("-") && !/^\d+$/.test(a));
  const emit = (text) => { const lines = splitKeepNl(text); io.write(lines.slice(Math.max(0, lines.length - num)).join("")); };
  if (files.length === 0) { emit(io.stdin()); return 0; }
  let code = 0;
  for (const f of files) { try { emit(io.read(resolve(io, f))); } catch { io.err(`tail: ${f}: No such file or directory\n`); code = 1; } }
  return code;
}
tail.flags = new Set(["-n"]); // -f (follow) bails to VM

function ls(argv, io) {
  const opts = flags(argv);
  const paths = argv.slice(1).filter((a) => !a.startsWith("-"));
  const targets = paths.length ? paths : [io.cwd];
  let code = 0;
  for (const p of targets) {
    let names;
    try { const st = io.stat(resolve(io, p)); names = st.isDir ? io.list(resolve(io, p)) : [p]; }
    catch { io.err(`ls: ${p}: No such file or directory\n`); code = 1; continue; }
    if (!opts.a) names = names.filter((n) => !n.startsWith("."));
    names.sort();
    // stdout here is a pipe (non-tty), so BusyBox ls prints one name per line.
    io.write(names.map((n) => n + "\n").join(""));
  }
  return code;
}
ls.flags = new Set(["-a", "-1", "-l"]); // -l formatting is minimal; difftest-gated

function truebin() { return 0; }
truebin.flags = new Set();
function falsebin() { return 1; }
falsebin.flags = new Set();

// --- helpers ---
function flags(argv) {
  const o = {};
  for (const a of argv.slice(1)) {
    if (a === "-1") { o.one = true; continue; }
    if (/^-[A-Za-z]+$/.test(a)) for (const ch of a.slice(1)) o[ch] = true;
  }
  return o;
}
function numArg(argv, flag) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] != null) return parseInt(argv[i + 1], 10);
  for (const a of argv) { const m = new RegExp(`^${flag}(\\d+)$`).exec(a); if (m) return parseInt(m[1], 10); }
  const bare = argv.slice(1).find((a) => /^\d+$/.test(a));
  return bare != null ? parseInt(bare, 10) : null;
}
function splitKeepNl(text) {
  const out = []; let i = 0;
  while (i < text.length) { const nl = text.indexOf("\n", i); if (nl < 0) { out.push(text.slice(i)); break; } out.push(text.slice(i, nl + 1)); i = nl + 1; }
  return out;
}
function resolve(io, p) { return p.startsWith("/") ? p : join(io.cwd, p); }
function join(a, b) { return (a.endsWith("/") ? a : a + "/") + b; }

const NATIVE_APPLETS = { cat, echo, wc, head, tail, ls, true: truebin, false: falsebin };

/** Would every flag in argv be handled by this applet? (S2 fallback gate.) */
function flagsSupported(name, argv) {
  const applet = NATIVE_APPLETS[name];
  if (!applet) return false;
  for (const a of argv.slice(1)) {
    if (!a.startsWith("-") || a === "-" || /^-?\d+$/.test(a)) continue;
    // split combined short flags: -la → -l -a
    const parts = /^-[A-Za-z]+$/.test(a) ? [...a.slice(1)].map((c) => "-" + c) : [a];
    for (const f of parts) if (!applet.flags.has(f) && f !== "-n") return false;
  }
  return true;
}

export { NATIVE_APPLETS, flagsSupported };
