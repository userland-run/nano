/**
 * NanoVM Browser Module — high-level API for the NanoVM RISC-V emulator.
 *
 * Usage:
 *   import { NanoVM } from "@container/nanovm.mjs";
 *   const vm = await NanoVM.create({ ramMB: 512, wasm: "/nano.wasm" });
 *   vm.addFile("/hello.js", 'console.log("Hello!")');
 *   const { exitCode, stdout } = await vm.node("/hello.js");
 */

import { MemFS } from "./memfs.mjs";

// ============================================================
// VM struct constants (must match src/types.rs)
// ============================================================

const VM_STRUCT_SIZE = 12680;

// FD types
const FD_TYPE_NONE    = 0;
const FD_TYPE_STDIN   = 1;
const FD_TYPE_STDOUT  = 2;
const FD_TYPE_STDERR  = 3;
const FD_TYPE_FILE    = 4;
const FD_TYPE_DIR     = 5;
const FD_TYPE_PIPE    = 6;
const FD_TYPE_EPOLL   = 7;
const FD_TYPE_EVENTFD = 8;

// VM struct offsets
const FD_TABLE_OFF  = 600;
const FD_ENTRY_SIZE = 24;
const MAX_FDS       = 64;

// Status codes
const STATUS_OK         = 0;
const STATUS_FAULT      = 3;
const STATUS_FS_PENDING = 6;
const STATUS_RUNNING    = 18;

// Syscall numbers (RISC-V Linux)
const SYS_GETCWD     = 17;
const SYS_MKDIRAT    = 34;
const SYS_UNLINKAT   = 35;
const SYS_FACCESSAT  = 48;
const SYS_OPENAT     = 56;
const SYS_CLOSE      = 57;
const SYS_GETDENTS64 = 61;
const SYS_LSEEK      = 62;
const SYS_READ       = 63;
const SYS_WRITE      = 64;
const SYS_PREAD64    = 67;
const SYS_PREADV     = 69;
const SYS_READLINKAT = 78;
const SYS_NEWFSTATAT = 79;
const SYS_FSTAT      = 80;
const SYS_UTIMENSAT  = 88;
const SYS_RENAMEAT2  = 276;
const SYS_STATX      = 291;

// ============================================================
// NanoVM class
// ============================================================

class NanoVM {
  constructor() {
    this._exports = null;
    this._memory = null;
    this._memfs = null;
    this._vmPtr = 0;
    this._ramPtr = 0;
    this._ramSize = 0;
    this._ramMB = 0;
    this._busyboxElf = null;
    this._nodeElf = null;
    this._stdout = "";
    this._onStdout = null;
    this._virtualServer = null;
    this._scratchPtr = 0; // WASM linear memory scratch buffer for virtual server
  }

  /**
   * Create a new NanoVM instance.
   * @param {Object} opts
   * @param {number} opts.ramMB - RAM size in megabytes (default 512)
   * @param {string} opts.wasm - URL to the nano.wasm file
   * @param {string} [opts.busyboxUrl] - URL to busybox ELF (if not bundled)
   * @param {string} [opts.nodeUrl] - URL to node ELF (if not bundled)
   */
  static async create(opts = {}) {
    const vm = new NanoVM();
    await vm._init(opts);
    return vm;
  }

  async _init(opts) {
    const { ramMB = 512, wasm, busyboxUrl, nodeUrl } = opts;
    this._ramMB = ramMB;

    // Fetch WASM binary
    const wasmUrl = typeof wasm === "string" ? wasm : "/nano.wasm";
    const wasmResponse = await fetch(wasmUrl);
    if (!wasmResponse.ok) throw new Error(`Failed to fetch WASM: ${wasmResponse.status}`);
    const wasmBytes = await wasmResponse.arrayBuffer();

    // Create shared memory
    const ramPages = Math.floor((ramMB * 1024 * 1024) / 65536);
    const maxPages = 32768; // 2GB hard max
    this._memory = new WebAssembly.Memory({
      initial: Math.min(ramPages, maxPages),
      maximum: maxPages,
      shared: true,
    });

    // WASM imports
    const self = this;
    const imports = {
      env: {
        memory: this._memory,
        abort_js() { throw new Error("VM abort"); },
        debug_log() {},
        emscripten_random() { return Math.random(); },
        emscripten_date_now() { return Date.now(); },
        console_write(fd, ptr, len) {
          const bytes = new Uint8Array(self._memory.buffer, ptr, len).slice();
          const text = new TextDecoder().decode(bytes);
          self._stdout += text;
          if (self._onStdout) self._onStdout(text);
        },
      },
    };

    // Instantiate WASM
    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    this._exports = instance.exports;

    const X = this._exports;
    const RAM_SIZE = ramMB * 1024 * 1024;

    // Create VM
    this._vmPtr = X.vm_create(RAM_SIZE);
    if (this._vmPtr === 0) throw new Error("vm_create failed");

    this._ramPtr = X.vm_ram_ptr(this._vmPtr);
    this._ramSize = X.vm_ram_size(this._vmPtr);

    // Initialize MemFS with standard directories and files
    this._memfs = new MemFS();
    this._seedFS();

    // Load bundled ELFs if available (decompresses gzipped data)
    await this._loadBundledElfs();

    // Fetch external ELFs if needed and URLs provided
    if (!this._busyboxElf && busyboxUrl) {
      const resp = await fetch(busyboxUrl);
      if (resp.ok) this._busyboxElf = new Uint8Array(await resp.arrayBuffer());
    }
    if (!this._nodeElf && nodeUrl) {
      const resp = await fetch(nodeUrl);
      if (resp.ok) this._nodeElf = new Uint8Array(await resp.arrayBuffer());
    }

    // Allocate a scratch buffer in WASM memory for virtual server I/O (32KB)
    if (X.malloc) {
      this._scratchPtr = X.malloc(32768);
    }

    // Virtual server — bridges SW HTTP requests into VM sockets
    this._pendingConnections = []; // { connId, resolve, responseChunks }
    this._virtualServer = new VirtualServer(this);
  }

  _seedFS() {
    const m = this._memfs;
    const ramMB = this._ramMB;
    const ramSize = this._ramSize;

    m.createDir("/bin");
    m.createExecutable("/bin/busybox", "");
    m.createSymlink("/bin/sh", "busybox");
    m.createDir("/dev");
    m.createFile("/dev/null", "");
    m.createDir("/etc");
    m.createFile("/etc/passwd", "root:x:0:0:root:/root:/bin/sh\n");
    m.createFile("/etc/group", "root:x:0:\n");
    m.createFile("/etc/hostname", "nanovm\n");
    m.createDir("/etc/ssl");
    m.createFile("/etc/ssl/openssl.cnf", "[openssl_init]\n");
    m.createDir("/home");
    m.createDir("/proc/self");
    m.createSymlink("/proc/self/exe", "/bin/busybox");
    m.createFile("/proc/cpuinfo", [
      "processor\t: 0", "hart\t\t: 0", "isa\t\t: rv64imafdc", "mmu\t\t: sv39", ""
    ].join("\n"));
    m.createFile("/proc/version_signature", "NanoVM 1.0\n");
    m.createFile("/proc/self/cgroup", "0::/\n");
    const totalPages = Math.floor(ramSize / 4096);
    const usedPages = Math.floor(totalPages * 0.3);
    m.createFile("/proc/self/statm",
      `${totalPages} ${usedPages} 0 ${Math.floor(usedPages / 2)} 0 ${Math.floor(usedPages / 2)} 0\n`);
    m.createDir("/sys/fs/cgroup");
    m.createFile("/sys/fs/cgroup/memory.max", "max\n");
    m.createFile("/sys/fs/cgroup/memory.high", "max\n");
    m.createFile("/proc/meminfo", [
      `MemTotal:       ${ramMB * 1024} kB`,
      `MemFree:        ${Math.floor(ramMB * 1024 * 0.8)} kB`,
      `MemAvailable:   ${Math.floor(ramMB * 1024 * 0.7)} kB`,
      "Buffers:               0 kB", "Cached:                0 kB",
      "SwapTotal:             0 kB", "SwapFree:              0 kB", ""
    ].join("\n"));
    m.createDir("/root");
    m.createDir("/sbin");
    m.createDir("/tmp");
    m.createDir("/var");
    m.createDir("/test");
    m.createFile("/test/hello.txt", "Hello from NanoVM VFS!\n");
    m.createFile("/test/nums.txt", "1\n2\n3\n4\n5\n");
  }

  async _gunzip(compressed) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    const chunks = [];
    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();
    writer.write(compressed);
    writer.close();
    await readAll;
    const totalLen = chunks.reduce((a, c) => a + c.length, 0);
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const chunk of chunks) {
      result.set(chunk, off);
      off += chunk.length;
    }
    return result;
  }

  async _loadBundledElfs() {
    const X = this._exports;

    // Bundled busybox (gzip-compressed)
    const bbPtr = typeof X.vm_bundled_busybox_ptr === "function" ? X.vm_bundled_busybox_ptr() : 0;
    const bbSize = typeof X.vm_bundled_busybox_size === "function" ? X.vm_bundled_busybox_size() : 0;
    if (bbPtr > 0 && bbSize > 0) {
      const compressed = new Uint8Array(this._memory.buffer, bbPtr, bbSize).slice();
      this._busyboxElf = await this._gunzip(compressed);
    }

    // Bundled node (gzip-compressed)
    const nodePtr = typeof X.vm_bundled_node_ptr === "function" ? X.vm_bundled_node_ptr() : 0;
    const nodeSize = typeof X.vm_bundled_node_size === "function" ? X.vm_bundled_node_size() : 0;
    if (nodePtr > 0 && nodeSize > 0) {
      const compressed = new Uint8Array(this._memory.buffer, nodePtr, nodeSize).slice();
      this._nodeElf = await this._gunzip(compressed);
    }

    // Generic bundled ELF (fallback for both — also gzip-compressed)
    const elfPtr = typeof X.vm_bundled_elf_ptr === "function" ? X.vm_bundled_elf_ptr() : 0;
    const elfSize = typeof X.vm_bundled_elf_size === "function" ? X.vm_bundled_elf_size() : 0;
    if (elfPtr > 0 && elfSize > 0) {
      const compressed = new Uint8Array(this._memory.buffer, elfPtr, elfSize).slice();
      const elfBytes = await this._gunzip(compressed);
      if (!this._busyboxElf) this._busyboxElf = elfBytes;
      if (!this._nodeElf) this._nodeElf = elfBytes;
    }
  }

  // ============================================================
  // Public API — File operations
  // ============================================================

  addFile(path, content) {
    this._memfs.createFile(path, content);
  }

  readFileString(path) {
    const node = this._memfs.resolve(path);
    if (!node || !node.isFile) return null;
    return new TextDecoder().decode(node.data || new Uint8Array(0));
  }

  listDir(path) {
    const node = this._memfs.resolve(path);
    if (!node || !node.isDir) return null;
    const entries = [];
    for (const [name, child] of node.children) {
      entries.push({
        name,
        type: child.isDir ? "dir" : child.isSymlink ? "symlink" : "file",
        size: child.size,
      });
    }
    return entries;
  }

  async loadTarGz(buffer) {
    await this._memfs.loadTarGz(buffer);
  }

  // ============================================================
  // Public API — Execution
  // ============================================================

  /**
   * Run a busybox command.
   * @param {string} command - e.g. "echo Hello" or "ls /tmp"
   * @param {Object} [opts]
   * @param {function} [opts.onStdout] - callback for stdout chunks
   * @param {number} [opts.maxSteps] - max instructions (default 2M)
   * @returns {Promise<{exitCode: number, stdout: string}>}
   */
  async run(command, opts = {}) {
    if (!this._busyboxElf) throw new Error("No busybox ELF loaded");
    const argv = command.trim().split(/\s+/);
    return this._execute(this._busyboxElf, argv, [], opts);
  }

  /**
   * Run a node command.
   * @param {...(string|Object)} argsAndOpts - args followed by optional opts object
   * @returns {Promise<{exitCode: number, stdout: string}>}
   */
  async node(...argsAndOpts) {
    if (!this._nodeElf) throw new Error("No node ELF loaded");
    let opts = {};
    let args;
    const last = argsAndOpts[argsAndOpts.length - 1];
    if (last && typeof last === "object" && !Array.isArray(last)) {
      opts = last;
      args = ["node", ...argsAndOpts.slice(0, -1)];
    } else {
      args = ["node", ...argsAndOpts];
    }
    const envVars = ["UV_THREADPOOL_SIZE=0"];
    return this._execute(this._nodeElf, args, envVars, opts);
  }

  destroy() {
    this._memfs = null;
    this._exports = null;
    this._memory = null;
    this._busyboxElf = null;
    this._nodeElf = null;
    this._pendingConnections = [];
    this._virtualServer = null;
  }

  // Getters for runtime.ts compatibility
  get exports() { return this._exports; }
  get memory() { return this._memory; }
  get virtualServer() { return this._virtualServer; }

  // ============================================================
  // Internal — Execution loop
  // ============================================================

  async _execute(elfBytes, argv, extraEnv, opts = {}) {
    const { onStdout, maxSteps = 2_000_000 } = opts;

    this._stdout = "";
    this._onStdout = onStdout || null;

    // Reset VM state for a clean run
    this._resetVM();

    // Copy ELF into guest RAM at offset 0
    const mem = new Uint8Array(this._memory.buffer);
    mem.set(elfBytes, this._ramPtr);

    // Load ELF
    const X = this._exports;
    const loadRc = X.vm_load_elf(this._vmPtr, 0, elfBytes.length);
    if (loadRc !== 0) throw new Error(`vm_load_elf failed: ${loadRc}`);

    // Set up argv/envp on the stack
    this._setupArgv(argv, extraEnv);

    // Execution loop with periodic yielding
    const BUDGET = 10_000;
    const maxIter = Math.ceil(maxSteps / BUDGET);

    for (let iter = 0; iter < maxIter; iter++) {
      try {
        X.vm_step(this._vmPtr, BUDGET);
      } catch (e) {
        return { exitCode: -1, stdout: this._stdout };
      }

      const status = X.debug_status(this._vmPtr);

      if (status === STATUS_FAULT) {
        const code = X.vm_exit_code(this._vmPtr);
        return { exitCode: code, stdout: this._stdout };
      }

      if (status === STATUS_FS_PENDING) {
        this._processFsRequest();
        continue;
      }

      if (status !== STATUS_OK && status !== STATUS_RUNNING) {
        return { exitCode: -1, stdout: this._stdout };
      }

      // Poll pending virtual connections for response data
      this._pollConnections();

      // Yield to event loop every 50 iterations (~500K instructions)
      if (iter > 0 && iter % 50 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    return { exitCode: -1, stdout: this._stdout };
  }

  _pollConnections() {
    const X = this._exports;
    if (!X.vm_read_response || this._pendingConnections.length === 0) return;
    if (!this._scratchPtr) return;

    const BUF_SIZE = 16384;
    const scratchPtr = this._scratchPtr;

    const pending = this._pendingConnections;
    let i = pending.length;
    while (i-- > 0) {
      const conn = pending[i];
      const n = X.vm_read_response(this._vmPtr, conn.connId, scratchPtr, BUF_SIZE);
      if (n > 0) {
        // Copy response bytes from WASM memory
        const bytes = new Uint8Array(this._memory.buffer, scratchPtr, n);
        conn.responseChunks.push(new Uint8Array(bytes));
      } else if (n === -1) {
        // Connection closed — response is complete
        X.vm_close_connection(this._vmPtr, conn.connId);
        const total = conn.responseChunks.reduce((s, c) => s + c.length, 0);
        const result = new Uint8Array(total);
        let off = 0;
        for (const chunk of conn.responseChunks) {
          result.set(chunk, off);
          off += chunk.length;
        }
        conn.resolve(result);
        pending.splice(i, 1);
      }
      // n === 0 means still waiting — keep polling
    }
  }

  _resetVM() {
    const dv = new DataView(this._memory.buffer);
    const v = this._vmPtr;

    // Zero entire VM struct
    new Uint8Array(this._memory.buffer, v, VM_STRUCT_SIZE).fill(0);

    // brk_start = u64::MAX sentinel
    dv.setBigUint64(v + 560, 0xFFFFFFFFFFFFFFFFn, true);

    // stack_limit = RAM size
    dv.setBigUint64(v + 592, BigInt(this._ramSize), true);

    // fd_table[0] = stdin
    dv.setInt32(v + FD_TABLE_OFF + 0 * FD_ENTRY_SIZE, FD_TYPE_STDIN, true);
    dv.setInt32(v + FD_TABLE_OFF + 0 * FD_ENTRY_SIZE + 4, 0, true);
    // fd_table[1] = stdout
    dv.setInt32(v + FD_TABLE_OFF + 1 * FD_ENTRY_SIZE, FD_TYPE_STDOUT, true);
    dv.setInt32(v + FD_TABLE_OFF + 1 * FD_ENTRY_SIZE + 4, 1, true);
    // fd_table[2] = stderr
    dv.setInt32(v + FD_TABLE_OFF + 2 * FD_ENTRY_SIZE, FD_TYPE_STDERR, true);
    dv.setInt32(v + FD_TABLE_OFF + 2 * FD_ENTRY_SIZE + 4, 2, true);

    // fd_count = 3
    dv.setInt32(v + 2136, 3, true);

    // fd_configs (stdin/stdout/stderr)
    dv.setInt32(v + 2144, FD_TYPE_STDIN, true);
    dv.setInt32(v + 2144 + 24, FD_TYPE_STDOUT, true);
    dv.setInt32(v + 2144 + 48, FD_TYPE_STDERR, true);

    // cwd = "/"
    new Uint8Array(this._memory.buffer)[v + 3680] = 0x2F;

    // tid = 1
    dv.setInt32(v + 3936, 1, true);
    // thread_count = 1
    dv.setInt32(v + 3380, 1, true);
    // thread_tids[0] = 1
    dv.setInt32(v + 3440, 1, true);
    // run_status = STATUS_RUNNING
    dv.setInt32(v + 3952, STATUS_RUNNING, true);

    // ram_base, ram_size, heap_ptr
    dv.setUint32(v + 3960, this._ramPtr, true);
    dv.setUint32(v + 3964, this._ramSize, true);
    dv.setUint32(v + 3968, this._ramPtr, true);
  }

  _setupArgv(argv, envVars = []) {
    const mem = new Uint8Array(this._memory.buffer);
    const dv = new DataView(this._memory.buffer);
    const enc = new TextEncoder();
    const v = this._vmPtr;
    const ramPtr = this._ramPtr;

    // Default env vars
    const env = [
      "HOME=/root",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TERM=xterm",
      ...envVars,
    ];

    // Write arg strings at top of stack string area
    let strGuest = this._ramSize - 4096 - 64;
    const argAddrs = [];
    for (const arg of argv) {
      const bytes = enc.encode(arg + "\0");
      argAddrs.push(strGuest);
      mem.set(bytes, ramPtr + strGuest);
      strGuest += bytes.length;
    }

    // Write env strings
    const envAddrs = [];
    for (const e of env) {
      const bytes = enc.encode(e + "\0");
      envAddrs.push(strGuest);
      mem.set(bytes, ramPtr + strGuest);
      strGuest += bytes.length;
    }

    // Read current sp from x[2] (register 2 at vmPtr + 16)
    const sp = Number(dv.getBigUint64(v + 16, true));

    // Read auxv from existing stack (layout: [argc=1][argv0][NULL][NULL][auxv...])
    const auxvStart = sp + 32;
    const auxvPairs = [];
    let auxOff = auxvStart;
    for (let i = 0; i < 16; i++) {
      const atype = Number(dv.getBigUint64(ramPtr + auxOff, true));
      const aval = dv.getBigUint64(ramPtr + auxOff + 8, true);
      auxvPairs.push([atype, aval]);
      auxOff += 16;
      if (atype === 0) break;
    }

    // Rebuild stack at a lower address
    const argc = argv.length;
    const envc = envAddrs.length;
    const stackDataSize = 8 + (argc + 1) * 8 + (envc + 1) * 8 + auxvPairs.length * 16;
    const newSp = ((sp - 512 - stackDataSize) & ~0xF) >>> 0;

    let pos = newSp;
    dv.setBigUint64(ramPtr + pos, BigInt(argc), true); pos += 8;
    for (const addr of argAddrs) {
      dv.setBigUint64(ramPtr + pos, BigInt(addr), true); pos += 8;
    }
    dv.setBigUint64(ramPtr + pos, 0n, true); pos += 8; // argv NULL
    for (const addr of envAddrs) {
      dv.setBigUint64(ramPtr + pos, BigInt(addr), true); pos += 8;
    }
    dv.setBigUint64(ramPtr + pos, 0n, true); pos += 8; // envp NULL
    for (const [atype, aval] of auxvPairs) {
      dv.setBigUint64(ramPtr + pos, BigInt(atype), true); pos += 8;
      dv.setBigUint64(ramPtr + pos, aval, true); pos += 8;
    }

    // Update x[2] = new sp
    dv.setBigUint64(v + 16, BigInt(newSp), true);
  }

  // ============================================================
  // Internal — FS request handling
  // ============================================================

  _readCwd() {
    const cwdBytes = new Uint8Array(this._memory.buffer, this._vmPtr + 3680, 256);
    let end = 0;
    while (end < 256 && cwdBytes[end] !== 0) end++;
    return new TextDecoder().decode(cwdBytes.slice(0, end)) || "/";
  }

  _resolvePath(path) {
    if (!path) return this._readCwd();
    if (path.startsWith("/")) return path;
    const cwd = this._readCwd();
    return cwd === "/" ? "/" + path : cwd + "/" + path;
  }

  // FD table helpers

  _fdRead(dv, gfd) {
    const o = this._vmPtr + FD_TABLE_OFF + gfd * FD_ENTRY_SIZE;
    return {
      fd_type: dv.getInt32(o, true),
      host_fd: dv.getInt32(o + 4, true),
      offset:  Number(dv.getBigInt64(o + 8, true)),
      flags:   dv.getInt32(o + 16, true),
    };
  }

  _fdWrite(dv, gfd, fd_type, host_fd, offset, flags) {
    const o = this._vmPtr + FD_TABLE_OFF + gfd * FD_ENTRY_SIZE;
    dv.setInt32(o, fd_type, true);
    dv.setInt32(o + 4, host_fd, true);
    dv.setBigInt64(o + 8, BigInt(offset), true);
    dv.setInt32(o + 16, flags, true);
    dv.setInt32(o + 20, 0, true);
  }

  _fdClear(dv, gfd) {
    this._fdWrite(dv, gfd, 0, -1, 0, 0);
  }

  _fdAlloc(dv) {
    for (let i = 3; i < MAX_FDS; i++) {
      const o = this._vmPtr + FD_TABLE_OFF + i * FD_ENTRY_SIZE;
      if (dv.getInt32(o, true) === FD_TYPE_NONE) return i;
    }
    return -24; // EMFILE
  }

  _fdUpdateOffset(dv, gfd, newOffset) {
    const o = this._vmPtr + FD_TABLE_OFF + gfd * FD_ENTRY_SIZE;
    dv.setBigInt64(o + 8, BigInt(newOffset), true);
  }

  _setA0(dv, value) {
    dv.setBigInt64(this._vmPtr + 80, BigInt(value), true);
  }

  _processFsRequest() {
    const X = this._exports;
    const reqPtr = X.vm_fs_request_ptr(this._vmPtr);
    const dv = new DataView(this._memory.buffer);
    const ramPtr = this._ramPtr;
    const memfs = this._memfs;

    const syscallNr = dv.getInt32(reqPtr, true);
    const gfd       = dv.getInt32(reqPtr + 4, true);
    const arg1      = Number(dv.getBigInt64(reqPtr + 8, true));
    const arg2      = Number(dv.getBigInt64(reqPtr + 16, true));
    const arg3      = Number(dv.getBigInt64(reqPtr + 24, true));
    const bufPtr    = dv.getUint32(reqPtr + 32, true);
    const bufLen    = dv.getUint32(reqPtr + 36, true);

    // Read null-terminated path (offset +40, max 256 bytes)
    const pathBytes = new Uint8Array(this._memory.buffer, reqPtr + 40, 256);
    let pe = 0; while (pe < 256 && pathBytes[pe] !== 0) pe++;
    const rawPath = pe > 0 ? new TextDecoder().decode(pathBytes.slice(0, pe)) : "";

    // Read path2 for rename (offset +296, max 256 bytes)
    const path2Bytes = new Uint8Array(this._memory.buffer, reqPtr + 296, 256);
    let pe2 = 0; while (pe2 < 256 && path2Bytes[pe2] !== 0) pe2++;
    const rawPath2 = pe2 > 0 ? new TextDecoder().decode(path2Bytes.slice(0, pe2)) : "";

    const path = this._resolvePath(rawPath);
    const path2 = rawPath2 ? this._resolvePath(rawPath2) : "";

    let result = 0;

    switch (syscallNr) {

      case SYS_OPENAT: {
        const flags = arg1;
        const mode = arg2;
        const hostFd = memfs.open(path, flags, mode);
        if (hostFd < 0) {
          result = hostFd;
        } else {
          const newGfd = this._fdAlloc(dv);
          if (newGfd < 0) {
            memfs.close(hostFd);
            result = newGfd;
          } else {
            const entry = memfs.openFiles.get(hostFd);
            const fdType = (entry && entry.node.isDir) ? FD_TYPE_DIR : FD_TYPE_FILE;
            this._fdWrite(dv, newGfd, fdType, hostFd, 0, flags);
            result = newGfd;
          }
        }
        break;
      }

      case SYS_CLOSE: {
        if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
        const fe = this._fdRead(dv, gfd);
        if (fe.fd_type === FD_TYPE_NONE) { result = -9; break; }
        if (fe.fd_type === FD_TYPE_FILE || fe.fd_type === FD_TYPE_DIR) {
          memfs.close(fe.host_fd);
        }
        this._fdClear(dv, gfd);
        result = 0;
        break;
      }

      case SYS_LSEEK: {
        if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
        const fe = this._fdRead(dv, gfd);
        if (fe.fd_type === FD_TYPE_NONE) { result = -9; break; }
        const offset = arg1;
        const whence = arg2;
        let newOff;
        if (whence === 0) newOff = offset;                                     // SEEK_SET
        else if (whence === 1) newOff = fe.offset + offset;                    // SEEK_CUR
        else if (whence === 2) {                                               // SEEK_END
          const sz = memfs.lseekSize(fe.host_fd);
          newOff = (sz < 0 ? 0 : sz) + offset;
        } else { result = -22; break; }
        if (newOff < 0) { result = -22; break; }
        this._fdUpdateOffset(dv, gfd, newOff);
        result = newOff;
        break;
      }

      case SYS_READ: {
        if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
        const fe = this._fdRead(dv, gfd);
        if (fe.fd_type === FD_TYPE_STDIN) { result = 0; break; }
        if (fe.fd_type === FD_TYPE_PIPE) { result = 0; break; }
        if (fe.fd_type !== FD_TYPE_FILE && fe.fd_type !== FD_TYPE_DIR) { result = -9; break; }
        const count = bufLen || arg1;
        const bufPhys = ramPtr + bufPtr;
        const n = memfs.pread(fe.host_fd, this._memory, bufPhys, count, fe.offset);
        if (n > 0) this._fdUpdateOffset(dv, gfd, fe.offset + n);
        result = n;
        break;
      }

      case SYS_PREAD64: {
        if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
        const fe = this._fdRead(dv, gfd);
        if (fe.fd_type !== FD_TYPE_FILE) { result = -9; break; }
        const count = bufLen || arg1;
        const preadOffset = arg2;
        const bufPhys = ramPtr + bufPtr;
        const n = memfs.pread(fe.host_fd, this._memory, bufPhys, count, preadOffset);
        result = n;
        break;
      }

      case SYS_PREADV: {
        if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
        const fe = this._fdRead(dv, gfd);
        if (fe.fd_type !== FD_TYPE_FILE) { result = -9; break; }
        const count = bufLen || arg1;
        const preadOffset = arg2;
        const bufPhys = ramPtr + bufPtr;
        const n = memfs.pread(fe.host_fd, this._memory, bufPhys, count, preadOffset);
        result = n;
        break;
      }

      case SYS_WRITE: {
        if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
        const fe = this._fdRead(dv, gfd);
        if (fe.fd_type === FD_TYPE_PIPE) { result = bufLen || arg1; break; }
        if (fe.fd_type !== FD_TYPE_FILE) { result = -9; break; }
        const count = bufLen || arg1;
        const bufPhys = ramPtr + bufPtr;
        let writeOff = fe.offset;
        if (fe.flags & 0x400) { // O_APPEND
          const sz = memfs.lseekSize(fe.host_fd);
          if (sz >= 0) writeOff = sz;
        }
        const n = memfs.pwrite(fe.host_fd, this._memory, bufPhys, count, writeOff);
        if (n > 0) this._fdUpdateOffset(dv, gfd, writeOff + n);
        result = n;
        break;
      }

      case SYS_GETDENTS64: {
        if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
        const fe = this._fdRead(dv, gfd);
        if (fe.fd_type !== FD_TYPE_DIR) { result = -20; break; }
        const bufGuestAddr = arg1;
        const bufSize = arg2;
        const bufPhys = ramPtr + bufGuestAddr;
        const cookie = fe.offset;
        const r = memfs.getdents(fe.host_fd, this._memory, bufPhys, bufSize, cookie);
        if (typeof r === "object") {
          result = r.bytes;
          this._fdUpdateOffset(dv, gfd, r.nextCookie);
        } else {
          result = r;
        }
        break;
      }

      case SYS_FSTAT: {
        if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
        const fe = this._fdRead(dv, gfd);
        const statBufPhys = ramPtr + (arg1 >>> 0);
        if (fe.fd_type >= FD_TYPE_STDIN && fe.fd_type <= FD_TYPE_STDERR) {
          result = memfs._writeCharDevStat(this._memory, statBufPhys);
        } else if (fe.fd_type === FD_TYPE_FILE || fe.fd_type === FD_TYPE_DIR) {
          result = memfs.fstat(fe.host_fd, this._memory, statBufPhys);
        } else {
          result = -9;
        }
        break;
      }

      case SYS_NEWFSTATAT: {
        const statBufPhys = ramPtr + (arg1 >>> 0);
        const flags = arg2;
        result = memfs.stat(path, this._memory, statBufPhys, flags);
        break;
      }

      case SYS_READLINKAT: {
        const rBufPhys = ramPtr + (arg1 >>> 0);
        const rCount = arg2;
        result = memfs.readlink(path, this._memory, rBufPhys, rCount);
        break;
      }

      case SYS_MKDIRAT: {
        result = memfs.mkdir(path, arg1);
        break;
      }

      case SYS_UNLINKAT: {
        result = memfs.unlink(path, arg1);
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
        const statxBufPhys = ramPtr + (arg2 >>> 0);
        const flags = arg1;
        result = memfs.statx(path, this._memory, statxBufPhys, flags);
        break;
      }

      default: {
        console.warn(`[NanoVM] unhandled FS syscall ${syscallNr}`);
        result = -38; // ENOSYS
        break;
      }
    }

    // Write result to a0 register and reset status
    this._setA0(dv, result);
    dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
  }
}

// ============================================================
// VirtualServer — bridges Service Worker HTTP to VM sockets
// ============================================================

class VirtualServer {
  constructor(vm) {
    this._vm = vm;
  }

  /**
   * Inject an HTTP connection into the VM's socket layer.
   * Called by sw-bridge when the Service Worker intercepts a request
   * from the preview iframe.
   *
   * @param {number} port - Target port (e.g. 8080)
   * @param {string} httpRequest - Raw HTTP request string (e.g. "GET / HTTP/1.1\r\n...")
   * @returns {Promise<Uint8Array>} Raw HTTP response bytes
   */
  async injectConnection(port, httpRequest) {
    const vm = this._vm;
    const X = vm._exports;

    if (!X.vm_inject_connection) {
      throw new Error("WASM missing vm_inject_connection export");
    }

    // Convert raw HTTP request string to bytes
    const requestBytes = new TextEncoder().encode(httpRequest);

    if (!vm._scratchPtr) {
      throw new Error("Scratch buffer not allocated");
    }

    // Write request bytes into the allocated scratch buffer
    const mem = new Uint8Array(vm._memory.buffer);
    mem.set(requestBytes, vm._scratchPtr);

    // Inject the connection
    const connId = X.vm_inject_connection(
      vm._vmPtr,
      port,
      vm._scratchPtr,
      requestBytes.length
    );

    if (connId < 0) {
      throw new Error(`inject_connection failed: ${connId} (no server on port ${port}?)`);
    }

    // Return a promise that resolves when the response is complete
    return new Promise((resolve) => {
      vm._pendingConnections.push({
        connId,
        resolve,
        responseChunks: [],
      });
    });
  }
}

export { NanoVM, MemFS };
