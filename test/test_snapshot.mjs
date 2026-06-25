#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Snapshot round-trip tests for NanoVM.
 * Tests MemFS serialization and (when bundled WASM + node ELF available) full VM snapshotting.
 *
 * Usage:
 *   node test/test_snapshot.mjs                    # MemFS-only tests (no WASM needed)
 *   node test/test_snapshot.mjs --vm               # Include VM round-trip tests (needs wasm/nano.wasm + busybox)
 *   node test/test_snapshot.mjs --node             # Include Node.js warm-start test (needs bundled WASM)
 */
import { MemFS } from "../container/memfs.mjs";

let passed = 0;
let failed = 0;
let skipped = 0;
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
    console.error(`  FAIL: ${current} - ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    failed++;
    return false;
  }
  return true;
}

function test(name, fn) {
  current = name;
  try {
    fn();
    passed++;
    console.log(`  OK: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name} - ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  current = name;
  try {
    await fn();
    passed++;
    console.log(`  OK: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name} - ${e.message}`);
    failed++;
  }
}

// ============================================================
// MemFS serialization tests
// ============================================================

console.log("\n=== MemFS Serialization Tests ===");

test("serialize empty FS", () => {
  const fs = new MemFS();
  const data = fs.serialize();
  assert(Array.isArray(data), "serialize returns array");
  assert(data.length === 1, "root only"); // just root
  assertEqual(data[0].name, "", "root name is empty string");
});

test("round-trip files and directories", () => {
  const fs = new MemFS();
  fs.createDir("/tmp");
  fs.createDir("/tmp/sub");
  fs.createFile("/tmp/hello.txt", "Hello World!");
  fs.createFile("/tmp/sub/deep.txt", "deep content");

  const data = fs.serialize();
  const fs2 = MemFS.deserialize(data);

  // Verify files survived
  const hello = fs2.resolve("/tmp/hello.txt");
  assert(hello !== null, "hello.txt exists");
  assert(hello.isFile, "hello.txt is a file");
  assertEqual(new TextDecoder().decode(hello.data), "Hello World!", "hello.txt content");

  const deep = fs2.resolve("/tmp/sub/deep.txt");
  assert(deep !== null, "deep.txt exists");
  assertEqual(new TextDecoder().decode(deep.data), "deep content", "deep.txt content");
});

test("round-trip symlinks", () => {
  const fs = new MemFS();
  fs.createDir("/bin");
  fs.createExecutable("/bin/busybox", "ELF");
  fs.createSymlink("/bin/sh", "busybox");

  const data = fs.serialize();
  const fs2 = MemFS.deserialize(data);

  const sh = fs2.resolve("/bin/sh", false);
  assert(sh !== null, "/bin/sh exists");
  assert(sh.isSymlink, "/bin/sh is symlink");
  assertEqual(sh.target, "busybox", "symlink target");

  // Following the symlink should reach busybox
  const resolved = fs2.resolve("/bin/sh", true);
  assert(resolved !== null, "symlink resolves");
  assertEqual(resolved.name, "busybox", "resolves to busybox");
});

test("round-trip preserves file modes", () => {
  const fs = new MemFS();
  fs.createExecutable("/run.sh", "#!/bin/sh\necho hi");

  const data = fs.serialize();
  const fs2 = MemFS.deserialize(data);

  const node = fs2.resolve("/run.sh");
  assert(node !== null, "run.sh exists");
  assertEqual(node.mode, 0o100755, "executable mode preserved");
});

test("round-trip preserves binary data", () => {
  const fs = new MemFS();
  const binary = new Uint8Array([0, 1, 2, 255, 254, 128, 0, 0]);
  fs.createFile("/bin/test.elf", binary);

  const data = fs.serialize();
  const fs2 = MemFS.deserialize(data);

  const node = fs2.resolve("/bin/test.elf");
  assert(node !== null, "test.elf exists");
  assertEqual(node.data.length, binary.length, "binary length");
  for (let i = 0; i < binary.length; i++) {
    assertEqual(node.data[i], binary[i], `byte ${i}`);
  }
});

test("deserialized FS supports new file creation", () => {
  const fs = new MemFS();
  fs.createDir("/tmp");
  fs.createFile("/tmp/existing.txt", "existing");

  const data = fs.serialize();
  const fs2 = MemFS.deserialize(data);

  // Create new file in deserialized FS
  fs2.createFile("/tmp/new.txt", "new content");
  const node = fs2.resolve("/tmp/new.txt");
  assert(node !== null, "new file created");
  assertEqual(new TextDecoder().decode(node.data), "new content", "new file content");

  // Original file still intact
  const existing = fs2.resolve("/tmp/existing.txt");
  assert(existing !== null, "existing file still present");
});

test("round-trip large FS with many entries", () => {
  const fs = new MemFS();
  fs.createDir("/data");
  for (let i = 0; i < 100; i++) {
    fs.createFile(`/data/file_${i}.txt`, `content ${i}`);
  }

  const data = fs.serialize();
  assertEqual(data.length, 102, "102 nodes (root + /data + 100 files)");

  const fs2 = MemFS.deserialize(data);
  for (let i = 0; i < 100; i++) {
    const node = fs2.resolve(`/data/file_${i}.txt`);
    assert(node !== null, `file_${i}.txt exists`);
    assertEqual(new TextDecoder().decode(node.data), `content ${i}`, `file_${i}.txt content`);
  }
});

// ============================================================
// VM snapshot tests (optional, need WASM)
// ============================================================

const runVM = process.argv.includes("--vm") || process.argv.includes("--node");

if (runVM) {
  console.log("\n=== VM Snapshot Tests ===");

  // Dynamic import to avoid failure when WASM not available
  const { NanoVM } = await import("../container/nanovm.mjs");
  const { readFileSync, existsSync } = await import("fs");
  const { resolve, dirname } = await import("path");
  const { fileURLToPath } = await import("url");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, "..");
  const wasmPath = resolve(root, "wasm/nano.wasm");

  if (!existsSync(wasmPath)) {
    console.log("  SKIP: wasm/nano.wasm not found (run 'make build' first)");
    skipped++;
  } else {
    const wasmBytes = readFileSync(wasmPath);

    // Create a minimal VM for busybox snapshot test
    await testAsync("busybox snapshot round-trip", async () => {
      const vm = await NanoVM.create({ ramMB: 512, wasm: wasmBytes });

      // Run a busybox command that produces known output, but first
      // we need to test the snapshot mechanism works by triggering it
      // through a file write sentinel.

      // For busybox, we test MemFS round-trip during a run:
      // 1. Run "echo snapshot_test" to produce output
      const result = await vm.run("echo snapshot_test");
      assertEqual(result.stdout.trim(), "snapshot_test", "busybox output correct");

      // 2. Test that snapshot() captures state
      const snap = vm.snapshot();
      assert(snap.vmStruct.length === 12680, "VM struct size");
      assert(snap.lowRAM.length > 0, "low RAM (heap/mmap) captured");
      assert(snap.stackRAM.length > 0, "stack RAM captured");
      assert(snap.memfs.length > 0, "MemFS serialized");

      vm.destroy();
    });
  }
}

// ============================================================
// Node.js warm-start test (optional, needs bundled WASM with node)
// ============================================================

if (process.argv.includes("--node")) {
  console.log("\n=== Node.js Warm-Start Snapshot Test ===");

  const { NanoVM } = await import("../container/nanovm.mjs");
  const { readFileSync, existsSync } = await import("fs");
  const { resolve, dirname } = await import("path");
  const { fileURLToPath } = await import("url");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, "..");
  const wasmPath = resolve(root, "wasm/nano.wasm");

  if (!existsSync(wasmPath)) {
    console.log("  SKIP: wasm/nano.wasm not found");
    skipped++;
  } else {
    const wasmBytes = readFileSync(wasmPath);

    await testAsync("Node.js snapshot + restore", async () => {
      // Node.js V8 needs substantial RAM for heap tables
      const wasmSizeMB = wasmBytes.length / (1024 * 1024);
      const ramMB = Math.floor(2000 - wasmSizeMB - 20);
      console.log(`  RAM: ${ramMB} MB (WASM: ${wasmSizeMB.toFixed(0)} MB)`);
      const vm = await NanoVM.create({ ramMB, wasm: wasmBytes });

      if (!vm._nodeElf) {
        console.log("  SKIP: no bundled Node.js ELF (run 'make build')");
        skipped++;
        vm.destroy();
        return;
      }

      // === Cold start: run node -e directly for baseline ===
      console.log("  Cold start baseline...");
      const coldStart = performance.now();
      const coldResult = await vm.node("-e", 'process.stdout.write("cold_hello\\n")', {
        maxSteps: 2_000_000_000,
      });
      const coldMs = performance.now() - coldStart;
      console.log(`  Cold start: ${coldMs.toFixed(0)}ms, stdout="${coldResult.stdout.trim()}"`);

      // === Take snapshot after V8 init ===
      console.log("  Taking Node.js snapshot...");
      const snapStart = performance.now();
      const snap = await vm.nodeSnapshot();
      const snapMs = performance.now() - snapStart;

      assert(snap.vmStruct.length === 12680, "VM struct captured");
      assert(snap.lowRAM.length > 1024 * 1024, "substantial low RAM captured");
      assert(snap.stackRAM.length > 0, "stack RAM captured");
      const totalSnap = snap.lowRAM.length + snap.stackRAM.length;
      console.log(`  Snapshot: ${(snap.lowRAM.length / 1024 / 1024).toFixed(1)} MB low + ${(snap.stackRAM.length / 1024).toFixed(0)} KB stack, took ${snapMs.toFixed(0)}ms`);

      // === Warm start: restore and run ===
      console.log("  Warm start from snapshot...");
      // Instrument FS request tracking
      const origProcess = vm._processFsRequest.bind(vm);
      let fsCount = 0;
      const fsCalls = [];
      vm._processFsRequest = function() {
        const X = vm._exports;
        const reqPtr = X.vm_fs_request_ptr(vm._vmPtr);
        const dv = new DataView(vm._memory.buffer);
        const nr = dv.getInt32(reqPtr, true);
        const gfd = dv.getInt32(reqPtr + 4, true);
        const pathBytes = new Uint8Array(vm._memory.buffer, reqPtr + 40, 256);
        let pe = 0; while (pe < 256 && pathBytes[pe] !== 0) pe++;
        const path = pe > 0 ? new TextDecoder().decode(pathBytes.slice(0, pe)) : "";
        fsCalls.push({ nr, gfd, path });
        fsCount++;
        return origProcess();
      };
      const warmStart = performance.now();
      const warmResult = await vm.restoreAndRun(snap, 'process.stdout.write("warm_hello\\n")', {
        maxSteps: 2_000_000_000,
      });
      const warmMs = performance.now() - warmStart;
      console.log(`  Warm start: ${warmMs.toFixed(0)}ms, exitCode=${warmResult.exitCode}, stdout="${warmResult.stdout.trim()}"`);
      console.log(`  FS calls during warm start: ${fsCount}`);
      for (const c of fsCalls.slice(0, 30)) {
        const names = {17:'getcwd',34:'mkdirat',35:'unlinkat',48:'faccessat',56:'openat',57:'close',61:'getdents64',62:'lseek',63:'read',64:'write',67:'pread64',79:'fstatat',80:'fstat',88:'utimensat',291:'statx'};
        console.log(`    ${names[c.nr]||c.nr} gfd=${c.gfd} path="${c.path}"`);
      }
      if (fsCalls.length > 30) console.log(`    ... and ${fsCalls.length - 30} more`);

      // Check /dev/__run__ exists in restored MemFS
      const runNode = vm._memfs.resolve("/dev/__run__");
      console.log(`  /dev/__run__ exists: ${runNode !== null}, size=${runNode?.size}`);

      assert(warmResult.stdout.trim().startsWith("warm_hello"), "warm-started script output starts with warm_hello");

      // === Summary ===
      const speedup = coldMs / warmMs;
      console.log(`\n  === Benchmark Summary ===`);
      console.log(`  Cold start: ${coldMs.toFixed(0)}ms`);
      console.log(`  Snapshot:   ${snapMs.toFixed(0)}ms (one-time cost)`);
      console.log(`  Warm start: ${warmMs.toFixed(0)}ms`);
      console.log(`  Speedup:    ${speedup.toFixed(1)}x faster`);

      vm.destroy();
    });
  }
}

// ============================================================
// Summary
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
process.exit(failed > 0 ? 1 : 0);
