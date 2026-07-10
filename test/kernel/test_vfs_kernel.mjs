#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Unit tests for K2: KernelVfs (mounts, kernel fd table, path surface)
 * and the WatchRegistry (coalescing, directory watching).
 *
 * Usage: node test/kernel/test_vfs_kernel.mjs
 */
import { KernelVfs } from "../../kernel/vfs/vfs.mjs";
import { WatchRegistry } from "../../kernel/vfs/watch.mjs";
import { Kernel, KernelError, ERRNO } from "../../kernel/index.mjs";

let passed = 0;
let failed = 0;
let current = "";

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${current} - ${msg}`);
    failed++;
    return false;
  }
  return true;
}
function assertEqual(a, b, msg) {
  if (a !== b) {
    console.error(`  FAIL: ${current} - ${msg}: expected ${b}, got ${a}`);
    failed++;
    return false;
  }
  return true;
}
async function test(name, fn) {
  current = name;
  const before = failed;
  try {
    await fn();
    if (failed === before) {
      passed++;
      console.log(`  PASS: ${name}`);
    }
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name} - threw ${e.message}`);
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const text = (s) => new TextEncoder().encode(s);

// ============================================================
// KernelVfs
// ============================================================

await test("kernel wires a default root mem mount", () => {
  const k = new Kernel();
  assert(k.vfs instanceof KernelVfs, "vfs is KernelVfs");
  assertEqual(k.vfs.mounts().length, 1, "one mount");
  assertEqual(k.vfs.mounts()[0].prefix, "/", "root prefix");
  assert(k.vfs.rootMem !== undefined, "rootMem exposed");
});

await test("fd surface: open/write/read/close round-trip", () => {
  const vfs = new KernelVfs();
  const fd = vfs.open("/hello.txt", 0x40 | 1, 0o644); // O_CREAT|O_WRONLY
  assert(fd >= 1000, "kernel fd range");
  assertEqual(vfs.write(fd, text("hello kernel"), 0), 12, "write count");
  vfs.close(fd);
  const rfd = vfs.open("/hello.txt", 0, 0);
  const buf = new Uint8Array(32);
  const n = vfs.read(rfd, buf, 0, 32, 0);
  assertEqual(n, 12, "read count");
  assertEqual(new TextDecoder().decode(buf.subarray(0, n)), "hello kernel", "content");
  vfs.close(rfd);
});

await test("fd surface: errors become KernelError", () => {
  const vfs = new KernelVfs();
  try {
    vfs.open("/missing.txt", 0, 0);
    assert(false, "open should throw");
  } catch (e) {
    assert(e instanceof KernelError, "KernelError type");
    assertEqual(e.errno, ERRNO.ENOENT, "ENOENT");
  }
  try {
    vfs.read(9999, new Uint8Array(1), 0, 1, 0);
    assert(false, "read should throw");
  } catch (e) {
    assertEqual(e.errno, ERRNO.EBADF, "EBADF");
  }
});

await test("path surface: stat/readdir/realpath/mkdir/rename", () => {
  const vfs = new KernelVfs();
  vfs.mkdir("/proj", 0o755);
  vfs.rootMem.createFile("/proj/a.txt", "aaa");
  const st = vfs.stat("/proj/a.txt");
  assertEqual(st.size, 3, "stat size");
  assert(st.isFile, "isFile");
  assertEqual(vfs.readdir("/proj").join(","), "a.txt", "readdir");
  vfs.rename("/proj/a.txt", "/proj/b.txt");
  assertEqual(vfs.readdir("/proj").join(","), "b.txt", "renamed");
  vfs.rootMem.createSymlink("/proj/ln", "/proj/b.txt");
  assertEqual(vfs.realpath("/proj/ln"), "/proj/b.txt", "realpath through symlink");
});

await test("named mem mounts resolve longest-prefix and reject cross-mount link", () => {
  const vfs = new KernelVfs({ "/scratch": { backend: "mem" } });
  assertEqual(vfs.mounts().length, 2, "two mounts");
  vfs.rootMem.createFile("/scratch.txt", "root file");
  const fd = vfs.open("/scratch/inside.txt", 0x40 | 1, 0o644);
  vfs.write(fd, text("mounted"), 0);
  vfs.close(fd);
  // The file landed in the mount backend, not the root backend.
  assert(vfs.rootMem.resolve("/scratch/inside.txt") === null, "not in root backend");
  assertEqual(vfs.stat("/scratch/inside.txt").size, 7, "visible through one tree");
  vfs.rootMem.createFile("/rootside.txt", "x");
  try {
    vfs.link("/rootside.txt", "/scratch/linked");
    assert(false, "cross-mount link should throw");
  } catch (e) {
    assertEqual(e.errno, ERRNO.EXDEV, "EXDEV");
  }
});

// ============================================================
// WatchRegistry
// ============================================================

await test("watch delivers coalesced change events", async () => {
  const vfs = new KernelVfs();
  vfs.rootMem.createFile("/w/file.txt", "x");
  const events = [];
  vfs.watch.watch("/w/file.txt", (ev) => events.push(ev));
  const fd = vfs.open("/w/file.txt", 1, 0);
  vfs.write(fd, text("a"), 0);
  vfs.write(fd, text("b"), 1);
  vfs.write(fd, text("c"), 2);
  vfs.close(fd);
  await tick();
  assertEqual(events.length, 1, "3 writes coalesce to 1 event");
  assertEqual(events[0].kind, "change", "kind");
  assertEqual(events[0].filename, "file.txt", "filename");
});

await test("directory watch sees direct children with filename", async () => {
  const vfs = new KernelVfs();
  vfs.mkdir("/dir", 0o755);
  const events = [];
  vfs.watch.watch("/dir", (ev) => events.push(ev));
  vfs.rootMem.createFile("/dir/new.txt", "x");
  vfs.unlink("/dir/new.txt");
  await tick();
  const kinds = events.map((e) => `${e.kind}:${e.filename}`).join(",");
  assertEqual(kinds, "rename:new.txt", "create+delete coalesce per (path,kind)");
});

await test("unwatch stops delivery; watcher exceptions are isolated", async () => {
  const reg = new WatchRegistry();
  const got = [];
  const id = reg.watch("/x", () => got.push(1));
  reg.watch("/x", () => {
    throw new Error("boom");
  });
  reg.watch("/x", () => got.push(2));
  reg.emit("/x", "change");
  await tick();
  assertEqual(got.join(","), "1,2", "throwing watcher isolated");
  reg.unwatch(id);
  reg.emit("/x", "change");
  await tick();
  assertEqual(got.join(","), "1,2,2", "unwatched listener silent");
});

await test("mount-prefixed paths reach watchers with the full path", async () => {
  const vfs = new KernelVfs({ "/scratch": { backend: "mem" } });
  const events = [];
  vfs.watch.watch("/scratch/f.txt", (ev) => events.push(ev));
  const fd = vfs.open("/scratch/f.txt", 0x40 | 1, 0o644);
  vfs.write(fd, text("x"), 0);
  vfs.close(fd);
  await tick();
  assert(events.length >= 1, "event delivered");
  assertEqual(events[0].path, "/scratch/f.txt", "full path, not mount-relative");
});

// ============================================================
// Summary
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
