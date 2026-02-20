#!/usr/bin/env node
/**
 * Unit tests for MemFS (test/memfs.mjs)
 * Pure Node.js - no WASM needed. Tests the in-memory filesystem independently.
 *
 * Usage: node test/test_memfs.mjs
 */
import { MemFS } from "./memfs.mjs";

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
  try {
    fn();
    if (failed === 0 || true) { // always count
      passed++;
      console.log(`  OK: ${name}`);
    }
  } catch (e) {
    console.error(`  FAIL: ${name} - ${e.message}`);
    failed++;
  }
}

// Helper: create a fake WebAssembly.Memory-like object for stat tests
function makeMemBuf(size) {
  const buf = new ArrayBuffer(size);
  return { buffer: buf };
}

console.log("=== MemFS Unit Tests ===\n");

// ============================================================
// File creation and reading
// ============================================================

test("createFile - basic", () => {
  const fs = new MemFS();
  fs.createFile("/hello.txt", "Hello World");
  const node = fs.resolve("/hello.txt");
  assert(node !== null, "file should exist");
  assert(node.isFile, "should be a file");
  assertEqual(node.size, 11, "size");
});

test("createFile - binary data", () => {
  const fs = new MemFS();
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  fs.createFile("/bin.dat", data);
  const node = fs.resolve("/bin.dat");
  assertEqual(node.size, 5, "size");
  assertEqual(node.data[0], 1, "first byte");
  assertEqual(node.data[4], 5, "last byte");
});

test("createFile - nested path auto-creates dirs", () => {
  const fs = new MemFS();
  fs.createFile("/a/b/c/file.txt", "deep");
  assert(fs.resolve("/a") !== null, "/a exists");
  assert(fs.resolve("/a").isDir, "/a is dir");
  assert(fs.resolve("/a/b") !== null, "/a/b exists");
  assert(fs.resolve("/a/b/c") !== null, "/a/b/c exists");
  assert(fs.resolve("/a/b/c/file.txt") !== null, "file exists");
});

test("createFile - overwrite existing", () => {
  const fs = new MemFS();
  fs.createFile("/f.txt", "old");
  fs.createFile("/f.txt", "new content");
  const node = fs.resolve("/f.txt");
  assertEqual(node.size, 11, "updated size");
});

// ============================================================
// Directory operations
// ============================================================

test("createDir - basic", () => {
  const fs = new MemFS();
  fs.createDir("/mydir");
  const node = fs.resolve("/mydir");
  assert(node !== null, "dir exists");
  assert(node.isDir, "is a directory");
});

test("createDir - nested", () => {
  const fs = new MemFS();
  fs.createDir("/a/b/c");
  assert(fs.resolve("/a/b/c").isDir, "deep dir exists");
});

test("mkdir - EEXIST on duplicate", () => {
  const fs = new MemFS();
  fs.createDir("/foo");
  const result = fs.mkdir("/foo", 0o755);
  assertEqual(result, -17, "EEXIST");
});

test("mkdir - ENOENT on missing parent", () => {
  const fs = new MemFS();
  const result = fs.mkdir("/nonexistent/child", 0o755);
  assertEqual(result, -2, "ENOENT");
});

// ============================================================
// Symlinks
// ============================================================

test("createSymlink - basic", () => {
  const fs = new MemFS();
  fs.createFile("/target.txt", "data");
  fs.createSymlink("/link.txt", "/target.txt");
  const link = fs.resolve("/link.txt", false); // don't follow
  assert(link.isSymlink, "is symlink");
  assertEqual(link.target, "/target.txt", "target path");
});

test("createSymlink - resolve follows symlink", () => {
  const fs = new MemFS();
  fs.createFile("/real.txt", "content");
  fs.createSymlink("/alias.txt", "/real.txt");
  const resolved = fs.resolve("/alias.txt", true);
  assert(resolved !== null, "resolved exists");
  assert(resolved.isFile, "resolved to file");
  assertEqual(resolved.name, "real.txt", "resolved name");
});

test("createSymlink - relative target", () => {
  const fs = new MemFS();
  fs.createDir("/dir");
  fs.createFile("/dir/actual.txt", "hello");
  fs.createSymlink("/dir/link.txt", "actual.txt");
  const resolved = fs.resolve("/dir/link.txt", true);
  assert(resolved !== null, "resolved via relative symlink");
  assertEqual(resolved.name, "actual.txt", "correct target");
});

test("createSymlink - chain", () => {
  const fs = new MemFS();
  fs.createFile("/orig.txt", "base");
  fs.createSymlink("/link1", "/orig.txt");
  fs.createSymlink("/link2", "/link1");
  const resolved = fs.resolve("/link2");
  assert(resolved !== null, "chain resolved");
  assertEqual(resolved.name, "orig.txt", "resolved to original");
});

// ============================================================
// Open / Close / Read / Write
// ============================================================

test("open - read existing file", () => {
  const fs = new MemFS();
  fs.createFile("/test.txt", "Hello");
  const fd = fs.open("/test.txt", 0, 0); // O_RDONLY
  assert(fd >= 0, `fd should be valid, got ${fd}`);
  fs.close(fd);
});

test("open - ENOENT for missing file without O_CREAT", () => {
  const fs = new MemFS();
  const fd = fs.open("/nonexistent.txt", 0, 0);
  assertEqual(fd, -2, "ENOENT");
});

test("open - O_CREAT creates file", () => {
  const fs = new MemFS();
  const fd = fs.open("/new.txt", 0x40, 0o644); // O_CREAT
  assert(fd >= 0, "created file");
  const node = fs.resolve("/new.txt");
  assert(node !== null, "file exists after O_CREAT");
  fs.close(fd);
});

test("open - O_TRUNC truncates", () => {
  const fs = new MemFS();
  fs.createFile("/trunc.txt", "Hello World");
  const fd = fs.open("/trunc.txt", 0x200, 0); // O_TRUNC
  assert(fd >= 0, "opened with trunc");
  const node = fs.resolve("/trunc.txt");
  assertEqual(node.size, 0, "truncated to 0");
  fs.close(fd);
});

test("open - directory", () => {
  const fs = new MemFS();
  fs.createDir("/mydir");
  const fd = fs.open("/mydir", 0, 0);
  assert(fd >= 0, "opened directory");
  const entry = fs.openFiles.get(fd);
  assert(entry.node.isDir, "entry is dir");
  assert(Array.isArray(entry.dirEntries), "has dirEntries");
  fs.close(fd);
});

test("close - EBADF for invalid fd", () => {
  const fs = new MemFS();
  assertEqual(fs.close(999), -9, "EBADF");
});

test("pread / pwrite round-trip", () => {
  const fs = new MemFS();
  fs.createFile("/rw.txt", "");
  const fd = fs.open("/rw.txt", 2, 0); // O_RDWR

  const mem = makeMemBuf(1024);
  const src = new TextEncoder().encode("Test Data!");
  new Uint8Array(mem.buffer, 0, src.length).set(src);

  // Write
  const written = fs.pwrite(fd, mem, 0, src.length, 0);
  assertEqual(written, 10, "wrote 10 bytes");

  // Read back
  const readMem = makeMemBuf(1024);
  const nread = fs.pread(fd, readMem, 0, 10, 0);
  assertEqual(nread, 10, "read 10 bytes");

  const readBack = new TextDecoder().decode(new Uint8Array(readMem.buffer, 0, 10));
  assertEqual(readBack, "Test Data!", "data matches");

  fs.close(fd);
});

test("pread - EOF returns 0", () => {
  const fs = new MemFS();
  fs.createFile("/eof.txt", "hi");
  const fd = fs.open("/eof.txt", 0, 0);
  const mem = makeMemBuf(64);
  const n = fs.pread(fd, mem, 0, 10, 100); // offset past end
  assertEqual(n, 0, "EOF");
  fs.close(fd);
});

test("pwrite - extends file", () => {
  const fs = new MemFS();
  fs.createFile("/grow.txt", "abc");
  const fd = fs.open("/grow.txt", 2, 0);
  const mem = makeMemBuf(64);
  new Uint8Array(mem.buffer, 0, 3).set(new TextEncoder().encode("XYZ"));

  fs.pwrite(fd, mem, 0, 3, 10); // write at offset 10
  const node = fs.resolve("/grow.txt");
  assertEqual(node.size, 13, "file grew to 13");

  fs.close(fd);
});

// ============================================================
// Stat
// ============================================================

test("stat - file", () => {
  const fs = new MemFS();
  fs.createFile("/s.txt", "12345");
  const mem = makeMemBuf(256);
  const result = fs.stat("/s.txt", mem, 0, 0);
  assertEqual(result, 0, "stat returns 0");
  const dv = new DataView(mem.buffer);
  const size = Number(dv.getBigInt64(48, true));
  assertEqual(size, 5, "st_size = 5");
  const mode = dv.getUint32(16, true);
  assert((mode & 0o170000) === 0o100000, "S_IFREG");
});

test("stat - directory", () => {
  const fs = new MemFS();
  fs.createDir("/statdir");
  const mem = makeMemBuf(256);
  fs.stat("/statdir", mem, 0, 0);
  const dv = new DataView(mem.buffer);
  const mode = dv.getUint32(16, true);
  assert((mode & 0o170000) === 0o040000, "S_IFDIR");
});

test("stat - ENOENT for missing", () => {
  const fs = new MemFS();
  const mem = makeMemBuf(256);
  const result = fs.stat("/nope", mem, 0, 0);
  assertEqual(result, -2, "ENOENT");
});

test("fstat - open file", () => {
  const fs = new MemFS();
  fs.createFile("/fs.txt", "hello");
  const fd = fs.open("/fs.txt", 0, 0);
  const mem = makeMemBuf(256);
  const result = fs.fstat(fd, mem, 0);
  assertEqual(result, 0, "fstat ok");
  const dv = new DataView(mem.buffer);
  assertEqual(Number(dv.getBigInt64(48, true)), 5, "st_size = 5");
  fs.close(fd);
});

test("fstat - EBADF", () => {
  const fs = new MemFS();
  const mem = makeMemBuf(256);
  assertEqual(fs.fstat(999, mem, 0), -9, "EBADF");
});

// ============================================================
// Directory listing (getdents)
// ============================================================

test("getdents - list directory", () => {
  const fs = new MemFS();
  fs.createDir("/listdir");
  fs.createFile("/listdir/a.txt", "a");
  fs.createFile("/listdir/b.txt", "b");
  fs.createDir("/listdir/sub");

  const fd = fs.open("/listdir", 0, 0);
  const mem = makeMemBuf(4096);
  const result = fs.getdents(fd, mem, 0, 4096, 0);
  assert(typeof result === "object", "returns object");
  assert(result.bytes > 0, "has data");
  // Should have entries: ., .., a.txt, b.txt, sub
  assertEqual(result.nextCookie, 5, "5 entries");
  fs.close(fd);
});

test("getdents - cookie pagination", () => {
  const fs = new MemFS();
  fs.createDir("/pagedir");
  fs.createFile("/pagedir/1.txt", "1");
  fs.createFile("/pagedir/2.txt", "2");

  const fd = fs.open("/pagedir", 0, 0);
  const mem = makeMemBuf(4096);

  // Read from cookie=2 (skip . and ..)
  const result = fs.getdents(fd, mem, 0, 4096, 2);
  assert(result.bytes > 0, "has entries after cookie");
  assertEqual(result.nextCookie, 4, "remaining entries");
  fs.close(fd);
});

// ============================================================
// Readlink
// ============================================================

test("readlink - basic", () => {
  const fs = new MemFS();
  fs.createFile("/target", "data");
  fs.createSymlink("/mylink", "/target");
  const mem = makeMemBuf(256);
  const len = fs.readlink("/mylink", mem, 0, 256);
  assertEqual(len, 7, "link target length");
  const target = new TextDecoder().decode(new Uint8Array(mem.buffer, 0, len));
  assertEqual(target, "/target", "link target content");
});

test("readlink - EINVAL for non-symlink", () => {
  const fs = new MemFS();
  fs.createFile("/regular.txt", "data");
  const mem = makeMemBuf(256);
  assertEqual(fs.readlink("/regular.txt", mem, 0, 256), -22, "EINVAL");
});

test("readlink - ENOENT for missing", () => {
  const fs = new MemFS();
  const mem = makeMemBuf(256);
  assertEqual(fs.readlink("/nope", mem, 0, 256), -2, "ENOENT");
});

// ============================================================
// Unlink / Rename
// ============================================================

test("unlink - remove file", () => {
  const fs = new MemFS();
  fs.createFile("/del.txt", "data");
  assertEqual(fs.unlink("/del.txt", 0), 0, "unlink ok");
  assertEqual(fs.resolve("/del.txt"), null, "file gone");
});

test("unlink - ENOENT for missing", () => {
  const fs = new MemFS();
  assertEqual(fs.unlink("/nope.txt", 0), -2, "ENOENT");
});

test("unlink - EISDIR without AT_REMOVEDIR", () => {
  const fs = new MemFS();
  fs.createDir("/rmdir");
  assertEqual(fs.unlink("/rmdir", 0), -21, "EISDIR");
});

test("unlink - AT_REMOVEDIR for empty dir", () => {
  const fs = new MemFS();
  fs.createDir("/empty");
  assertEqual(fs.unlink("/empty", 0x200), 0, "rmdir ok");
  assertEqual(fs.resolve("/empty"), null, "dir gone");
});

test("unlink - ENOTEMPTY for non-empty dir", () => {
  const fs = new MemFS();
  fs.createDir("/notempty");
  fs.createFile("/notempty/child.txt", "x");
  assertEqual(fs.unlink("/notempty", 0x200), -39, "ENOTEMPTY");
});

test("rename - basic", () => {
  const fs = new MemFS();
  fs.createFile("/old.txt", "data");
  assertEqual(fs.rename("/old.txt", "/new.txt"), 0, "rename ok");
  assertEqual(fs.resolve("/old.txt"), null, "old gone");
  const node = fs.resolve("/new.txt");
  assert(node !== null, "new exists");
  assertEqual(node.size, 4, "data preserved");
});

test("rename - move to different directory", () => {
  const fs = new MemFS();
  fs.createDir("/src");
  fs.createDir("/dst");
  fs.createFile("/src/file.txt", "moved");
  assertEqual(fs.rename("/src/file.txt", "/dst/file.txt"), 0, "rename across dirs");
  assertEqual(fs.resolve("/src/file.txt"), null, "old gone");
  assert(fs.resolve("/dst/file.txt") !== null, "new exists");
});

test("rename - ENOENT for missing source", () => {
  const fs = new MemFS();
  fs.createDir("/dst");
  assertEqual(fs.rename("/nope.txt", "/dst/nope.txt"), -2, "ENOENT");
});

// ============================================================
// Access
// ============================================================

test("access - existing file", () => {
  const fs = new MemFS();
  fs.createFile("/acc.txt", "x");
  assertEqual(fs.access("/acc.txt"), 0, "accessible");
});

test("access - ENOENT", () => {
  const fs = new MemFS();
  assertEqual(fs.access("/nope"), -2, "ENOENT");
});

// ============================================================
// Path resolution edge cases
// ============================================================

test("resolve - dot navigation", () => {
  const fs = new MemFS();
  fs.createFile("/a/b/file.txt", "data");
  const node = fs.resolve("/a/./b/./file.txt");
  assert(node !== null, ". navigation works");
  assertEqual(node.name, "file.txt", "correct file");
});

test("resolve - dotdot navigation", () => {
  const fs = new MemFS();
  fs.createFile("/a/b/file.txt", "data");
  const node = fs.resolve("/a/b/../b/file.txt");
  assert(node !== null, ".. navigation works");
  assertEqual(node.name, "file.txt", "correct file");
});

test("resolve - root dotdot stays at root", () => {
  const fs = new MemFS();
  const node = fs.resolve("/../../../");
  assert(node !== null, "root .. doesn't crash");
  assert(node.isDir, "still a directory");
});

test("resolve - empty path returns null", () => {
  const fs = new MemFS();
  assertEqual(fs.resolve(""), null, "empty path");
});

test("resolve - nonexistent returns null", () => {
  const fs = new MemFS();
  assertEqual(fs.resolve("/does/not/exist"), null, "null for missing");
});

// ============================================================
// lseekSize
// ============================================================

test("lseekSize - returns file size", () => {
  const fs = new MemFS();
  fs.createFile("/sz.txt", "12345");
  const fd = fs.open("/sz.txt", 0, 0);
  assertEqual(fs.lseekSize(fd), 5, "size = 5");
  fs.close(fd);
});

test("lseekSize - EBADF for invalid fd", () => {
  const fs = new MemFS();
  assertEqual(fs.lseekSize(999), -9, "EBADF");
});

// ============================================================
// Executable creation
// ============================================================

test("createExecutable - sets mode 755", () => {
  const fs = new MemFS();
  const node = fs.createExecutable("/bin/test", "#!/bin/sh\necho hi");
  assertEqual(node.mode, 0o100755, "executable mode");
});

// ============================================================
// Tar loading
// ============================================================

test("loadTar - parse simple tar", () => {
  // Create a minimal tar with one file entry
  const fs = new MemFS();
  const tar = new Uint8Array(1536); // 3 blocks: header + data + zero
  const enc = new TextEncoder();

  // Header block (512 bytes) - simplified POSIX tar
  const name = "hello.txt";
  enc.encodeInto(name, tar.subarray(0, 100));

  // Mode (octal, null-terminated)
  enc.encodeInto("0000644\0", tar.subarray(100, 108));

  // Size (octal) - 5 bytes
  enc.encodeInto("0000005\0", tar.subarray(124, 136));

  // Type flag: '0' = regular file
  tar[156] = 0x30; // '0'

  // Checksum (simplified - just set a basic one)
  // Calculate proper checksum
  enc.encodeInto("        ", tar.subarray(148, 156)); // blank checksum first
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += tar[i];
  const csStr = sum.toString(8).padStart(6, '0') + "\0 ";
  enc.encodeInto(csStr, tar.subarray(148, 156));

  // Data block
  enc.encodeInto("world", tar.subarray(512, 517));

  fs._parseTar(tar);
  const node = fs.resolve("/hello.txt");
  assert(node !== null, "file from tar exists");
  assertEqual(node.size, 5, "correct size");
  assertEqual(new TextDecoder().decode(node.data), "world", "correct content");
});

// ============================================================
// Summary
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
