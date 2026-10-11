#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// WASI shim syscalls (runners/wasm/src/wasi-shim.mjs) driven directly against a
// REAL Kernel (its bus hub dispatch is the shim's `sync`), with a plain
// WebAssembly.Memory as guest memory: fd_pread/fd_pwrite, fd_filestat_set_size/
// _times, path_rename/_remove_directory/_readlink/_symlink/_link, fd_renumber,
// open flags (O_RDWR/O_EXCL/O_TRUNC/O_APPEND), the "/" + cwd-as-"." preopen
// resolution, typed fd_readdir, poll_oneoff, the full wasip1 import surface
// (Go GOOS=wasip1 / wasi-libc), plus runWasm stdin/env/binary-stdout behavior.

import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { OP } from "../../../kernel/bus/opcodes.mjs";
import { createWasiShim } from "../src/wasi-shim.mjs";
import { runWasm } from "../src/wasm-runtime.mjs";
import { appPreopens, createWasmAppRunner } from "../src/wasm-app.mjs";
import { stdinEchoModule, envDumpModule } from "./wasm-fixtures.mjs";

let passed = 0, failed = 0, current = "";
function assert(c, m) { if (!c) { console.error(`  FAIL: ${current} - ${m}`); failed++; return false; } return true; }
const show = (v) => (typeof v === "bigint" ? `${v}n` : JSON.stringify(v));
function assertEqual(a, b, m) { return a === b ? true : assert(false, `${m}: got ${show(a)} want ${show(b)}`); }
async function test(name, fn) { current = name; const before = failed; try { await fn(); if (failed === before) { passed++; console.log(`  PASS: ${name}`); } } catch (e) { failed++; console.error(`  FAIL: ${name} - threw ${e.stack ?? e.message}`); } }

// WASI constants used below.
const E = { SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOTDIR: 54, NOTEMPTY: 55, NOTCAPABLE: 76 };
const R_READ = 1n << 1n, R_WRITE = 1n << 6n;
const O_CREAT = 1, O_DIRECTORY = 2, O_EXCL = 4, O_TRUNC = 8;
const FDFLAG_APPEND = 1;

const enc = new TextEncoder(), dec = new TextDecoder();

/** A Kernel + a shim bound to it through the real bus dispatch. */
async function setup({ cwd = "/work", preopens } = {}) {
  const k = new Kernel();
  await registerBuiltinServices(k);
  for (const d of ["/work", "/work/sub", "/tmp"]) k.vfs.mkdir(d, 0o755);
  k.vfs.rootMem.createFile("/work/a.txt", enc.encode("hello world"));
  k.vfs.rootMem.createFile("/etc-file", enc.encode("root file"));
  const proc = k.registerProcess({ kind: "wasm", argv: ["t"] });
  const sync = (op, args) => {
    const r = k.hub.dispatch(proc, OP[op], args);
    if (r && typeof r.then === "function") throw new Error(`async op ${op} in a sync test`);
    return r;
  };
  const memory = new WebAssembly.Memory({ initial: 2 });
  const po = preopens ?? appPreopens(k, proc.caps, cwd);
  const { shim } = createWasiShim({ argv: ["t"], env: {}, preopens: po, sync, getMemory: () => memory, onExit: () => {} });
  const u8 = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);
  // scratch layout: 0..1023 args/results, 1024.. path strings, 4096.. data buffers
  let pathCursor = 1024;
  const str = (s) => { const b = enc.encode(s); const p = pathCursor; u8().set(b, p); pathCursor += b.length + 1; if (pathCursor > 3900) pathCursor = 1024; return [p, b.length]; };
  const fdOut = 0;
  const open = (dirFd, path, { oflags = 0, rights = R_READ, fdflags = 0, dirflags = 1 } = {}) => {
    const [p, l] = str(path);
    const rc = shim.path_open(dirFd, dirflags, p, l, oflags, rights, rights, fdflags, fdOut);
    return { rc, fd: dv().getUint32(fdOut, true) };
  };
  const iov = (bufPtr, len, at = 16) => { dv().setUint32(at, bufPtr, true); dv().setUint32(at + 4, len, true); return at; };
  const write = (fd, text, fn = "fd_write", offset) => {
    const b = typeof text === "string" ? enc.encode(text) : text;
    u8().set(b, 4096);
    const rc = fn === "fd_pwrite" ? shim.fd_pwrite(fd, iov(4096, b.length), 1, BigInt(offset), 8) : shim.fd_write(fd, iov(4096, b.length), 1, 8);
    return { rc, n: dv().getUint32(8, true) };
  };
  const read = (fd, len = 256, fn = "fd_read", offset) => {
    const rc = fn === "fd_pread" ? shim.fd_pread(fd, iov(8192, len), 1, BigInt(offset), 8) : shim.fd_read(fd, iov(8192, len), 1, 8);
    const n = dv().getUint32(8, true);
    return { rc, text: dec.decode(u8().slice(8192, 8192 + n)), n };
  };
  const vfsText = (p) => { const n = k.vfs.rootMem.resolve(p); return n && n.isFile ? dec.decode(n.data) : null; };
  // Preopen fds: 3 = "/" (root), 4 = "." (cwd) for an unscoped process.
  return { k, shim, po, str, open, write, read, dv, u8, vfsText, ROOT: 3, CWD: po.length > 1 ? 4 : 3 };
}

await test("preopens: '/' (VFS root) + cwd as '.' (rootFallback), PWD semantics", async () => {
  const { po } = await setup();
  assertEqual(JSON.stringify(po.map((p) => [p.guestPath, p.hostPath, !!p.rootFallback])), JSON.stringify([["/", "/", false], [".", "/work", true]]), "preopen table");
  const { po: atRoot } = await setup({ cwd: "/" });
  assertEqual(atRoot.length, 1, "cwd=/ → just the root preopen");
});

await test("path resolution: relative, ./, absolute-under-cwd, absolute-elsewhere, .. ", async () => {
  const { open, read, CWD, ROOT } = await setup();
  for (const [dirFd, path, want] of [[CWD, "a.txt", "hello world"], [CWD, "./a.txt", "hello world"], [CWD, "work/a.txt", "hello world"], [CWD, "etc-file", "root file"], [CWD, "sub/../a.txt", "hello world"], [CWD, "../etc-file", "root file"], [ROOT, "work/a.txt", "hello world"], [ROOT, "etc-file", "root file"]]) {
    const o = open(dirFd, path);
    if (!assertEqual(o.rc, E.SUCCESS, `open ${dirFd}:${path}`)) continue;
    assertEqual(read(o.fd).text, want, `read ${dirFd}:${path}`);
  }
});

await test("O_CREAT in cwd vs absolute target elsewhere; O_EXCL; O_DIRECTORY", async () => {
  const { open, write, vfsText, CWD } = await setup();
  const a = open(CWD, "new.txt", { oflags: O_CREAT, rights: R_WRITE });
  assertEqual(a.rc, E.SUCCESS, "create relative"); write(a.fd, "rel");
  assertEqual(vfsText("/work/new.txt"), "rel", "relative create lands in cwd");
  const b = open(CWD, "tmp/abs.txt", { oflags: O_CREAT, rights: R_WRITE });
  assertEqual(b.rc, E.SUCCESS, "create /tmp/abs.txt (stripped)"); write(b.fd, "abs");
  assertEqual(vfsText("/tmp/abs.txt"), "abs", "absolute create outside cwd lands at the root path");
  assertEqual(open(CWD, "a.txt", { oflags: O_CREAT | O_EXCL, rights: R_WRITE }).rc, E.EXIST, "O_EXCL on existing → EEXIST");
  assertEqual(open(CWD, "a.txt", { oflags: O_DIRECTORY }).rc, E.NOTDIR, "O_DIRECTORY on a file → ENOTDIR");
  assertEqual(open(CWD, "missing.txt").rc, E.NOENT, "missing → ENOENT");
});

await test("O_RDWR: read and write through one fd; O_TRUNC; O_APPEND", async () => {
  const { open, write, read, shim, dv, vfsText, CWD } = await setup();
  const rw = open(CWD, "a.txt", { rights: R_READ | R_WRITE });
  assertEqual(rw.rc, E.SUCCESS, "open O_RDWR");
  assertEqual(read(rw.fd, 5).text, "hello", "read first 5");
  write(rw.fd, "!!");
  assertEqual(vfsText("/work/a.txt"), "hello!!orld", "write continues at the read position");
  assertEqual(shim.fd_seek(rw.fd, 0n, 0, 64), E.SUCCESS, "seek 0");
  assertEqual(read(rw.fd).text, "hello!!orld", "re-read whole file");
  const t = open(CWD, "a.txt", { oflags: O_TRUNC, rights: R_WRITE });
  assertEqual(t.rc, E.SUCCESS, "open O_TRUNC");
  assertEqual(vfsText("/work/a.txt"), "", "truncated on open");
  write(t.fd, "base");
  const ap = open(CWD, "a.txt", { rights: R_WRITE, fdflags: FDFLAG_APPEND });
  write(ap.fd, "+1");
  assertEqual(vfsText("/work/a.txt"), "base+1", "O_APPEND write lands at EOF");
  write(t.fd, "XY");
  assertEqual(vfsText("/work/a.txt"), "baseXY", "non-append fd writes at its own position");
  write(ap.fd, "+2");
  assertEqual(vfsText("/work/a.txt"), "baseXY+2", "append fd always lands at EOF");
  // fdstat reports the append flag
  assertEqual(shim.fd_fdstat_get(ap.fd, 128), E.SUCCESS, "fdstat");
  assertEqual(dv().getUint16(130, true) & FDFLAG_APPEND, FDFLAG_APPEND, "fs_flags has APPEND");
  // a read-only fd refuses writes
  const ro = open(CWD, "a.txt", { rights: R_READ });
  assertEqual(write(ro.fd, "x").rc, E.BADF, "write on a read-only fd → EBADF");
});

await test("fd_pread / fd_pwrite don't move the cursor", async () => {
  const { open, write, read, shim, dv, vfsText, CWD } = await setup();
  const f = open(CWD, "a.txt", { rights: R_READ | R_WRITE });
  assertEqual(read(f.fd, 5, "fd_pread", 6).text, "world", "pread at 6");
  assertEqual(write(f.fd, "W", "fd_pwrite", 6).n, 1, "pwrite 1 byte at 6");
  assertEqual(vfsText("/work/a.txt"), "hello World", "pwrite landed at 6");
  assertEqual(shim.fd_tell(f.fd, 64), E.SUCCESS, "tell");
  assertEqual(dv().getBigUint64(64, true), 0n, "cursor unchanged by pread/pwrite");
  assertEqual(read(f.fd, 5).text, "hello", "sequential read starts at 0");
  assertEqual(write(f.fd, "Z", "fd_pwrite", 20).n, 1, "pwrite past EOF");
  assertEqual(vfsText("/work/a.txt").length, 21, "file grew to 21 bytes");
});

await test("fd_filestat_set_size / fd_filestat_set_times / path_filestat_set_times", async () => {
  const { open, shim, k, dv, str, CWD } = await setup();
  const f = open(CWD, "a.txt", { rights: R_READ | R_WRITE });
  assertEqual(shim.fd_filestat_set_size(f.fd, 5n), E.SUCCESS, "truncate to 5");
  assertEqual(k.vfs.stat("/work/a.txt").size, 5, "size 5");
  assertEqual(shim.fd_filestat_set_size(f.fd, 8n), E.SUCCESS, "extend to 8");
  assertEqual(k.vfs.stat("/work/a.txt").size, 8, "size 8");
  assertEqual(shim.fd_filestat_set_times(f.fd, 0n, 1_000_000_000n * 1234n, 4), E.SUCCESS, "set mtime");
  assertEqual(k.vfs.stat("/work/a.txt").mtime, 1234, "mtime = 1234s");
  assertEqual(shim.fd_filestat_get(f.fd, 256), E.SUCCESS, "fstat");
  assertEqual(dv().getBigUint64(256 + 40, true), 1234n * 1_000_000_000n, "filestat atim/mtim reflect it");
  const [p, l] = str("sub");
  assertEqual(shim.path_filestat_set_times(CWD, 1, p, l, 0n, 99n * 1_000_000_000n, 4), E.SUCCESS, "path set times");
  assertEqual(k.vfs.stat("/work/sub").mtime, 99, "dir mtime");
});

await test("path_rename / path_remove_directory / path_unlink_file / path_create_directory", async () => {
  const { shim, str, k, vfsText, CWD, ROOT } = await setup();
  const call = (fn, a, b) => { const [p1, l1] = str(a); if (b === undefined) return shim[fn](CWD, p1, l1); const [p2, l2] = str(b); return shim[fn](CWD, p1, l1, CWD, p2, l2); };
  assertEqual(call("path_rename", "a.txt", "sub/b.txt"), E.SUCCESS, "rename into subdir");
  assertEqual(vfsText("/work/sub/b.txt"), "hello world", "moved");
  assertEqual(vfsText("/work/a.txt"), null, "source gone");
  // rename to an absolute target outside cwd (Go / atomic-write pattern)
  const [p1, l1] = str("sub/b.txt"); const [p2, l2] = str("tmp/c.txt");
  assertEqual(shim.path_rename(CWD, p1, l1, ROOT, p2, l2), E.SUCCESS, "rename across preopens");
  assertEqual(vfsText("/tmp/c.txt"), "hello world", "landed in /tmp");
  assertEqual(call("path_remove_directory", "missingdir"), E.NOENT, "rmdir missing → ENOENT");
  assertEqual(call("path_create_directory", "d1"), E.SUCCESS, "mkdir");
  assertEqual(call("path_create_directory", "d1"), E.EXIST, "mkdir again → EEXIST");
  k.vfs.rootMem.createFile("/work/d1/f", "x");
  assertEqual(call("path_remove_directory", "d1"), E.NOTEMPTY, "rmdir non-empty → ENOTEMPTY");
  assertEqual(call("path_remove_directory", "d1/f"), E.NOTDIR, "rmdir a file → ENOTDIR");
  assertEqual(call("path_unlink_file", "d1"), E.ISDIR, "unlink a dir → EISDIR");
  assertEqual(call("path_unlink_file", "d1/f"), E.SUCCESS, "unlink file");
  assertEqual(call("path_remove_directory", "d1"), E.SUCCESS, "rmdir empty");
  assert(!k.vfs.rootMem.resolve("/work/d1"), "d1 removed");
});

await test("path_symlink / path_readlink / path_link / lstat vs stat", async () => {
  const { shim, str, dv, u8, k, open, read, CWD } = await setup();
  const [t, tl] = str("a.txt"); const [n, nl] = str("ln");
  assertEqual(shim.path_symlink(t, tl, CWD, n, nl), E.SUCCESS, "symlink ln → a.txt");
  const [n2, nl2] = str("ln");
  assertEqual(shim.path_readlink(CWD, n2, nl2, 2048, 64, 40), E.SUCCESS, "readlink");
  assertEqual(dec.decode(u8().slice(2048, 2048 + dv().getUint32(40, true))), "a.txt", "link target");
  const [n3, nl3] = str("a.txt");
  assertEqual(shim.path_readlink(CWD, n3, nl3, 2048, 64, 40), E.INVAL, "readlink on a file → EINVAL");
  assertEqual(read(open(CWD, "ln").fd).text, "hello world", "open follows the link");
  const [n4, nl4] = str("ln");
  shim.path_filestat_get(CWD, 0, n4, nl4, 512);
  assertEqual(dv().getUint8(512 + 16), 7, "lstat (no follow) → symlink filetype");
  const [n5, nl5] = str("ln");
  shim.path_filestat_get(CWD, 1, n5, nl5, 512);
  assertEqual(dv().getUint8(512 + 16), 4, "stat (follow) → regular file");
  const [a1, al1] = str("a.txt"); const [a2, al2] = str("hard.txt");
  assertEqual(shim.path_link(CWD, 0, a1, al1, CWD, a2, al2), E.SUCCESS, "hardlink");
  assertEqual(k.vfs.stat("/work/hard.txt").ino, k.vfs.stat("/work/a.txt").ino, "same inode");
});

await test("fd_renumber, fd_close, bad fds, structural escape on a scoped preopen", async () => {
  const { open, shim, read, CWD } = await setup();
  const a = open(CWD, "a.txt"), b = open(CWD, "../etc-file");
  assertEqual(shim.fd_renumber(a.fd, b.fd), E.SUCCESS, "renumber a → b");
  assertEqual(read(b.fd).text, "hello world", "b now reads a's file");
  assertEqual(shim.fd_close(a.fd), E.BADF, "old fd gone");
  assertEqual(shim.fd_close(b.fd), E.SUCCESS, "close");
  assertEqual(shim.fd_seek(1, 0n, 0, 64), 70, "seek on stdout → ESPIPE");
  // A scoped (non-root) preopen still denies '..' escapes structurally.
  const s = await setup({ preopens: [{ guestPath: "/work", hostPath: "/work", readonly: true }] });
  assertEqual(s.open(3, "../etc-file").rc, E.NOTCAPABLE, "escape → ENOTCAPABLE");
  assertEqual(s.open(3, "new", { oflags: O_CREAT, rights: R_WRITE }).rc, E.ACCES, "readonly preopen refuses create");
});

await test("fd_readdir: one typed listing, cookies resume", async () => {
  const { open, shim, dv, u8, k, CWD } = await setup();
  k.vfs.rootMem.createSymlink("/work/lnk", "a.txt");
  const d = open(CWD, ".", { oflags: O_DIRECTORY });
  assertEqual(d.rc, E.SUCCESS, "open dir");
  const parse = (bufPtr, used) => {
    const out = []; let off = 0;
    while (off + 24 <= used) { const len = dv().getUint32(bufPtr + off + 16, true); const type = dv().getUint8(bufPtr + off + 20); const next = dv().getBigUint64(bufPtr + off, true); out.push({ name: dec.decode(u8().slice(bufPtr + off + 24, bufPtr + off + 24 + len)), type, next }); off += 24 + len; }
    return out;
  };
  assertEqual(shim.fd_readdir(d.fd, 16384, 4096, 0n, 40), E.SUCCESS, "readdir");
  const ents = parse(16384, dv().getUint32(40, true));
  const byName = Object.fromEntries(ents.map((e) => [e.name, e.type]));
  assertEqual(JSON.stringify(byName), JSON.stringify({ ".": 3, "..": 3, sub: 3, "a.txt": 4, lnk: 7 }), "names + types");
  // resume from the 3rd entry's cookie
  shim.fd_readdir(d.fd, 16384, 4096, ents[2].next, 40);
  const rest = parse(16384, dv().getUint32(40, true));
  assertEqual(rest.length, ents.length - 3, "resume after cookie");
});

await test("poll_oneoff: a relative clock subscription sleeps; fd subscriptions are ready", async () => {
  const { shim, dv } = await setup();
  const sub = 1024, out = 2048;
  dv().setBigUint64(sub, 7n, true); dv().setUint8(sub + 8, 0); dv().setUint32(sub + 16, 1, true);
  dv().setBigUint64(sub + 24, 30_000_000n, true); dv().setUint16(sub + 40, 0, true);
  const t0 = Date.now();
  assertEqual(shim.poll_oneoff(sub, out, 1, 40), E.SUCCESS, "poll");
  const dt = Date.now() - t0;
  assert(dt >= 25, `slept ~30ms (took ${dt}ms)`);
  assertEqual(dv().getUint32(40, true), 1, "one event");
  assertEqual(dv().getBigUint64(out, true), 7n, "userdata echoed");
  dv().setBigUint64(sub, 9n, true); dv().setUint8(sub + 8, 1); dv().setUint32(sub + 16, 0, true);
  assertEqual(shim.poll_oneoff(sub, out, 1, 40), E.SUCCESS, "poll fd_read");
  assertEqual(dv().getUint8(out + 10), 1, "fd_read event");
});

await test("import surface: every wasip1 function (Go GOOS=wasip1 + wasi-libc) is provided", async () => {
  const { shim } = await setup();
  const WASIP1 = ["args_get", "args_sizes_get", "environ_get", "environ_sizes_get", "clock_res_get", "clock_time_get",
    "fd_advise", "fd_allocate", "fd_close", "fd_datasync", "fd_fdstat_get", "fd_fdstat_set_flags", "fd_fdstat_set_rights",
    "fd_filestat_get", "fd_filestat_set_size", "fd_filestat_set_times", "fd_pread", "fd_prestat_get", "fd_prestat_dir_name",
    "fd_pwrite", "fd_read", "fd_readdir", "fd_renumber", "fd_seek", "fd_sync", "fd_tell", "fd_write", "path_create_directory",
    "path_filestat_get", "path_filestat_set_times", "path_link", "path_open", "path_readlink", "path_remove_directory",
    "path_rename", "path_symlink", "path_unlink_file", "poll_oneoff", "proc_exit", "proc_raise", "sched_yield", "random_get",
    "sock_accept", "sock_recv", "sock_send", "sock_shutdown"];
  const missing = WASIP1.filter((n) => typeof shim[n] !== "function");
  assertEqual(missing.join(","), "", "missing imports");
});

await test("runWasm: stdin EOF by default, stdin bytes, env, binary-safe stdout", async () => {
  const k = new Kernel(); await registerBuiltinServices(k);
  const none = await runWasm(k, { wasmBytes: stdinEchoModule("E:"), argv: ["e"], timeoutMs: 15000 });
  assertEqual(none.stdout, "E:", "no stdin → EOF (no hang)");
  const bin = new Uint8Array([0, 0xff, 0xfe, 0x80, 10, 13, 0x89, 0x50]);
  const r = await runWasm(k, { wasmBytes: stdinEchoModule("B:"), argv: ["e"], stdinBytes: bin, timeoutMs: 15000 });
  const want = [...enc.encode("B:"), ...bin];
  assert(r.stdoutBytes instanceof Uint8Array && r.stdoutBytes.length === want.length && r.stdoutBytes.every((b, i) => b === want[i]), `stdoutBytes intact (${[...(r.stdoutBytes ?? [])]})`);
  const e = await runWasm(k, { wasmBytes: envDumpModule(), argv: ["env"], env: { A: "1", B: "x y" }, timeoutMs: 15000 });
  assertEqual(e.stdout, "A=1\0B=x y\0", "env");
});

await test("wasm-app delegate (wait): stdin/env/PWD/bytes options + 15-min default timeout", async () => {
  const k = new Kernel(); await registerBuiltinServices(k);
  const runner = createWasmAppRunner(k);
  runner.register("echoin", stdinEchoModule("IN:"));
  runner.register("envdump", envDumpModule());
  const parent = k.registerProcess({ kind: "node", argv: ["p"] });
  const del = k.router.delegateFor("wasm-app");
  const r = await del({ parent, argv: ["echoin"], cwd: "/", env: {}, caps: parent.caps, wait: true, stdin: new Uint8Array([1, 2, 255]) });
  assertEqual([...r.stdoutBytes].join(","), [...enc.encode("IN:"), 1, 2, 255].join(","), "bytes in → bytes out");
  k.vfs.mkdir("/work", 0o755);
  const e = await del({ parent, argv: ["envdump"], cwd: "/work", env: { X: "y", PWD: "/stale" }, caps: parent.caps, wait: true });
  assertEqual(e.stdout, "X=y\0PWD=/work\0", "env passed, PWD = cwd");
  const { WASM_APP_DEFAULT_TIMEOUT_MS } = await import("../src/wasm-app.mjs");
  assertEqual(WASM_APP_DEFAULT_TIMEOUT_MS, 15 * 60 * 1000, "default timeout");
});

console.log(`\n=== WASI shim syscalls + wasm-app semantics: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
