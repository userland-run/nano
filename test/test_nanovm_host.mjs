#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Shipped-host regression tests: real BusyBox driven through the SAME host the
 * browser/SDK uses (runners/riscv/host/nanovm.mjs + the kernel MemFS), not the
 * test-only run.mjs harness. Covers the fd / path / fork semantics that only the
 * shipped host implements (serialized fork, pipes, shared open-file
 * descriptions):
 *   - "." / ".." / symlinked-directory paths in create/mkdir/unlink/rename/chdir
 *   - `cmd >f 2>&1` and `{ a; b; } >f` share one file offset (dup + fork)
 *   - a forked child closing an inherited fd doesn't close the parent's file
 *   - fork → execve(other ELF) → parent resumes correctly
 *   - rename of a directory into its own subtree is refused (EINVAL)
 *   - paths longer than 255 bytes are not truncated
 *
 * Needs wasm/nano.wasm + runners/riscv/images/busybox (skips otherwise).
 * Usage: node test/test_nanovm_host.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const wasmPath = process.env.NANOVM_WASM || join(root, "wasm", "nano.wasm");
const busyboxPath = join(root, "runners", "riscv", "images", "busybox");
const helloPath = join(here, "hello.elf");

if (!existsSync(wasmPath) || !existsSync(busyboxPath)) {
  console.log("  SKIP: shipped-host tests (need wasm/nano.wasm + runners/riscv/images/busybox)");
  process.exit(0);
}

const { NanoVM } = await import("../runners/riscv/host/nanovm.mjs");

let passed = 0;
let failed = 0;
let current = "";

function assert(cond, msg) {
  if (!cond) {
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
    console.error(`  FAIL: ${name} - ${e.stack || e.message}`);
    failed++;
  }
}

const vm = await NanoVM.create({ ramMB: 256, wasm: readFileSync(wasmPath) });
// The minimal build embeds no busybox: install it into the VFS like the catalog does.
vm.addFile("/bin/busybox", readFileSync(busyboxPath), 0o755);
const memfs = vm._memfs;

/** Run a shell script through `sh <file>` (run() splits its command on spaces). */
async function sh(script) {
  vm.addFile("/tmp/__t.sh", script + "\n");
  const r = await vm.run("sh /tmp/__t.sh", { maxSteps: 400_000_000 });
  return { code: r.exitCode, out: r.stdout };
}

const fileText = (p) => vm.readFileString(p);

await test("'..', '.', and symlinked-dir paths in mkdir/create/rename/unlink/cd", async () => {
  // (symlinkat isn't a guest syscall yet — plant the directory symlink host-side)
  memfs.createDir("/tmp/p/a/c");
  memfs.unlink("/tmp/p/a/c", 0x200);
  memfs.createSymlink("/tmp/p/lnk", "/tmp/p/a/c");
  const { code, out } = await sh([
    "mkdir -p /tmp/p/a/b",
    "cd /tmp/p/a/b",
    "mkdir ../c",              // mkdirat(AT_FDCWD, "../c") relative to the cwd
    "echo hi > ./../c/f",      // O_CREAT through "." and ".."
    "mv ../c/f ../../moved",   // rename with ".." on both sides
    "echo z > /tmp/p/lnk/via", // create inside a symlinked directory
    "mkdir /tmp/p/lnk/sub",    // mkdir inside a symlinked directory
    "rm ../../moved",          // unlink with ".."
    "cd ../c && pwd",          // chdir with ".." → canonical cwd
    "cd /tmp/p/lnk && pwd -P", // chdir through a symlink → physical cwd
    "cd /nonexistent 2>/dev/null || echo cd-enoent",
    "cd /test/hello.txt 2>/dev/null || echo cd-enotdir",
  ].join("\n"));
  assertEqual(code, 0, "script exit code");
  assert(out.includes("/tmp/p/a/c\n"), `cd ../c → /tmp/p/a/c (out=${JSON.stringify(out)})`);
  assert(out.split("\n").filter((l) => l === "/tmp/p/a/c").length === 2, "pwd -P through the symlink is physical");
  assert(out.includes("cd-enoent"), "chdir to a missing dir fails");
  assert(out.includes("cd-enotdir"), "chdir to a file fails");
  assertEqual(fileText("/tmp/p/a/c/via"), "z\n", "file created through the symlinked dir");
  assert(memfs.resolve("/tmp/p/a/c/sub")?.isDir, "dir created through the symlinked dir");
  assertEqual(memfs.resolve("/tmp/p/moved"), null, "unlink through '..' removed the file");
  assertEqual(memfs.resolve("/tmp/p/a/c/f"), null, "rename moved the file away");
});

await test("`cmd >f 2>&1` shares one offset between stdout and stderr", async () => {
  const { code } = await sh("ls /test /missing-dir > /tmp/o1 2>&1; true");
  assertEqual(code, 0, "exit code");
  const t = fileText("/tmp/o1") || "";
  assert(t.includes("hello.txt") && t.includes("nums.txt"), `stdout kept (${JSON.stringify(t)})`);
  assert(/missing-dir/.test(t), `stderr kept, not overwritten (${JSON.stringify(t)})`);
});

await test("`{ ls; echo done; } > out` — forked child and parent append", async () => {
  await sh("{ ls /test; echo done; } > /tmp/o2");
  assertEqual(fileText("/tmp/o2"), "hello.txt\nnums.txt\ndone\n", "group output in order");
  await sh("{ echo one; echo two; } > /tmp/o3; echo three >> /tmp/o3");
  assertEqual(fileText("/tmp/o3"), "one\ntwo\nthree\n", "builtin group + O_APPEND");
});

await test("a forked child closing an inherited fd keeps the parent's file open", async () => {
  const { out } = await sh([
    "exec 3>/tmp/o4",
    "echo a >&3",
    "( exec 3>&- )",            // subshell (fork) closes ITS copy of fd 3
    "echo b >&3 || echo write-failed",
    "exec 3>&-",
  ].join("\n"));
  assert(!out.includes("write-failed"), `parent fd 3 still writable (out=${JSON.stringify(out)})`);
  assertEqual(fileText("/tmp/o4"), "a\nb\n", "both writes landed at the shared offset");
  // Every description is released once the processes are gone.
  assertEqual(memfs.openFiles.size, 0, "no leaked open-file descriptions");
});

/**
 * A minimal static RV64 ELF whose entry point is `pc`: `li a0, 42; li a7, 93;
 * ecall` (exit 42). Mapped so its code sits at exactly `pc`.
 */
function probeElf(pc) {
  const code = [0x02a00513, 0x05d00893, 0x00000073];
  let base = Math.floor(pc / 4096) * 4096;
  if (pc - base < 120) base -= 4096; // keep the ELF + program headers below the code
  const fileSize = pc - base + code.length * 4;
  const b = new Uint8Array(fileSize);
  const dv = new DataView(b.buffer);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);     // ELF64, little-endian, v1
  dv.setUint16(16, 2, true);                      // ET_EXEC
  dv.setUint16(18, 0xf3, true);                   // EM_RISCV
  dv.setUint32(20, 1, true);
  dv.setBigUint64(24, BigInt(pc), true);          // e_entry
  dv.setBigUint64(32, 64n, true);                 // e_phoff
  dv.setUint16(52, 64, true);                     // e_ehsize
  dv.setUint16(54, 56, true);                     // e_phentsize
  dv.setUint16(56, 1, true);                      // e_phnum
  dv.setUint32(64, 1, true);                      // PT_LOAD
  dv.setUint32(68, 5, true);                      // R+X
  dv.setBigUint64(72, 0n, true);                  // p_offset
  dv.setBigUint64(80, BigInt(base), true);        // p_vaddr
  dv.setBigUint64(88, BigInt(base), true);        // p_paddr
  dv.setBigUint64(96, BigInt(fileSize), true);    // p_filesz
  dv.setBigUint64(104, BigInt(fileSize), true);   // p_memsz
  dv.setBigUint64(112, 4096n, true);              // p_align
  code.forEach((w, i) => dv.setUint32(pc - base + i * 4, w, true));
  return b;
}

await test("fork → execve(other image at the parent's resume pc) → parent resumes its own code", async () => {
  // The child execs an image whose code lives at the exact pc the parent
  // resumes at after clone(). Decoded blocks are keyed by address, so unless
  // the block cache is dropped when the parent is restored, the parent would
  // run the CHILD's cached block there (exit 42) instead of its own code.
  const origSnap = vm._forkSnapshot.bind(vm);
  let armed = true;
  vm._forkSnapshot = () => {
    const snap = origSnap();
    if (armed) {
      armed = false;
      const pc = Number(new DataView(snap.vmStruct.buffer, snap.vmStruct.byteOffset).getBigUint64(256, true));
      vm.addFile("/bin/probe", probeElf(pc), 0o755);
    }
    return snap;
  };
  try {
    const { code, out } = await sh("/bin/probe\necho back-$?\n/bin/probe\necho again-$?");
    assert(out.includes("back-42\n") && out.includes("again-42\n"), `parent resumed after each child (out=${JSON.stringify(out)})`);
    assertEqual(code, 0, "parent exit code (not the child's 42)");
  } finally {
    vm._forkSnapshot = origSnap;
  }
});

await test("fork → execve(another ELF) → parent resumes", async () => {
  if (!existsSync(helloPath)) { console.log("    (skipped: test/hello.elf missing)"); return; }
  vm.addFile("/bin/hello", readFileSync(helloPath), 0o755);
  const { code, out } = await sh([
    "/bin/hello", "echo back-$?",
    "/bin/hello", "x=$(echo sub)", "echo got-$x",
    "for i in 1 2 3; do ls /test >/dev/null; echo n$i; done",
    "echo end",
  ].join("\n"));
  assertEqual(code, 0, "exit code");
  assertEqual((out.match(/Hello from NanoVM/g) || []).length, 2, "child image ran twice");
  assert(out.includes("back-0\n") && out.includes("got-sub\n"), `parent resumed (out=${JSON.stringify(out)})`);
  assert(out.includes("n1\nn2\nn3\nend\n"), "loop of fork+exec completed");
});

/** Static RV64 ELF (one RX segment at 0x10000) from code words + trailing data. */
function rawElf(codeWords, data) {
  const base = 0x10000, codeOff = 0x100;
  const dataOff = codeOff + codeWords.length * 4;
  const b = new Uint8Array(dataOff + data.length);
  const dv = new DataView(b.buffer);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  dv.setUint16(16, 2, true); dv.setUint16(18, 0xf3, true); dv.setUint32(20, 1, true);
  dv.setBigUint64(24, BigInt(base + codeOff), true);
  dv.setBigUint64(32, 64n, true);
  dv.setUint16(52, 64, true); dv.setUint16(54, 56, true); dv.setUint16(56, 1, true);
  dv.setUint32(64, 1, true); dv.setUint32(68, 5, true);
  dv.setBigUint64(80, BigInt(base), true); dv.setBigUint64(88, BigInt(base), true);
  dv.setBigUint64(96, BigInt(b.length), true); dv.setBigUint64(104, BigInt(b.length), true);
  dv.setBigUint64(112, 4096n, true);
  codeWords.forEach((w, i) => dv.setUint32(codeOff + i * 4, w >>> 0, true));
  b.set(data, dataOff);
  return { bytes: b, dataAddr: base + dataOff };
}
// Tiny RV64 assembler for the handful of instructions the probes need.
const R = { zero: 0, a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15, a7: 17 };
const addi = (rd, rs, imm) => ((imm & 0xfff) << 20) | (rs << 15) | (rd << 7) | 0x13;
const li = (rd, v) => {
  if (v >= -2048 && v < 2048) return [addi(rd, 0, v)];
  const hi = (v + 0x800) >> 12;
  return [((hi & 0xfffff) << 12) | (rd << 7) | 0x37, addi(rd, rd, v - (hi << 12))];
};
const ECALL = 0x73;

await test("file-backed mmap is populated with the file's contents", async () => {
  const text = "mapped-from-file\n";
  vm.addFile("/tmp/mm.txt", text + "x".repeat(5000)); // spans two pages
  // open("/tmp/mm.txt") → mmap(0, 8192, PROT_READ, MAP_PRIVATE, fd, 0) →
  // write(1, map, len(text)) → write(1, map+4096, 4) → exit(0)
  const path = new TextEncoder().encode("/tmp/mm.txt\0");
  const build = (dataAddr) => [
    ...li(R.a0, -100), ...li(R.a1, dataAddr), ...li(R.a2, 0), ...li(R.a7, 56), ECALL,
    addi(R.a4, R.a0, 0),
    ...li(R.a0, 0), ...li(R.a1, 8192), ...li(R.a2, 1), ...li(R.a3, 2), ...li(R.a5, 0), ...li(R.a7, 222), ECALL,
    addi(R.a1, R.a0, 0), addi(R.a3, R.a0, 0),
    ...li(R.a0, 1), ...li(R.a2, text.length), ...li(R.a7, 64), ECALL,
    ...li(R.a0, 1), ...li(R.a1, 4096), 0x00d585b3 /* add a1, a1, a3 */, ...li(R.a2, 4), ...li(R.a7, 64), ECALL,
    ...li(R.a0, 0), ...li(R.a7, 93), ECALL,
  ];
  // Two passes: the data address depends on the code length.
  const probe = rawElf(build(0x10000), path);
  const elf = rawElf(build(probe.dataAddr), path);
  vm.addFile("/bin/mmprobe", elf.bytes, 0o755);
  const { code, out } = await sh("/bin/mmprobe");
  assertEqual(code, 0, "exit code");
  assertEqual(out, text + "xxxx", "mapping holds the file bytes (both pages)");
});

await test("munmap twice / MAP_FIXED never let two mappings share pages", async () => {
  const S1 = 9, S2 = 18, S3 = 19;
  const mv = (rd, rs) => addi(rd, rs, 0);
  const xor = (rd, a, b) => (b << 20) | (a << 15) | (4 << 12) | (rd << 7) | 0x33;
  const seqz = (rd, rs) => (1 << 20) | (rs << 15) | (3 << 12) | (rd << 7) | 0x13; // sltiu rd, rs, 1
  const mmap = (addr, flags) => [
    ...(addr === null ? li(R.a0, 0) : [mv(R.a0, addr)]), ...li(R.a1, 4096), ...li(R.a2, 3),
    ...li(R.a3, flags), ...li(R.a4, -1), ...li(R.a5, 0), ...li(R.a7, 222), ECALL,
  ];
  const munmap = (reg) => [mv(R.a0, reg), ...li(R.a1, 4096), ...li(R.a7, 215), ECALL];
  const exitEq = (reg) => [xor(R.a0, R.a0, reg), seqz(R.a0, R.a0), ...li(R.a7, 93), ECALL];
  const ANON = 0x22, FIXED = 0x32;
  // A, B (keeps A below the frontier); munmap(A) twice; C, D must differ.
  const dbl = [...mmap(null, ANON), mv(S1, R.a0), ...mmap(null, ANON), mv(S2, R.a0),
    ...munmap(S1), ...munmap(S1), ...mmap(null, ANON), mv(S3, R.a0), ...mmap(null, ANON), ...exitEq(S3)];
  // A, B; munmap(A); MAP_FIXED at A claims it; the next anonymous mmap must not get A.
  const fix = [...mmap(null, ANON), mv(S1, R.a0), ...mmap(null, ANON), mv(S2, R.a0),
    ...munmap(S1), ...mmap(S1, FIXED), ...mmap(null, ANON), ...exitEq(S1)];
  vm.addFile("/bin/mmdbl", rawElf(dbl, new Uint8Array(0)).bytes, 0o755);
  vm.addFile("/bin/mmfix", rawElf(fix, new Uint8Array(0)).bytes, 0o755);
  const { out } = await sh("/bin/mmdbl; echo dbl=$?; /bin/mmfix; echo fix=$?");
  assert(out.includes("dbl=0"), `double munmap → distinct mappings (out=${JSON.stringify(out)})`);
  assert(out.includes("fix=0"), `MAP_FIXED range not handed out again (out=${JSON.stringify(out)})`);
});

await test("vfork (clone CLONE_VM|CLONE_VFORK) runs the child first, then resumes the parent", async () => {
  const bne = (rs1, rs2, off) =>
    (((off >> 12) & 1) << 31) | (((off >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) |
    (1 << 12) | (((off >> 1) & 0xf) << 8) | (((off >> 11) & 1) << 7) | 0x63;
  const writeByte = (addr) => [...li(R.a0, 1), ...li(R.a1, addr), ...li(R.a2, 1), ...li(R.a7, 64), ECALL];
  const build = (data) => {
    const clone = [...li(R.a0, 0x4111), ...li(R.a1, 0), ...li(R.a2, 0), ...li(R.a3, 0), ...li(R.a4, 0), ...li(R.a7, 220), ECALL];
    const child = [...writeByte(data), ...li(R.a0, 0), ...li(R.a7, 93), ECALL];
    const parent = [...writeByte(data + 1), ...li(R.a0, 0), ...li(R.a7, 94), ECALL];
    return [...clone, bne(R.a0, R.zero, (child.length + 1) * 4), ...child, ...parent];
  };
  const data = new TextEncoder().encode("CP");
  const elf = rawElf(build(rawElf(build(0x10000), data).dataAddr), data);
  vm.addFile("/bin/vforkprobe", elf.bytes, 0o755);
  const { out } = await sh("/bin/vforkprobe; echo; echo rc=$?");
  assert(out.startsWith("CP\n"), `child output precedes parent's (out=${JSON.stringify(out)})`);
});

await test("rename of a directory into its own subtree is EINVAL", async () => {
  const { out } = await sh("mkdir -p /tmp/r/s; mv /tmp/r /tmp/r/s/inner 2>/dev/null; echo rc=$?");
  assert(/rc=[1-9]/.test(out), `mv into own subtree fails (out=${JSON.stringify(out)})`);
  assert(memfs.resolve("/tmp/r/s")?.isDir, "tree left intact");
  assertEqual(memfs.rename("/tmp/r", "/tmp/r/s/x"), -22, "MemFS.rename → EINVAL");
  assertEqual(memfs.rename("/tmp/r", "/tmp/r"), 0, "rename onto itself is a no-op");
});

await test("paths longer than 255 bytes are not truncated", async () => {
  const seg = "d".repeat(60);
  const deep = `/tmp/${seg}/${seg}/${seg}/${seg}/${seg}`; // ~310 bytes
  const { out } = await sh(`mkdir -p ${deep} && echo deep > ${deep}/file && cat ${deep}/file`);
  assert(out.includes("deep"), `long path round-trips (out=${JSON.stringify(out.slice(0, 200))})`);
  assertEqual(fileText(deep + "/file"), "deep\n", "file at the full (untruncated) path");
});

await test("dirfd-relative *at() resolution (host)", async () => {
  memfs.createDir("/tmp/dfd/inner");
  const hostFd = memfs.open("/tmp/dfd", 0x10000, 0); // O_DIRECTORY
  const dv = new DataView(vm._memory.buffer);
  vm._fdWrite(dv, 9, 5 /* FD_TYPE_DIR */, hostFd, 0, 0);
  assertEqual(vm._resolvePath("inner/../x", 9), "/tmp/dfd/inner/../x", "relative to dirfd's directory");
  assertEqual(vm._resolvePath("/abs", 9), "/abs", "absolute ignores dirfd");
  vm._fdWrite(dv, 10, 4 /* FD_TYPE_FILE */, hostFd, 0, 0);
  assertEqual(vm._resolvePath("x", 10), -20, "non-directory dirfd → ENOTDIR");
  assertEqual(vm._resolvePath("x", 11), -9, "closed dirfd → EBADF");
  vm._fdClear(dv, 9); vm._fdClear(dv, 10);
  memfs.close(hostFd);
});

console.log(`\n=== shipped host: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
