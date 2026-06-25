#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * NanoVM RISC-V interpreter test - runs a RISC-V ELF on the command line via Node.js + WASM.
 *
 * Usage:  node test/run.mjs [path-to-elf]
 *         node test/run.mjs images/busybox --cmd ls /tmp
 * Default ELF: test/hello.elf
 */
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { MemFS } from "./memfs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// --- Load binaries ---
const elfPath = process.argv[2] || resolve(__dirname, "hello.elf");
const wasmPath = process.env.NANOVM_WASM || resolve(root, "wasm/nano.wasm");

const wasmBytes = readFileSync(wasmPath);
const elfBytes = readFileSync(elfPath);

console.error(`WASM: ${wasmPath} (${wasmBytes.length} bytes)`);
console.error(`ELF:  ${elfPath} (${elfBytes.length} bytes)`);

// --- Create shared memory ---
// Auto-detect bundled builds: if WASM > 1MB, reserve headroom for the data section.
// NANOVM_RAM_MB env var overrides auto-detection.
const wasmSizeMB = wasmBytes.length / (1024 * 1024);
const defaultRAM = wasmSizeMB > 1 ? Math.floor(2000 - wasmSizeMB - 20) : 2000;
const RAM_MB = parseInt(process.env.NANOVM_RAM_MB || String(defaultRAM), 10);
const ramPages = Math.floor((RAM_MB * 1024 * 1024) / 65536);
const maxPages = 32768; // 2GB hard max
const memory = new WebAssembly.Memory({ initial: Math.min(ramPages, maxPages), maximum: maxPages, shared: true });

// --- Console output collection ---
let stdout = "";
let stderr = "";
const trace = process.argv.includes('--trace');
const syscallTrace = [];
const syscallCounts = {};

// --- Optional stdin feed ---
// `--stdin` reads all of fd 0 (a pipe or redirected file) up front, so guest
// reads on stdin drain it and then see EOF — matching `cat < file` semantics.
// Without the flag, stdin reads return EOF immediately (legacy behavior).
const useStdin = process.argv.includes('--stdin');
let stdinData = new Uint8Array(0);
if (useStdin) {
  try { stdinData = new Uint8Array(readFileSync(0)); }
  catch (e) { console.error(`[run] --stdin: failed to read stdin: ${e.message}`); }
}
let stdinPos = 0;

const imports = {
  env: {
    memory,
    abort_js()   { console.error("abort_js() called!"); process.exit(1); },
    debug_log(v) {
      const tag = (v >>> 24) & 0xFF;
      // Context switch diagnostics always print
      if (tag === 0x0F) {
        const from = v & 0xFF;
        const to = (v >>> 8) & 0xFF;
        const reason = (v >>> 16) & 0xFF;
        const reasons = ['?', 'futex_wait', 'epoll_wait', 'exit'];
        console.error(`  [SWITCH] ${from}→${to} (${reasons[reason] || '?'})`);
        return;
      }
      // Epoll debug (tag 0x0D = epoll_ctl, 0x0E = epoll_pwait event)
      if (tag === 0x0D) {
        const op = v & 0xF;
        const fd = (v >>> 4) & 0xFF;
        const events = (v >>> 12) & 0xFF;
        const data_lo = (v >>> 20) & 0xFF;
        const ops = ['?', 'ADD', 'DEL', 'MOD'];
        console.error(`  [EPOLL_CTL] ${ops[op]||op} fd=${fd} events=0x${events.toString(16)} data_lo=${data_lo}`);
        return;
      }
      if (tag === 0x0E) {
        const idx = v & 0xFF;
        const events = (v >>> 8) & 0xFF;
        const data_lo = (v >>> 16) & 0xFFFF;
        console.error(`  [EPOLL_RET] idx=${idx} events=0x${events.toString(16)} data_lo=${data_lo}`);
        return;
      }
      if (!trace) return;
      const val = v & 0xFFFF;
      if (tag === 0x0A) {
        syscallCounts[val] = (syscallCounts[val] || 0) + 1;
        syscallTrace.push(val);
        if (syscallTrace.length > 500) syscallTrace.shift();
      }
    },
    emscripten_random() { return Math.random(); },
    emscripten_date_now() { return Date.now(); },
    console_write(fd, ptr, len) {
      const bytes = new Uint8Array(memory.buffer, ptr, len);
      const text = new TextDecoder().decode(bytes);
      if (fd === 2) { stderr += text; process.stderr.write(text); }
      else          { stdout += text; process.stdout.write(text); }
    },
  },
};

// --- Instantiate WASM ---
const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
const X = instance.exports;

// --- Create VM ---
const RAM_SIZE = RAM_MB * 1024 * 1024;
const vmPtr = X.vm_create(RAM_SIZE);
if (vmPtr === 0) { console.error("vm_create failed"); process.exit(1); }

const ramPtr  = X.vm_ram_ptr(vmPtr);
const ramSize = X.vm_ram_size(vmPtr);

// --- Optional tty mode (--tty): make std fds report as a terminal (isatty) ---
if (process.argv.includes("--tty") && X.vm_tty_enable) {
  X.vm_tty_enable(vmPtr, 1, 80, 25);
  console.error("tty mode enabled (80x25)");
}

// --- Push --stdin data into the in-VM tty ring (new wasm). Older wasm without
//     vm_stdin_push falls back to the SYS_READ drain in processFsRequest. ---
if (useStdin && X.vm_stdin_push && stdinData.length > 0) {
  const p = X.malloc(stdinData.length);
  new Uint8Array(memory.buffer).set(stdinData, p);
  X.vm_stdin_push(vmPtr, p, stdinData.length);
}
if (useStdin && X.vm_stdin_eof) X.vm_stdin_eof(vmPtr);

console.error(`VM created: ptr=${vmPtr}  RAM base=${ramPtr} size=${ramSize} (${(ramSize/1024/1024)|0} MB)`);
console.error(`vm_struct_size = ${X.vm_struct_size()}`);

// --- Copy ELF into guest RAM at guest offset 0 ---
const mem = new Uint8Array(memory.buffer);
mem.set(elfBytes, ramPtr);               // physical WASM addr = ramPtr, guest offset = 0

// --- Load ELF (elf_offset is guest-relative, not physical) ---
const loadRc = X.vm_load_elf(vmPtr, 0, elfBytes.length);
if (loadRc !== 0) { console.error(`vm_load_elf failed: ${loadRc}`); process.exit(1); }

const entryPC = X.debug_pc(vmPtr);
console.error(`ELF loaded – entry PC = 0x${entryPC.toString(16)}`);

// --- Overwrite argv if --cmd flag is specified ---
// Usage: node run.mjs busybox --cmd echo hello world
const cmdIdx = process.argv.indexOf("--cmd");
if (cmdIdx !== -1 && cmdIdx + 1 < process.argv.length) {
  const args = process.argv.slice(cmdIdx + 1); // [applet, arg1, arg2, ...]
  const enc = new TextEncoder();
  const dv = new DataView(memory.buffer);

  // Collect env vars: --env KEY=VALUE flags + defaults for Node.js
  const envVars = [];
  // Default env vars that help Node.js run in our single-threaded emulator
  envVars.push("UV_THREADPOOL_SIZE=0");
  envVars.push("HOME=/root");
  envVars.push("PATH=/usr/local/bin:/usr/bin:/bin");
  envVars.push("TERM=xterm");
  // Parse --env flags from command line (before --cmd)
  {
    const scanEnd = cmdIdx;
    const scanArgs = process.argv.slice(3, scanEnd);
    for (let i = 0; i < scanArgs.length; i++) {
      if (scanArgs[i] === '--env' && i + 1 < scanArgs.length) {
        envVars.push(scanArgs[++i]);
      }
    }
  }

  // Write arg strings at the top of the stack string area
  let strGuest = RAM_SIZE - 4096 - 64;
  const argGuestAddrs = [];
  for (const arg of args) {
    const bytes = enc.encode(arg + "\0");
    argGuestAddrs.push(strGuest);
    mem.set(bytes, ramPtr + strGuest);
    strGuest += bytes.length;
  }

  // Write env strings right after argv strings
  const envGuestAddrs = [];
  for (const env of envVars) {
    const bytes = enc.encode(env + "\0");
    envGuestAddrs.push(strGuest);
    mem.set(bytes, ramPtr + strGuest);
    strGuest += bytes.length;
  }

  // Read current sp and auxv from existing stack
  const sp = Number(dv.getBigUint64(vmPtr + 16, true)); // x[2]

  // Current layout: [argc=1][argv0 ptr][NULL][NULL][auxv...]
  // auxv starts at sp + 32
  const auxvStart = sp + 32;
  const auxvPairs = [];
  let auxOff = auxvStart;
  for (let i = 0; i < 16; i++) { // max 16 pairs safety limit
    const atype = Number(dv.getBigUint64(ramPtr + auxOff, true));
    const aval = dv.getBigUint64(ramPtr + auxOff + 8, true);
    auxvPairs.push([atype, aval]);
    auxOff += 16;
    if (atype === 0) break; // AT_NULL
  }

  // Rebuild stack at a lower address to avoid overlap
  const argc = args.length;
  const envc = envGuestAddrs.length;
  const stackDataSize = 8 + (argc + 1) * 8 + (envc + 1) * 8 + auxvPairs.length * 16;
  let newSp = (sp - 512 - stackDataSize) & ~0xF; // 16-byte aligned, enough room

  let pos = newSp;
  dv.setBigUint64(ramPtr + pos, BigInt(argc), true); pos += 8;
  for (const addr of argGuestAddrs) {
    dv.setBigUint64(ramPtr + pos, BigInt(addr), true); pos += 8;
  }
  dv.setBigUint64(ramPtr + pos, 0n, true); pos += 8; // argv NULL
  for (const addr of envGuestAddrs) {
    dv.setBigUint64(ramPtr + pos, BigInt(addr), true); pos += 8;
  }
  dv.setBigUint64(ramPtr + pos, 0n, true); pos += 8; // envp NULL
  for (const [atype, aval] of auxvPairs) {
    dv.setBigUint64(ramPtr + pos, BigInt(atype), true); pos += 8;
    dv.setBigUint64(ramPtr + pos, aval, true); pos += 8;
  }

  // Update x[2] = sp
  dv.setBigUint64(vmPtr + 16, BigInt(newSp), true);
  console.error(`argv[0..${argc-1}] = [${args.join(", ")}]  sp: 0x${newSp.toString(16)}`);
  console.error(`envp[0..${envc-1}] = [${envVars.join(", ")}]`);
}

// ============================================================
// VFS Setup
// ============================================================
const memfs = new MemFS();

// Seed standard directories and files
memfs.createDir("/bin");
memfs.createExecutable("/bin/busybox", "");
memfs.createSymlink("/bin/sh", "busybox");
memfs.createDir("/dev");
memfs.createFile("/dev/null", "");
memfs.createDir("/etc");
memfs.createFile("/etc/passwd", "root:x:0:0:root:/root:/bin/sh\n");
memfs.createFile("/etc/group", "root:x:0:\n");
memfs.createFile("/etc/hostname", "nanovm\n");
memfs.createDir("/etc/ssl");
memfs.createFile("/etc/ssl/openssl.cnf", "[openssl_init]\n");
memfs.createDir("/home");
memfs.createDir("/proc/self");
memfs.createSymlink("/proc/self/exe", "/bin/busybox");
memfs.createFile("/proc/cpuinfo", [
  "processor\t: 0",
  "hart\t\t: 0",
  "isa\t\t: rv64imafdc",
  "mmu\t\t: sv39",
  ""
].join("\n"));
memfs.createFile("/proc/version_signature", "NanoVM 1.0\n");
memfs.createFile("/proc/self/cgroup", "0::/\n");
// /proc/self/statm: size resident shared text lib data dt (values in pages)
const totalPages = Math.floor(RAM_SIZE / 4096);
const usedPages = Math.floor(totalPages * 0.3);
memfs.createFile("/proc/self/statm", `${totalPages} ${usedPages} 0 ${Math.floor(usedPages/2)} 0 ${Math.floor(usedPages/2)} 0\n`);
memfs.createDir("/sys/fs/cgroup");
memfs.createFile("/sys/fs/cgroup/memory.max", "max\n");
memfs.createFile("/sys/fs/cgroup/memory.high", "max\n");
memfs.createFile("/proc/meminfo", [
  `MemTotal:       ${RAM_MB * 1024} kB`,
  `MemFree:        ${Math.floor(RAM_MB * 1024 * 0.8)} kB`,
  `MemAvailable:   ${Math.floor(RAM_MB * 1024 * 0.7)} kB`,
  `Buffers:               0 kB`,
  `Cached:                0 kB`,
  `SwapTotal:             0 kB`,
  `SwapFree:              0 kB`,
  ""
].join("\n"));
memfs.createDir("/root");
memfs.createDir("/sbin");
memfs.createDir("/tmp");
memfs.createDir("/var");
memfs.createDir("/test");
memfs.createFile("/test/hello.txt", "Hello from NanoVM VFS!\n");
memfs.createFile("/test/nums.txt", "1\n2\n3\n4\n5\n");

// --- Load bundled devenv tarball if available ---
{
  const devenvPtr = typeof X.vm_bundled_devenv_ptr === "function" ? X.vm_bundled_devenv_ptr() : 0;
  const devenvSize = typeof X.vm_bundled_devenv_size === "function" ? X.vm_bundled_devenv_size() : 0;
  if (devenvPtr > 0 && devenvSize > 0) {
    console.error(`Loading bundled devenv (${(devenvSize / 1024 / 1024).toFixed(1)} MB compressed)...`);
    const tarGz = new Uint8Array(memory.buffer, devenvPtr, devenvSize);
    // Copy to a separate buffer since memory.buffer can be detached during decompression
    const tarGzCopy = new Uint8Array(tarGz);
    await memfs.loadTarGz(tarGzCopy);
    console.error(`Devenv loaded into VFS`);
  }
}

// --- Load local files into guest MemFS (--load localpath:/guestpath) ---
{
  const endIdx = process.argv.indexOf('--cmd');
  const scanArgs = process.argv.slice(3, endIdx !== -1 ? endIdx : undefined);
  for (let i = 0; i < scanArgs.length; i++) {
    if (scanArgs[i] === '--load' && i + 1 < scanArgs.length) {
      const spec = scanArgs[++i];
      const m = spec.match(/^(.+):(\/.+)$/);
      if (m) {
        const data = readFileSync(m[1], 'utf-8');
        const parts = m[2].split('/').filter(Boolean);
        let dir = '';
        for (let j = 0; j < parts.length - 1; j++) {
          dir += '/' + parts[j];
          try { memfs.createDir(dir); } catch {}
        }
        memfs.createFile(m[2], data);
        console.error(`Loaded ${m[1]} → ${m[2]} (${data.length} chars)`);
      }
    }
  }
}

// ============================================================
// FD table helpers
// ============================================================
const FD_TABLE_OFF = 600;
const FD_ENTRY_SIZE = 24;
const MAX_FDS = 64;
const FD_TYPE_NONE = 0;
const FD_TYPE_STDIN = 1;
const FD_TYPE_STDOUT = 2;
const FD_TYPE_STDERR = 3;
const FD_TYPE_FILE = 4;
const FD_TYPE_DIR = 5;
const FD_TYPE_PIPE = 6;
const FD_TYPE_EPOLL = 7;
const FD_TYPE_EVENTFD = 8;

function fdRead(dv, gfd) {
  const o = vmPtr + FD_TABLE_OFF + gfd * FD_ENTRY_SIZE;
  return {
    fd_type: dv.getInt32(o, true),
    host_fd: dv.getInt32(o + 4, true),
    offset:  Number(dv.getBigInt64(o + 8, true)),
    flags:   dv.getInt32(o + 16, true),
  };
}

function fdWrite(dv, gfd, fd_type, host_fd, offset, flags) {
  const o = vmPtr + FD_TABLE_OFF + gfd * FD_ENTRY_SIZE;
  dv.setInt32(o, fd_type, true);
  dv.setInt32(o + 4, host_fd, true);
  dv.setBigInt64(o + 8, BigInt(offset), true);
  dv.setInt32(o + 16, flags, true);
  dv.setInt32(o + 20, 0, true);
}

function fdClear(dv, gfd) {
  fdWrite(dv, gfd, 0, -1, 0, 0);
}

function fdAlloc(dv) {
  for (let i = 3; i < MAX_FDS; i++) {
    const o = vmPtr + FD_TABLE_OFF + i * FD_ENTRY_SIZE;
    if (dv.getInt32(o, true) === FD_TYPE_NONE) return i;
  }
  return -24; // EMFILE
}

function fdUpdateOffset(dv, gfd, newOffset) {
  const o = vmPtr + FD_TABLE_OFF + gfd * FD_ENTRY_SIZE;
  dv.setBigInt64(o + 8, BigInt(newOffset), true);
}

// Read CWD from VM struct (offset 3680, 256 bytes, null-terminated)
function readCwd() {
  const cwdBytes = new Uint8Array(memory.buffer, vmPtr + 3680, 256);
  let end = 0;
  while (end < 256 && cwdBytes[end] !== 0) end++;
  return new TextDecoder().decode(cwdBytes.subarray(0, end)) || "/";
}

// Resolve path: if relative, prepend CWD
function resolvePath(path) {
  if (!path) return readCwd();
  if (path.startsWith("/")) return path;
  const cwd = readCwd();
  return cwd === "/" ? "/" + path : cwd + "/" + path;
}

// Write return value to x[10] (a0 register at vmPtr + 80)
function setA0(dv, value) {
  dv.setBigInt64(vmPtr + 80, BigInt(value), true);
}

// ============================================================
// processFsRequest — main FS dispatch
// ============================================================
// Syscall numbers (RISC-V Linux)
const SYS_GETCWD = 17, SYS_MKDIRAT = 34, SYS_UNLINKAT = 35,
      SYS_FACCESSAT = 48, SYS_OPENAT = 56, SYS_CLOSE = 57,
      SYS_GETDENTS64 = 61, SYS_LSEEK = 62, SYS_READ = 63,
      SYS_WRITE = 64, SYS_PREAD64 = 67, SYS_PREADV = 69,
      SYS_READLINKAT = 78, SYS_NEWFSTATAT = 79, SYS_FSTAT = 80,
      SYS_UTIMENSAT = 88, SYS_RENAMEAT2 = 276, SYS_STATX = 291;

function processFsRequest() {
  const reqPtr  = X.vm_fs_request_ptr(vmPtr);
  const dv = new DataView(memory.buffer);

  const syscallNr = dv.getInt32(reqPtr, true);
  const gfd       = dv.getInt32(reqPtr + 4, true);  // guest fd or dirfd
  const arg1      = Number(dv.getBigInt64(reqPtr + 8, true));
  const arg2      = Number(dv.getBigInt64(reqPtr + 16, true));
  const arg3      = Number(dv.getBigInt64(reqPtr + 24, true));
  const bufPtr    = dv.getUint32(reqPtr + 32, true); // guest buffer addr
  const bufLen    = dv.getUint32(reqPtr + 36, true);

  // Read null-terminated path (offset +40, max 256 bytes)
  const pathBytes = new Uint8Array(memory.buffer, reqPtr + 40, 256);
  let pe = 0; while (pe < 256 && pathBytes[pe] !== 0) pe++;
  const rawPath = pe > 0 ? new TextDecoder().decode(pathBytes.subarray(0, pe)) : "";

  // Read path2 for rename (offset +296)
  const path2Bytes = new Uint8Array(memory.buffer, reqPtr + 296, 256);
  let pe2 = 0; while (pe2 < 256 && path2Bytes[pe2] !== 0) pe2++;
  const rawPath2 = pe2 > 0 ? new TextDecoder().decode(path2Bytes.subarray(0, pe2)) : "";

  const path = resolvePath(rawPath);
  const path2 = rawPath2 ? resolvePath(rawPath2) : "";

  let result = 0;

  if (trace) {
    const fsNames = {17:'getcwd',34:'mkdirat',35:'unlinkat',48:'faccessat',56:'openat',57:'close',61:'getdents64',62:'lseek',63:'read',64:'write',67:'pread64',69:'preadv',78:'readlinkat',79:'newfstatat',80:'fstat',88:'utimensat',276:'renameat2',291:'statx'};
    const name = fsNames[syscallNr] || `?${syscallNr}`;
    if (syscallNr === SYS_OPENAT || syscallNr === SYS_STATX)
      console.error(`  [fs] ${name} path="${path}"`);
  }

  switch (syscallNr) {

    case SYS_OPENAT: {
      const flags = arg1;
      const mode = arg2;
      const hostFd = memfs.open(path, flags, mode);
      if (hostFd < 0) {
        result = hostFd; // error
      } else {
        // Allocate guest fd
        const newGfd = fdAlloc(dv);
        if (newGfd < 0) {
          memfs.close(hostFd);
          result = newGfd;
        } else {
          // Determine fd type
          const entry = memfs.openFiles.get(hostFd);
          const fdType = (entry && entry.node.isDir) ? FD_TYPE_DIR : FD_TYPE_FILE;
          fdWrite(dv, newGfd, fdType, hostFd, 0, flags);
          result = newGfd;
        }
      }
      break;
    }

    case SYS_CLOSE: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(dv, gfd);
      if (fe.fd_type === FD_TYPE_NONE) { result = -9; break; }
      if (fe.fd_type === FD_TYPE_FILE || fe.fd_type === FD_TYPE_DIR) {
        memfs.close(fe.host_fd);
      }
      fdClear(dv, gfd);
      result = 0;
      break;
    }

    case SYS_LSEEK: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(dv, gfd);
      if (fe.fd_type === FD_TYPE_NONE) { result = -9; break; }
      const offset = arg1;
      const whence = arg2;
      let newOff;
      if (whence === 0) {        // SEEK_SET
        newOff = offset;
      } else if (whence === 1) { // SEEK_CUR
        newOff = fe.offset + offset;
      } else if (whence === 2) { // SEEK_END
        const sz = memfs.lseekSize(fe.host_fd);
        newOff = (sz < 0 ? 0 : sz) + offset;
      } else {
        result = -22; break;
      }
      if (newOff < 0) { result = -22; break; }
      fdUpdateOffset(dv, gfd, newOff);
      result = newOff;
      break;
    }

    case SYS_READ: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(dv, gfd);
      // stdin → drain the pre-seeded --stdin buffer, then EOF
      if (fe.fd_type === FD_TYPE_STDIN) {
        if (stdinPos < stdinData.length) {
          const count = bufLen || arg1;
          const n = Math.min(count, stdinData.length - stdinPos);
          new Uint8Array(memory.buffer).set(stdinData.subarray(stdinPos, stdinPos + n), ramPtr + bufPtr);
          stdinPos += n;
          result = n;
          break;
        }
        result = 0; break; // EOF
      }
      // pipe → EOF (no pipe buffer implemented)
      if (fe.fd_type === FD_TYPE_PIPE) { result = 0; break; }
      if (fe.fd_type !== FD_TYPE_FILE && fe.fd_type !== FD_TYPE_DIR) { result = -9; break; }
      const count = bufLen || arg1;
      const bufPhys = ramPtr + bufPtr;
      const n = memfs.pread(fe.host_fd, memory, bufPhys, count, fe.offset);
      if (n > 0) fdUpdateOffset(dv, gfd, fe.offset + n);
      result = n;
      break;
    }

    case SYS_PREAD64: {
      // pread64: read at explicit offset (arg2) without updating FD cursor
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(dv, gfd);
      if (fe.fd_type !== FD_TYPE_FILE) { result = -9; break; }
      const count = bufLen || arg1;
      const preadOffset = arg2;  // explicit offset from pread64
      const bufPhys = ramPtr + bufPtr;
      const n = memfs.pread(fe.host_fd, memory, bufPhys, count, preadOffset);
      // Do NOT update FD cursor — pread64 semantics
      result = n;
      break;
    }

    case SYS_PREADV: {
      // preadv: read at explicit offset (arg2) without updating FD cursor
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(dv, gfd);
      if (fe.fd_type !== FD_TYPE_FILE) { result = -9; break; }
      const count = bufLen || arg1;
      const preadOffset = arg2;  // explicit offset from preadv
      const bufPhys = ramPtr + bufPtr;
      const n = memfs.pread(fe.host_fd, memory, bufPhys, count, preadOffset);
      // Do NOT update FD cursor — preadv semantics
      result = n;
      break;
    }

    case SYS_WRITE: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(dv, gfd);
      // pipe write: accept and discard (no pipe buffer)
      if (fe.fd_type === FD_TYPE_PIPE) { result = bufLen || arg1; break; }
      if (fe.fd_type !== FD_TYPE_FILE) { result = -9; break; }
      const count = bufLen || arg1;
      const bufPhys = ramPtr + bufPtr;
      // O_APPEND: seek to end before writing
      let writeOff = fe.offset;
      if (fe.flags & 0x400) { // O_APPEND
        const sz = memfs.lseekSize(fe.host_fd);
        if (sz >= 0) writeOff = sz;
      }
      const n = memfs.pwrite(fe.host_fd, memory, bufPhys, count, writeOff);
      if (n > 0) fdUpdateOffset(dv, gfd, writeOff + n);
      result = n;
      break;
    }

    case SYS_GETDENTS64: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(dv, gfd);
      if (fe.fd_type !== FD_TYPE_DIR) { result = -20; break; }
      const bufGuestAddr = arg1;
      const bufSize = arg2;
      const bufPhys = ramPtr + bufGuestAddr;
      const cookie = fe.offset;
      const r = memfs.getdents(fe.host_fd, memory, bufPhys, bufSize, cookie);
      if (typeof r === "object") {
        result = r.bytes;
        fdUpdateOffset(dv, gfd, r.nextCookie);
      } else {
        result = r; // error or 0 (EOF via empty bytes)
      }
      break;
    }

    case SYS_FSTAT: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(dv, gfd);
      const statBufPhys = ramPtr + (arg1 >>> 0);
      // stdin/stdout/stderr → character device stat
      if (fe.fd_type >= FD_TYPE_STDIN && fe.fd_type <= FD_TYPE_STDERR) {
        result = memfs._writeCharDevStat(memory, statBufPhys);
      } else if (fe.fd_type === FD_TYPE_FILE || fe.fd_type === FD_TYPE_DIR) {
        result = memfs.fstat(fe.host_fd, memory, statBufPhys);
      } else {
        result = -9;
      }
      break;
    }

    case SYS_NEWFSTATAT: {
      const statBufPhys = ramPtr + (arg1 >>> 0);
      const flags = arg2;
      result = memfs.stat(path, memory, statBufPhys, flags);
      break;
    }

    case SYS_READLINKAT: {
      const rBufPhys = ramPtr + (arg1 >>> 0);
      const rCount = arg2;
      result = memfs.readlink(path, memory, rBufPhys, rCount);
      break;
    }

    case SYS_MKDIRAT: {
      const mode = arg1;
      result = memfs.mkdir(path, mode);
      break;
    }

    case SYS_UNLINKAT: {
      const flags = arg1;
      result = memfs.unlink(path, flags);
      break;
    }

    case SYS_FACCESSAT: {
      result = memfs.access(path);
      break;
    }

    case SYS_RENAMEAT2: {
      result = memfs.rename(path, path2);
      break;
    }

    case SYS_UTIMENSAT: {
      result = 0; // stub
      break;
    }

    case SYS_STATX: {
      // arg1 = flags, arg2 = statxbuf guest addr
      const statxBufPhys = ramPtr + (arg2 >>> 0);
      const flags = arg1;
      result = memfs.statx(path, memory, statxBufPhys, flags);
      break;
    }

    default: {
      console.error(`  [fs] unhandled syscall ${syscallNr} – returning -38 (ENOSYS)`);
      result = -38;
      break;
    }
  }

  // Write result to a0 register and reset status
  setA0(dv, result);
  dv.setInt32(vmPtr + 528, 0, true); // vm.status = STATUS_OK

  return syscallNr;
}

// ============================================================
// Execution loop
// ============================================================

console.error("--- execution start ---");

const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
const BUDGET   = verbose ? 1 : 100_000;
const MAX_ITER = verbose ? 50000 : 2_000_000;
let totalInsns = 0;
let lastReport = Date.now();

for (let iter = 0; iter < MAX_ITER; iter++) {
  if (verbose) {
    const pc = X.debug_pc(vmPtr);
    const insn = X.debug_read_guest(vmPtr, pc);
    console.error(`  [${iter}] PC=0x${pc.toString(16)} insn=0x${insn.toString(16).padStart(8,"0")} sp=0x${X.debug_reg(vmPtr,2).toString(16)} a7=0x${X.debug_reg(vmPtr,17).toString(16)}`);
  }
  let left;
  try {
    left = X.vm_step(vmPtr, BUDGET);
  } catch (e) {
    console.error(`\nCRASH: ${e.message}`);
    console.error(`  PC=0x${X.debug_pc(vmPtr).toString(16)}  fault_pc=0x${X.debug_fault_pc(vmPtr).toString(16)}`);
    console.error(`  fault_addr=0x${X.debug_fault_addr(vmPtr).toString(16)}  status=${X.debug_status(vmPtr)}`);
    for (let r = 0; r < 32; r += 4) {
      let line = "";
      for (let j = 0; j < 4; j++) {
        const v = X.debug_reg(vmPtr, r + j);
        line += `x${String(r+j).padStart(2)}=0x${v.toString(16).padStart(16,"0")} `;
      }
      console.error("  " + line);
    }
    process.exit(1);
  }
  totalInsns += BUDGET - Math.max(0, left);

  // Progress reporting every 5 seconds
  const now = Date.now();
  if (now - lastReport > 5000) {
    const mips = totalInsns / ((now - lastReport) / 1000) / 1e6;
    const scTotal = Object.values(syscallCounts).reduce((a,b) => a+b, 0);
    const names = {29:'ioctl',56:'openat',63:'read',64:'write',80:'fstat',93:'exit',94:'exit_group',98:'futex',113:'clock_gettime',124:'sched_yield',134:'rt_sigaction',135:'rt_sigprocmask',172:'getpid',178:'gettid',214:'brk',215:'munmap',216:'mremap',222:'mmap',226:'mprotect',233:'madvise',261:'prlimit64',278:'getrandom'};
    const top3 = Object.entries(syscallCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${names[k]||k}:${v}`).join(' ');
    // C1: cumulative block-cache coverage (block insns / all insns)
    const bIns = X.debug_block_insns ? Number(X.debug_block_insns()) : 0;
    const baseIns = X.debug_baseline_insns ? Number(X.debug_baseline_insns()) : 0;
    const cov = (bIns + baseIns) > 0 ? (100 * bIns / (bIns + baseIns)) : 0;
    console.error(`  [progress] ~${(totalInsns/1e6).toFixed(1)}M insns  ${mips.toFixed(0)} MIPS  blockcov=${cov.toFixed(1)}%  syscalls=${scTotal}  top=[${top3}]`);
    lastReport = now;
    totalInsns = 0;
  }

  const status = X.debug_status(vmPtr);

  if (status === 3) {
    const code = X.vm_exit_code(vmPtr);
    const faultPc = X.debug_fault_pc(vmPtr);
    if (faultPc !== 0) {
      console.error(`  [FAULT] PC=0x${X.debug_pc(vmPtr).toString(16)} fault_pc=0x${faultPc.toString(16)}`);
    }
    console.error("--- execution end ---");
    console.error(`Exit code ${code}  (~${totalInsns} insns)`);
    if (X.debug_block_insns) {
      // C1: final block-cache coverage / hit-rate summary
      const bIns = Number(X.debug_block_insns());
      const baseIns = Number(X.debug_baseline_insns());
      const tot = bIns + baseIns;
      const covPct = tot > 0 ? (100 * bIns / tot).toFixed(1) : "0.0";
      console.error(`  [blockstats] coverage=${covPct}%  block_insns=${bIns}  baseline_insns=${baseIns}  hits=${Number(X.debug_block_hits())}  builds=${Number(X.debug_block_builds())}`);
      if (X.debug_jalr_execs) {
        const jalr = Number(X.debug_jalr_execs());
        const jalf = Number(X.debug_jalfwd_execs());
        const brf = Number(X.debug_brfwd_execs());
        console.error(`  [cflow] baseline jalr=${jalr}  jal_fwd=${jalf}  branch_fwd=${brf}  (these never enter a block today)`);
      }
    }
    if (trace) {
      const names = {17:'getcwd',29:'ioctl',25:'fcntl',48:'faccessat',56:'openat',57:'close',61:'getdents64',62:'lseek',63:'read',64:'write',65:'readv',66:'writev',78:'readlinkat',79:'fstatat',80:'fstat',93:'exit',94:'exit_group',96:'set_tid_addr',98:'futex',99:'set_robust_list',101:'nanosleep',113:'clock_gettime',114:'clock_getres',123:'sched_getaff',124:'sched_yield',129:'kill',130:'tkill',131:'tgkill',132:'sigaltstack',134:'rt_sigaction',135:'rt_sigprocmask',153:'times',160:'uname',166:'umask',167:'prctl',172:'getpid',174:'getuid',175:'geteuid',176:'getgid',177:'getegid',178:'gettid',179:'sysinfo',214:'brk',215:'munmap',220:'clone',222:'mmap',226:'mprotect',233:'madvise',261:'prlimit64',278:'getrandom',291:'statx',293:'rseq'};
      const total = Object.values(syscallCounts).reduce((a,b) => a+b, 0);
      const summary = Object.entries(syscallCounts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${names[k]||k}×${v}`).join(' ');
      console.error(`  [syscall total] ${total}`);
      console.error(`  [syscall summary] ${summary}`);
      console.error(`  [last 50] ${syscallTrace.slice(-50).map(n=>names[n]||n).join(', ')}`);
    }
    process.exit(code);
  }

  if (status === 6) {
    // STATUS_FS_PENDING – filesystem request from guest
    const nr = processFsRequest();
    if (verbose) {
      const dv = new DataView(memory.buffer);
      const a0 = Number(dv.getBigInt64(vmPtr + 80, true));
      console.error(`  [fs] syscall ${nr} → ${a0}`);
    }
    continue;
  }

  if (status === 7) {
    // STATUS_EPOLL_BLOCKED – VM is blocked in epoll_wait with a listening socket.
    // In CLI mode, set a0 = -EINTR to let libuv retry. This creates a busy loop
    // but keeps the server alive for testing purposes.
    const dv = new DataView(memory.buffer);
    dv.setBigInt64(vmPtr + 80, BigInt(-4), true); // a0 = -EINTR
    dv.setInt32(vmPtr + 528, 0, true); // STATUS_OK
    continue;
  }

  if (status !== 0 && status !== 18) {
    console.error(`Unexpected status ${status} at PC=0x${X.debug_pc(vmPtr).toString(16)}`);
    console.error(`  fault_pc=0x${X.debug_fault_pc(vmPtr).toString(16)}  fault_addr=0x${X.debug_fault_addr(vmPtr).toString(16)}`);
    for (let r = 0; r < 32; r += 4) {
      let line = "";
      for (let j = 0; j < 4; j++) {
        const v = X.debug_reg(vmPtr, r + j);
        line += `x${String(r+j).padStart(2)}=0x${v.toString(16).padStart(16,"0")} `;
      }
      console.error("  " + line);
    }
    process.exit(1);
  }
}

console.error(`Max iterations (${MAX_ITER}) reached`);
process.exit(1);
