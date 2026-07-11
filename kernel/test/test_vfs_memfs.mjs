#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Unit tests for the K1 VFS additions on kernel/vfs/memfs.mjs:
 * instance-scoped ino counter, link(), realpath(), chmod(), utimes(),
 * truncate()/ftruncate(), and hardlink-safe serialize/deserialize.
 *
 * Usage: node test/kernel/test_vfs_memfs.mjs
 */
import { MemFS } from "../vfs/memfs.mjs";

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

function test(name, fn) {
  current = name;
  const before = failed;
  try {
    fn();
    if (failed === before) {
      passed++;
      console.log(`  PASS: ${name}`);
    }
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name} - threw ${e.message}`);
  }
}

const text = (s) => new TextEncoder().encode(s);
const fakeMem = () => ({ buffer: new ArrayBuffer(4096) });

// ============================================================
// Instance-scoped ino counter
// ============================================================

test("ino counters are per-instance", () => {
  const a = new MemFS();
  const b = new MemFS();
  a.createFile("/a.txt", "x");
  a.createFile("/b.txt", "x");
  const bNode = b.createFile("/only.txt", "x");
  // b allocated independently: root=1, only.txt=2
  assertEqual(bNode.ino, 2, "second instance unaffected by first");
});

test("deserialize advances only its own counter", () => {
  const a = new MemFS();
  a.createFile("/f.txt", "hello");
  const snap = a.serialize();
  const other = new MemFS(); // fresh instance, counter at 2 after root
  const restored = MemFS.deserialize(snap);
  const n1 = restored.createFile("/new.txt", "y");
  const n2 = other.createFile("/new.txt", "y");
  assert(n1.ino > snap[snap.length - 1].id, "restored counter past snapshot inos");
  assertEqual(n2.ino, 2, "unrelated instance keeps its own numbering");
});

// ============================================================
// link()
// ============================================================

test("link creates a hardlink sharing data and ino", () => {
  const fs = new MemFS();
  const orig = fs.createFile("/dir/orig.txt", "content");
  fs.createDir("/other");
  assertEqual(fs.link("/dir/orig.txt", "/other/alias.txt"), 0, "link ok");
  const alias = fs.resolve("/other/alias.txt");
  assert(alias === orig, "same node");
  assertEqual(orig.nlink, 2, "nlink bumped");
  // write through one name, read through the other
  const fd = fs.open("/other/alias.txt", 1, 0);
  const mem = fakeMem();
  new Uint8Array(mem.buffer, 0, 3).set(text("XYZ"));
  fs.pwrite(fd, mem, 0, 3, 0);
  fs.close(fd);
  assertEqual(
    new TextDecoder().decode(fs.resolve("/dir/orig.txt").data.subarray(0, 3)),
    "XYZ",
    "data shared across links"
  );
});

test("link error cases", () => {
  const fs = new MemFS();
  fs.createFile("/f.txt", "x");
  fs.createDir("/d");
  assertEqual(fs.link("/missing", "/l"), -2, "ENOENT on missing source");
  assertEqual(fs.link("/d", "/l"), -1, "EPERM on directory");
  assertEqual(fs.link("/f.txt", "/f.txt"), -17, "EEXIST on existing target");
  assertEqual(fs.link("/f.txt", "/nodir/l"), -2, "ENOENT on missing target dir");
});

test("unlink decrements nlink; other alias survives", () => {
  const fs = new MemFS();
  const node = fs.createFile("/a.txt", "keep");
  fs.link("/a.txt", "/b.txt");
  assertEqual(node.nlink, 2, "two links");
  assertEqual(fs.unlink("/a.txt", 0), 0, "unlink first name");
  assertEqual(node.nlink, 1, "nlink back to 1");
  assert(fs.resolve("/b.txt") === node, "alias still resolves");
  assertEqual(
    new TextDecoder().decode(fs.resolve("/b.txt").data),
    "keep",
    "data intact"
  );
});

test("serialize/deserialize preserves hardlinks", () => {
  const fs = new MemFS();
  fs.createFile("/dir/orig.txt", "shared");
  fs.createDir("/other");
  fs.link("/dir/orig.txt", "/other/alias.txt");
  const restored = MemFS.deserialize(fs.serialize());
  const a = restored.resolve("/dir/orig.txt");
  const b = restored.resolve("/other/alias.txt");
  assert(a !== null && b !== null, "both names restored");
  assert(a === b, "restored as one node");
  assertEqual(a.nlink, 2, "nlink preserved");
  assertEqual(new TextDecoder().decode(a.data), "shared", "data restored once");
});

// ============================================================
// realpath()
// ============================================================

test("realpath resolves symlinks to canonical paths", () => {
  const fs = new MemFS();
  fs.createFile("/usr/lib/thing.js", "x");
  fs.createSymlink("/usr/bin/thing", "/usr/lib/thing.js");
  assertEqual(fs.realpath("/usr/bin/thing"), "/usr/lib/thing.js", "symlink target");
  assertEqual(fs.realpath("/usr/lib/thing.js"), "/usr/lib/thing.js", "identity");
  assertEqual(fs.realpath("/"), "/", "root");
  assertEqual(fs.realpath("/nope"), -2, "ENOENT");
});

// ============================================================
// chmod / utimes
// ============================================================

test("chmod updates permission bits, keeps type", () => {
  const fs = new MemFS();
  const node = fs.createFile("/f.sh", "x");
  assertEqual(fs.chmod("/f.sh", 0o755), 0, "chmod ok");
  assertEqual(node.mode, 0o100755, "perm changed, S_IFREG kept");
  assertEqual(fs.chmod("/missing", 0o755), -2, "ENOENT");
});

test("utimes sets mtime and stat reports it", () => {
  const fs = new MemFS();
  fs.createFile("/f.txt", "x");
  assertEqual(fs.utimes("/f.txt", 1234567890), 0, "utimes ok");
  const mem = fakeMem();
  fs.stat("/f.txt", mem, 0, 0);
  const dv = new DataView(mem.buffer, 0, 128);
  assertEqual(Number(dv.getBigInt64(88, true)), 1234567890, "st_mtime honored");
});

// ============================================================
// truncate / ftruncate
// ============================================================

test("truncate shrinks and grows", () => {
  const fs = new MemFS();
  fs.createFile("/f.txt", "hello world");
  assertEqual(fs.truncate("/f.txt", 5), 0, "shrink ok");
  const node = fs.resolve("/f.txt");
  assertEqual(node.size, 5, "size shrunk");
  assertEqual(new TextDecoder().decode(node.data), "hello", "data cut");
  assertEqual(fs.truncate("/f.txt", 8), 0, "grow ok");
  assertEqual(node.size, 8, "size grown");
  assertEqual(node.data[7], 0, "zero-filled");
  assertEqual(fs.truncate("/missing", 1), -2, "ENOENT");
});

test("ftruncate works on open fds", () => {
  const fs = new MemFS();
  fs.createFile("/f.txt", "hello world");
  const fd = fs.open("/f.txt", 2, 0);
  assertEqual(fs.ftruncate(fd, 5), 0, "ftruncate ok");
  assertEqual(fs.resolve("/f.txt").size, 5, "size shrunk");
  fs.close(fd);
  assertEqual(fs.ftruncate(999, 1), -9, "EBADF");
});

// ============================================================
// Summary
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
