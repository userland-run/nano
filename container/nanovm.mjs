// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

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
const STATUS_OK             = 0;
const STATUS_FAULT          = 3;
const STATUS_FS_PENDING     = 6;
const STATUS_EPOLL_BLOCKED  = 7;
const STATUS_RUNNING        = 18;

// Syscall numbers (RISC-V Linux)
const SYS_GETCWD     = 17;
const SYS_CLONE      = 220;
const SYS_EXECVE     = 221;
const SYS_WAIT4      = 260;
const SYS_MKDIRAT    = 34;
const SYS_UNLINKAT   = 35;
const SYS_FACCESSAT  = 48;
const SYS_OPENAT     = 56;
const SYS_CLOSE      = 57;
const SYS_GETDENTS64 = 61;
const SYS_LSEEK      = 62;
const SYS_READ       = 63;
const SYS_WRITE      = 64;
const SYS_PPOLL      = 73;
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
    this._onStdoutBytes = null;       // optional raw-byte stdout tap: (fd, Uint8Array) — for the terminal/vte
    this._stdinQueue = [];            // queued Uint8Array chunks awaiting a guest read() on fd 0
    this._stdinHead = 0;              // bytes already consumed from _stdinQueue[0]
    this._stdinInteractive = false;   // when true, an empty blocking stdin read parks instead of returning EOF
    this._stdinEof = false;           // when true, an empty stdin read returns EOF (0) even in interactive mode
    this._termEnabled = false;        // when true, console_write also feeds the in-wasm terminal grid (term_feed)
    this._virtualServer = null;
    this._scratchPtr = 0; // WASM linear memory scratch buffer for virtual server
    this._snapshotRequested = false; // set by sentinel detection in _processFsRequest
    this._runId = 0; // incremented on each run; checked in _runLoop for cancellation
    this._boaWasm = null;             // boa.wasm source (URL/bytes) for the scripting layer
    this._boa = null;                 // lazily-loaded BoaRuntime (see scripting())
  }

  /**
   * Create a new NanoVM instance.
   * @param {Object} opts
   * @param {number} opts.ramMB - RAM size in megabytes (default 512)
   * @param {string} opts.wasm - URL to the nano.wasm file
   * @param {string} [opts.busyboxUrl] - URL to busybox ELF (if not bundled)
   * @param {string} [opts.nodeUrl] - URL to node ELF (if not bundled)
   * @param {string|ArrayBuffer|Uint8Array} [opts.boaWasm] - boa.wasm for the scripting layer (lazy)
   */
  static async create(opts = {}) {
    const vm = new NanoVM();
    await vm._init(opts);
    return vm;
  }

  async _init(opts) {
    const { ramMB = 512, wasm, busyboxUrl, nodeUrl, boaWasm } = opts;
    this._ramMB = ramMB;
    this._boaWasm = boaWasm || null;

    // Load WASM binary (accepts URL string, ArrayBuffer, or Uint8Array)
    let wasmBytes;
    if (wasm instanceof ArrayBuffer || wasm instanceof Uint8Array) {
      wasmBytes = wasm;
    } else {
      const wasmUrl = typeof wasm === "string" ? wasm : "/nano.wasm";
      const wasmResponse = await fetch(wasmUrl);
      if (!wasmResponse.ok) throw new Error(`Failed to fetch WASM: ${wasmResponse.status}`);
      wasmBytes = await wasmResponse.arrayBuffer();
    }

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
          // Feed the in-wasm terminal grid first, zero-copy: ptr/len already
          // point at the guest's write buffer in linear memory, so the vte
          // parser reads exactly these bytes (escape sequences intact).
          if (self._termEnabled && self._exports.term_feed) self._exports.term_feed(ptr, len);
          const bytes = new Uint8Array(self._memory.buffer, ptr, len).slice();
          // Raw-byte tap: lets a terminal/vte consumer receive undecoded bytes
          // (escape sequences, partial UTF-8) before any lossy string decode.
          if (self._onStdoutBytes) self._onStdoutBytes(fd, bytes);
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

    // Pre-warm WASM JIT: run a trivial busybox command so the browser's
    // optimizing compiler (TurboFan) starts compiling exec() in the background.
    if (this._busyboxElf) {
      const savedStdout = this._stdout;
      const savedOnStdout = this._onStdout;
      this._onStdout = null;
      try {
        await this.run("echo warmup", { maxSteps: 2_000_000 });
      } catch (_) {}
      this._stdout = savedStdout;
      this._onStdout = savedOnStdout;
    }
  }

  _seedFS() {
    const m = this._memfs;
    const ramMB = this._ramMB;
    const ramSize = this._ramSize;

    m.createDir("/bin");
    m.createExecutable("/bin/busybox", "");
    m.createSymlink("/bin/sh", "busybox");
    // Applet symlink farm: so PATH lookups in sh (and execve) resolve common
    // busybox commands to /bin/busybox, which execve then runs by argv[0].
    const applets = ("ls cat echo mkdir rmdir rm mv cp ln touch chmod chown pwd " +
      "sort head tail grep sed awk cut tr wc find xargs sleep env printf basename " +
      "dirname dd du df date id whoami hostname uname true false test expr seq yes " +
      "tee which tar gzip gunzip zcat md5sum sha256sum cmp stat readlink realpath " +
      "mktemp sync kill ps nl od base64 wget clear sh ash").split(" ");
    for (const a of applets) m.createSymlink("/bin/" + a, "busybox");
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

  addFile(path, content, mode) {
    this._memfs.createFile(path, content, mode);
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

  /**
   * Create a directory (and any missing parents), like `mkdir -p`. Synchronous,
   * direct MemFS — takes no VM step, so it is safe while an interactive shell
   * owns the run loop. Idempotent on an existing directory; throws if the path
   * already exists as a non-directory.
   */
  makeDir(path) {
    const existing = this._memfs.resolve(path, false);
    if (existing) {
      if (existing.isDir) return; // idempotent
      throw new Error(`makeDir: path exists and is not a directory: ${path}`);
    }
    this._memfs.createDir(path);
  }

  /**
   * Recursively remove a file, symlink, or directory (like `rm -rf`).
   * Synchronous, direct MemFS. Symlinks are removed as links — never followed —
   * so a symlink cycle cannot hang the walk. No-op if the path does not exist.
   */
  removePath(path) {
    const node = this._memfs.resolve(path, /*followSymlinks=*/ false);
    if (!node) return;
    if (node.isDir) {
      const sep = path.endsWith("/") ? "" : "/";
      for (const childName of [...node.children.keys()]) {
        this.removePath(path + sep + childName);
      }
      const rc = this._memfs.unlink(path, 0x200); // AT_REMOVEDIR
      if (rc < 0) throw new Error(`removePath: rmdir failed (errno ${rc}): ${path}`);
    } else {
      const rc = this._memfs.unlink(path, 0); // file or symlink (not followed)
      if (rc < 0) throw new Error(`removePath: unlink failed (errno ${rc}): ${path}`);
    }
  }

  /**
   * Rename/move a path. Synchronous, direct MemFS. Overwrites an existing
   * destination entry. Refuses to move a directory into its own descendant
   * (which would orphan the subtree into a cycle).
   */
  renamePath(from, to) {
    const norm = (p) => "/" + p.split("/").filter(Boolean).join("/");
    const f = norm(from);
    const t = norm(to);
    if (t === f || t.startsWith(f + "/")) {
      throw new Error(`renamePath: cannot move ${from} into its own descendant: ${to}`);
    }
    const rc = this._memfs.rename(from, to);
    if (rc < 0) throw new Error(`renamePath: rename failed (errno ${rc}): ${from} -> ${to}`);
  }

  /** Working directory of the process currently in the run loop (e.g. "/root"). */
  cwd() {
    return this._readCwd();
  }

  // ============================================================
  // Public API — Scripting (host-side Boa engine)
  // ============================================================

  /**
   * Create a sandboxed Boa scripting engine that can drive this VM. Loads
   * boa.wasm lazily on first use (so consumers who never script pay nothing).
   *
   * @param {Object} [opts]
   * @param {string|ArrayBuffer|Uint8Array} [opts.wasm] - boa.wasm source (defaults to NanoVM.create({boaWasm}))
   * @param {Object} [opts.expose] - capabilities: { fs:"none"|"readonly"|"readwrite", run, node }
   * @param {string} [opts.globalName] - bridge global name (default "nano")
   * @param {Object} [opts.env] - read-only key/value bag injected as `<global>.env`
   * @param {Object} [opts.limits] - { loopIterations, recursion }
   * @param {number} [opts.timeoutMs] - host watchdog
   * @returns {Promise<import("./boa.mjs").BoaEngine>}
   */
  async scripting(opts = {}) {
    const wasm = opts.wasm || this._boaWasm;
    if (!wasm) {
      throw new Error("NanoVM.scripting: provide boa.wasm via opts.wasm or NanoVM.create({ boaWasm })");
    }
    if (!this._boa) {
      const { BoaRuntime } = await import("./boa.mjs");
      this._boa = await BoaRuntime.load(wasm);
    }
    return this._boa.createEngine({ host: this._scriptingHost(), ...opts });
  }

  /** One-shot: create an engine, evaluate `source`, dispose, return the value. */
  async script(source, opts = {}) {
    const engine = await this.scripting(opts);
    try {
      return await engine.eval(source);
    } finally {
      engine.dispose();
    }
  }

  /**
   * Wire a catalog so apps can be installed into this VM — by the host, by the
   * scripting layer (`nano.catalog.install(...)`), and via {@link installApp}.
   * `catalog` is duck-typed (an SDK `Catalog`): it must expose
   * `install(target, ref, opts)` and optionally `installBundle(target, slug, opts)`.
   * The InstallTarget is this VM's VFS (addFile). Returns `this` for chaining.
   */
  useCatalog(catalog) {
    const target = { writeFile: (p, bytes, mode) => this.addFile(p, bytes, mode) };
    this._catalogInstaller = {
      install: (ref, opts) => catalog.install(target, ref, opts),
      installBundle: (slug, opts) =>
        catalog.installBundle ? catalog.installBundle(target, slug, opts)
          : Promise.reject(new Error("catalog has no installBundle")),
    };
    return this;
  }

  /** Install a catalog app into this VM's VFS (requires {@link useCatalog}). */
  installApp(ref, opts) {
    if (!this._catalogInstaller) return Promise.reject(new Error("no catalog wired — call vm.useCatalog(catalog)"));
    return this._catalogInstaller.install(ref, opts);
  }

  /** Host driver mapping the Boa bridge onto this VM's MemFS + run/node + catalog. */
  _scriptingHost() {
    const vm = this;
    const needCatalog = () => {
      if (!vm._catalogInstaller) throw new Error("catalog not wired — call vm.useCatalog(catalog) before scripting");
      return vm._catalogInstaller;
    };
    return {
      fs: {
        readText: (p) => vm.readFileString(p),
        readFile: (p) => {
          const node = vm._memfs.resolve(p);
          return node && node.isFile ? node.data || new Uint8Array(0) : null;
        },
        list: (p) => vm.listDir(p),
        exists: (p) => !!vm._memfs.resolve(p),
        writeFile: (p, bytes) => vm.addFile(p, bytes),
      },
      run: (command) => vm.run(command),
      node: (args) => vm.node(...(Array.isArray(args) ? args : [args])),
      log: (...a) => console.log(...a),
      // Catalog: a script can load apps on demand (async; the Boa bridge supports
      // host_call_async). e.g. `await nano.catalog.install("ripgrep"); nano.run("rg --version")`.
      catalog: {
        install: (ref, opts) => needCatalog().install(ref, opts),
        installBundle: (slug, opts) => needCatalog().installBundle(slug, opts),
      },
    };
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
    // Prefer the embedded busybox; otherwise exec a catalog-installed
    // /bin/busybox from the guest VFS (the migration distributes it via the catalog).
    const elf = this._busyboxElf || this._readElfFromVfs("/bin/busybox");
    if (!elf) throw new Error("No busybox ELF loaded (embed it or install the busybox catalog app)");
    const argv = command.trim().split(/\s+/);
    return this._execute(elf, argv, [], opts);
  }

  /** Read an installed ELF from the guest VFS (follows symlinks), or null. */
  _readElfFromVfs(path) {
    const node = this._memfs.resolve(path);
    return node && node.isFile && node.data && node.data.length ? node.data : null;
  }

  /**
   * Run a node command.
   * @param {...(string|Object)} argsAndOpts - args followed by optional opts object
   * @returns {Promise<{exitCode: number, stdout: string}>}
   */
  async node(...argsAndOpts) {
    // Embedded node, else a catalog-installed /usr/bin/node from the guest VFS.
    const nodeElf = this._nodeElf || this._readElfFromVfs("/usr/bin/node");
    if (!nodeElf) throw new Error("No node ELF loaded (install the node catalog app)");
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
    return this._execute(nodeElf, args, envVars, opts);
  }

  /** Cancel the currently running execution loop. */
  cancelRun() {
    this._runId++;
  }

  // ============================================================
  // Public API — stdin (interactive terminal feed)
  // ============================================================

  /**
   * Feed bytes to the guest's stdin (fd 0). Bytes are queued and delivered to
   * the next (or a currently parked) read() on stdin. Accepts a Uint8Array or
   * a string (encoded as UTF-8).
   * @param {Uint8Array|string} bytes
   */
  writeStdin(bytes) {
    if (typeof bytes === "string") bytes = new TextEncoder().encode(bytes);
    if (!bytes || bytes.length === 0) return;
    const X = this._exports;
    if (X && X.vm_stdin_push) {
      // Push into the in-VM tty ring (applies line discipline / echo).
      if (!this._stdinScratch || this._stdinScratchCap < bytes.length) {
        this._stdinScratchCap = Math.max(bytes.length, 1024);
        this._stdinScratch = X.malloc(this._stdinScratchCap);
      }
      new Uint8Array(this._memory.buffer).set(bytes, this._stdinScratch);
      X.vm_stdin_push(this._vmPtr, this._stdinScratch, bytes.length);
    } else {
      // Legacy fallback: JS queue (older wasm without the in-VM tty ring).
      this._stdinQueue.push(bytes.slice());
    }
    this._stdinEof = false; // new input cancels a prior EOF
    if (this._stdinWake) this._stdinWake(); // wake a run loop parked on idle stdin
  }

  /**
   * Park the run loop while the guest is blocked on an idle interactive stdin
   * read: resolve as soon as writeStdin()/closeStdin() supplies input, otherwise
   * re-check after a short fallback. Replaces a busy-poll that spun the tty ring
   * ~50k times/sec at an idle prompt — near-zero idle CPU, no added input latency.
   */
  _parkStdin() {
    if (this._stdinAvailable() > 0 || this._stdinEof) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => { this._stdinWake = null; clearTimeout(timer); resolve(); };
      const timer = setTimeout(wake, 50);
      this._stdinWake = wake;
    });
  }

  /**
   * Switch stdin between EOF-on-empty (default, preserves non-interactive
   * semantics) and blocking-park-on-empty (for an interactive terminal driving
   * a live shell). When interactive, an empty read parks the VM until
   * writeStdin() supplies data (or closeStdin() signals EOF).
   * @param {boolean} on
   */
  setInteractiveStdin(on = true) {
    this._stdinInteractive = !!on;
    const X = this._exports;
    if (X && X.vm_stdin_set_interactive) X.vm_stdin_set_interactive(this._vmPtr, on ? 1 : 0);
  }

  /** Signal end-of-input on stdin (e.g. Ctrl-D). The next empty read returns EOF. */
  closeStdin() {
    this._stdinEof = true;
    const X = this._exports;
    if (X && X.vm_stdin_eof) X.vm_stdin_eof(this._vmPtr);
    if (this._stdinWake) this._stdinWake(); // wake a run loop parked on idle stdin
  }

  /** Total bytes currently queued on stdin. */
  _stdinAvailable() {
    let n = -this._stdinHead;
    for (const chunk of this._stdinQueue) n += chunk.length;
    return n;
  }

  /**
   * Copy up to `max` queued stdin bytes into guest physical address `bufPhys`.
   * Advances the queue. Returns the number of bytes written.
   */
  _stdinDrain(bufPhys, max) {
    let written = 0;
    const dst = new Uint8Array(this._memory.buffer);
    while (written < max && this._stdinQueue.length > 0) {
      const chunk = this._stdinQueue[0];
      const take = Math.min(chunk.length - this._stdinHead, max - written);
      dst.set(chunk.subarray(this._stdinHead, this._stdinHead + take), bufPhys + written);
      written += take;
      this._stdinHead += take;
      if (this._stdinHead >= chunk.length) {
        this._stdinQueue.shift();
        this._stdinHead = 0;
      }
    }
    return written;
  }

  // ============================================================
  // Public API — terminal grid (Console)
  // ============================================================

  /**
   * Initialise the in-wasm terminal grid and start feeding it guest stdout.
   * Also switches stdin to interactive (blocking) mode, since a terminal drives
   * a live shell. Call once after create() (and again to resize).
   * @param {number} cols
   * @param {number} rows
   */
  termInit(cols = 80, rows = 25) {
    const X = this._exports;
    if (!X || !X.term_reset) throw new Error("WASM build lacks terminal exports (rebuild nano.wasm)");
    this._termCols = cols;
    this._termRows = rows;
    X.term_reset(cols, rows);
    this._termEnabled = true;
    this.setInteractiveStdin(true);
    // NOTE: tty mode (isatty=true) is intentionally NOT enabled here yet. It
    // makes busybox ash switch to its line editor, which needs the raw-mode
    // read semantics + line discipline implemented later in Phase 1. Until then
    // the terminal uses front-end cooked mode. Call setTty(true) once those land.
  }

  /**
   * Enable/disable guest tty mode (isatty + winsize + termios on the std fds).
   * Persists across runs. Only turn on once raw-mode reads + line discipline are
   * implemented, or interactive shells will switch to a line editor that hangs.
   * @param {boolean} on
   */
  setTty(on = true) {
    this._ttyEnabled = !!on;
    const X = this._exports;
    if (X.vm_tty_enable) {
      X.vm_tty_enable(this._vmPtr, on ? 1 : 0, this._termCols || 80, this._termRows || 25);
    }
  }

  /** Resize the terminal (grid + guest winsize). SIGWINCH delivery is Phase 1's signal step. */
  termResize(cols, rows) {
    const X = this._exports;
    this._termCols = cols;
    this._termRows = rows;
    if (X.term_reset) X.term_reset(cols, rows);
    if (X.vm_tty_set_size) X.vm_tty_set_size(this._vmPtr, cols, rows);
    if (X.vm_signal) X.vm_signal(this._vmPtr, 28); // SIGWINCH
  }

  /**
   * Snapshot the grid for rendering. Returns dimensions, cursor, a copy of the
   * cell bytes (row-major, 8 bytes/cell: u32 ch, u8 fg, u8 bg, u8 flags, u8 pad),
   * and the scroll position, or null if the build lacks terminal exports.
   *
   * `scrollOffset` is the number of scrollback lines scrolled up from the live
   * bottom (0 = live). It is clamped to `scrollMax`; the cursor is hidden
   * (-1/-1) whenever the viewport is scrolled off the live region.
   * @param {number} [scrollOffset=0]
   * @returns {{cols:number, rows:number, cursorRow:number, cursorCol:number,
   *   cells:Uint8Array, scrollOffset:number, scrollMax:number}|null}
   */
  termSnapshot(scrollOffset = 0) {
    const X = this._exports;
    if (!this._termEnabled || !X.term_cells_ptr) return null;
    const cols = X.term_cols();
    const rows = X.term_rows();
    let ptr, scrollMax = 0, off = 0;
    if (X.term_compose && X.term_view_ptr && X.term_scroll_max) {
      scrollMax = X.term_scroll_max();
      off = Math.max(0, Math.min(scrollOffset | 0, scrollMax));
      X.term_compose(off);
      ptr = X.term_view_ptr();
    } else {
      ptr = X.term_cells_ptr(); // pre-scrollback build: live screen only
    }
    const cells = new Uint8Array(this._memory.buffer, ptr, cols * rows * 8).slice();
    const live = off === 0;
    return {
      cols, rows,
      cursorRow: live ? X.term_cursor_row() : -1,
      cursorCol: live ? X.term_cursor_col() : -1,
      cells, scrollOffset: off, scrollMax,
    };
  }

  /**
   * Echo bytes straight into the terminal grid WITHOUT sending them to the
   * guest. Phase-0 front-end cooked-mode stopgap for local echo of typed input
   * (the VM has no tty line discipline / echo yet — that arrives in Phase 1).
   * @param {Uint8Array|string} data
   */
  termEcho(data) {
    if (!this._termEnabled) return;
    const X = this._exports;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) return;
    if (!this._termScratch || this._termScratchCap < bytes.length) {
      this._termScratchCap = Math.max(bytes.length, 256);
      this._termScratch = X.malloc(this._termScratchCap);
    }
    new Uint8Array(this._memory.buffer).set(bytes, this._termScratch);
    X.term_feed(this._termScratch, bytes.length);
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

  // ============================================================
  // Public API — Snapshotting
  // ============================================================

  /**
   * Capture a snapshot of the current VM state.
   * Call this when the VM is paused at a clean boundary (e.g. after snapshotReady).
   * @returns {{ vmStruct: Uint8Array, guestRAM: Uint8Array, usedRAMSize: number, memfs: Array }}
   */
  _pipeGet(id) {
    let p = this._pipes.get(id);
    if (!p) { p = { chunks: [], total: 0, readPos: 0 }; this._pipes.set(id, p); }
    return p;
  }

  /** Append guest bytes to a pipe buffer. */
  _pipeWrite(id, srcPhys, count) {
    if (count <= 0) return 0;
    const p = this._pipeGet(id);
    p.chunks.push(new Uint8Array(this._memory.buffer, srcPhys, count).slice());
    p.total += count;
    return count;
  }

  /** Drain up to `count` bytes from a pipe buffer; 0 = EOF (writer finished). */
  _pipeRead(id, dstPhys, count) {
    const p = this._pipeGet(id);
    const avail = p.total - p.readPos;
    if (avail <= 0 || count <= 0) return 0;
    const n = Math.min(count, avail);
    const dst = new Uint8Array(this._memory.buffer, dstPhys, n);
    let copied = 0, chunkStart = 0;
    for (const ch of p.chunks) {
      const chunkEnd = chunkStart + ch.length;
      if (p.readPos + copied < chunkEnd && copied < n) {
        const from = Math.max(0, p.readPos + copied - chunkStart);
        const take = Math.min(ch.length - from, n - copied);
        dst.set(ch.subarray(from, from + take), copied);
        copied += take;
      }
      chunkStart = chunkEnd;
      if (copied >= n) break;
    }
    p.readPos += copied;
    return copied;
  }

  /** Capture parent process state for a serialized fork (struct + used RAM). */
  _forkSnapshot() {
    const dv = new DataView(this._memory.buffer);
    const v = this._vmPtr;
    const brkCurrent = Number(dv.getBigUint64(v + 568, true));
    const mmapNext = Number(dv.getBigUint64(v + 3312, true));
    const lowEnd = Math.min(Math.max(brkCurrent, mmapNext), this._ramSize);
    const sp = Number(dv.getBigUint64(v + 16, true));
    const stackStart = Math.max(lowEnd, (sp - 65536) & ~0xFFF);
    // Signal handler tables live in Rust statics (not the Vm struct / guest RAM),
    // so capture them separately — a forked child's execve() resets them and would
    // otherwise wipe the PARENT shell's handlers (e.g. its interactive SIGINT
    // handler, so Ctrl-C at the next prompt would kill the shell instead of the
    // input line).
    let sigState = null, sigAddr = 0;
    if (this._exports.vm_signals_dump) {
      sigAddr = this._exports.vm_signals_dump();
      sigState = new Uint8Array(this._memory.buffer, sigAddr, 2 * 64 * 8).slice();
    }
    return {
      vmStruct: new Uint8Array(this._memory.buffer, v, VM_STRUCT_SIZE).slice(),
      lowRAM: new Uint8Array(this._memory.buffer, this._ramPtr, lowEnd).slice(),
      stackRAM: new Uint8Array(this._memory.buffer, this._ramPtr + stackStart, this._ramSize - stackStart).slice(),
      lowEnd,
      stackStart,
      sigState,
      sigAddr,
    };
  }

  /** Restore parent process state captured by _forkSnapshot. */
  _forkRestore(snap) {
    const mem = new Uint8Array(this._memory.buffer);
    mem.set(snap.vmStruct, this._vmPtr);
    mem.set(snap.lowRAM, this._ramPtr);
    // Zero the gap between the parent's heap/mmap top and its stack. The child
    // ran in-place — execve loaded a fresh image that grew its own heap/stack
    // through this region — so it holds the child's garbage. The parent treats
    // this as free memory and expects zeroed pages when it later grows brk/stack
    // into it; leaving child bytes here corrupts the parent nondeterministically.
    // Mirrors the gap-zero in restoreAndRun()'s persistence restore.
    if (snap.stackStart > snap.lowEnd) {
      mem.fill(0, this._ramPtr + snap.lowEnd, this._ramPtr + snap.stackStart);
    }
    if (snap.stackRAM.length) mem.set(snap.stackRAM, this._ramPtr + snap.stackStart);
    // Restore the parent's signal handler tables (see _forkSnapshot) so the child's
    // execve() reset can't leave the shell with a default (fatal) SIGINT.
    if (snap.sigState && this._exports.vm_signals_load) {
      new Uint8Array(this._memory.buffer, snap.sigAddr, snap.sigState.length).set(snap.sigState);
      this._exports.vm_signals_load();
    }
  }

  snapshot() {
    const dv = new DataView(this._memory.buffer);
    const v = this._vmPtr;

    // Low region: heap + mmap area (grows upward from 0)
    const brkCurrent = Number(dv.getBigUint64(v + 568, true));
    const mmapNext = Number(dv.getBigUint64(v + 3312, true));
    const lowEnd = Math.min(Math.max(brkCurrent, mmapNext), this._ramSize);

    // High region: stack (grows downward from ram_size)
    const sp = Number(dv.getBigUint64(v + 16, true)); // x[2] = sp
    // 64KB margin below sp for safety, page-aligned
    const stackStart = Math.max(lowEnd, (sp - 65536) & ~0xFFF);

    // Copy VM struct
    const vmStruct = new Uint8Array(this._memory.buffer, v, VM_STRUCT_SIZE).slice();

    // Copy low region (heap + mmap)
    const lowRAM = new Uint8Array(this._memory.buffer, this._ramPtr, lowEnd).slice();

    // Copy stack region
    const stackSize = this._ramSize - stackStart;
    const stackRAM = stackSize > 0
      ? new Uint8Array(this._memory.buffer, this._ramPtr + stackStart, stackSize).slice()
      : new Uint8Array(0);

    // Serialize MemFS
    const memfs = this._memfs.serialize();

    return { vmStruct, lowRAM, lowEnd, stackRAM, stackStart, memfs };
  }

  /**
   * Restore a snapshot and run injected code.
   * @param {Object} snap - Snapshot from snapshot()
   * @param {string} script - JavaScript source to inject as /dev/__run__
   * @param {Object} [opts]
   * @param {function} [opts.onStdout] - callback for stdout chunks
   * @param {number} [opts.maxSteps] - max instructions (default 2M)
   * @returns {Promise<{exitCode: number, stdout: string}>}
   */
  async restoreAndRun(snap, script, opts = {}) {
    const { onStdout, maxSteps = 2_000_000 } = opts;

    this._stdout = "";
    this._onStdout = onStdout || null;
    this._resetProcessState();

    const X = this._exports;
    const v = this._vmPtr;
    const mem = new Uint8Array(this._memory.buffer);

    // 1. Reset block cache + syscall statics
    if (X.vm_snapshot_restore_reset) {
      X.vm_snapshot_restore_reset();
    } else {
      // Fallback: reset separately
      if (X.vm_reset_blocks) X.vm_reset_blocks();
      if (X.vm_reset_statics) X.vm_reset_statics();
    }

    // 2. Restore VM struct
    mem.set(snap.vmStruct, v);

    // 3. Restore guest RAM (dual-region: low heap/mmap + high stack)
    mem.set(snap.lowRAM, this._ramPtr);

    // 4. Zero gap between low region and stack
    if (snap.stackStart > snap.lowEnd) {
      mem.fill(0, this._ramPtr + snap.lowEnd, this._ramPtr + snap.stackStart);
    }

    // 5. Restore stack region
    if (snap.stackRAM.length > 0) {
      mem.set(snap.stackRAM, this._ramPtr + snap.stackStart);
    }

    // 6. Rebuild MemFS from snapshot
    this._memfs = MemFS.deserialize(snap.memfs);

    // 6b. Inject extra user files (e.g. from OPFS)
    if (opts.extraFiles) {
      for (const { path, content } of opts.extraFiles) {
        this._memfs.createFile(path, content);
      }
    }

    // 7. Inject user script into MemFS at /dev/__run__
    this._memfs.createFile("/dev/__run__", script);

    // 8. Complete the pending writeFileSync: a0 = 0 (success), status = OK
    const dv = new DataView(this._memory.buffer);
    dv.setBigInt64(v + 80, 0n, true);          // a0 = 0
    dv.setInt32(v + 528, STATUS_OK, true);      // status = STATUS_OK

    // 9. Resume execution
    return this._runLoop(maxSteps);
  }

  /**
   * Convenience: snapshot Node.js after V8 init using the launcher script pattern.
   * @param {Object} [opts]
   * @param {number} [opts.maxSteps] - max steps for warmup phase (default 50M)
   * @returns {Promise<Object>} snapshot object for use with restoreAndRun()
   */
  /**
   * Generic app snapshot. Loads an ELF, seeds an optional launcher script, runs
   * it with the given argv/env until the guest signals the `/dev/__snapshot__`
   * sentinel, and captures the VM state. App-specifics (which ELF, the launcher,
   * argv, env) are PARAMETERS — driven by the app's recipe — so the core stays
   * runtime-agnostic. The launcher convention: write `/dev/__snapshot__`, then
   * read + execute the per-run payload at `/dev/__run__` (see restoreAndRun).
   *
   * @param {object} opts
   * @param {Uint8Array} [opts.elf] - ELF bytes (or read from elfPath).
   * @param {string}     [opts.elfPath] - VFS path to read the ELF from.
   * @param {string}     [opts.launcher] - launcher source seeded at launcherPath.
   * @param {string}     [opts.launcherPath="/launcher.js"]
   * @param {string[]}   opts.argv - process argv (e.g. ["node","/launcher.js"]).
   * @param {string[]}   [opts.env=[]] - environment (["K=V", ...]).
   * @param {number}     [opts.maxSteps=2e9]
   */
  async snapshotApp(opts = {}) {
    const { elf, elfPath, launcher, launcherPath = "/launcher.js", argv, env = [], maxSteps = 2_000_000_000 } = opts;
    const appElf = elf || (elfPath ? this._readElfFromVfs(elfPath) : null);
    if (!appElf) throw new Error(`snapshotApp: no ELF (${elfPath || "pass elf or elfPath"})`);
    if (!argv || !argv.length) throw new Error("snapshotApp: argv required");

    if (launcher) this._memfs.createFile(launcherPath, launcher);

    this._stdout = "";
    this._onStdout = null;
    this._resetProcessState();

    this._resetVM();
    const mem = new Uint8Array(this._memory.buffer);
    mem.set(appElf, this._ramPtr);

    const X = this._exports;
    const loadRc = X.vm_load_elf(this._vmPtr, 0, appElf.length);
    if (loadRc !== 0) throw new Error(`vm_load_elf failed: ${loadRc}`);

    this._setupArgv(argv, env);

    const result = await this._runLoop(maxSteps);
    if (!result.snapshotReady) throw new Error("App did not reach the snapshot sentinel within budget");
    return this.snapshot();
  }

  /**
   * Node-specific convenience over {@link snapshotApp}. Prefer driving snapshotApp
   * from an app recipe (the node specifics below live in the catalog node recipe);
   * kept for backward compatibility.
   */
  async nodeSnapshot(opts = {}) {
    const nodeElf = this._nodeElf || this._readElfFromVfs("/usr/bin/node");
    return this.snapshotApp({
      elf: nodeElf,
      launcherPath: "/launcher.js",
      launcher: [
        "const fs = require('fs');",
        "fs.writeFileSync('/dev/__snapshot__', 'snap');",
        "const __s = fs.readFileSync('/dev/__run__', 'utf8');",
        "(new Function(__s))();",
      ].join("\n"),
      argv: ["node", "/launcher.js"],
      env: ["UV_THREADPOOL_SIZE=0"],
      maxSteps: opts.maxSteps ?? 2_000_000_000,
    });
  }

  // Getters for runtime.ts compatibility
  get exports() { return this._exports; }
  get memory() { return this._memory; }
  get virtualServer() { return this._virtualServer; }

  // ============================================================
  // Public API — Introspection (terminal footer stats)
  // ============================================================

  /** Total guest instructions retired so far (for an insns/sec readout). */
  instructionCount() {
    const X = this._exports;
    if (!X || !X.debug_block_insns) return 0;
    return Number(X.debug_block_insns(this._vmPtr)) + Number(X.debug_baseline_insns(this._vmPtr));
  }

  /**
   * Whether a guest server is listening this run. Sticky once detected (a server
   * either via EPOLL accept-block or a "listening …" banner); cleared on the next
   * run/reset. Good enough for a footer "port open" hint.
   */
  get serving() {
    return !!this._serverMode;
  }

  /** The listening port (best-effort, from the server banner) while serving, else null. */
  get servingPort() {
    return this._serverMode ? this._servingPort ?? null : null;
  }

  // ============================================================
  // Internal — Execution loop
  // ============================================================

  /**
   * Reset the host-side serialized-fork bookkeeping (fork stack, zombie list,
   * pid counter, pipe buffers). Every entry into the run loop — cold run,
   * snapshot warmup, and warm restore — must start from clean state; a leftover
   * pipe buffer or fork frame from a prior run corrupts the next guest image.
   */
  _resetProcessState() {
    this._forkStack = [];
    this._zombies = [];
    this._nextPid = 1000;
    this._pipes = new Map();
  }

  async _execute(elfBytes, argv, extraEnv, opts = {}) {
    const { onStdout, maxSteps = 2_000_000 } = opts;

    this._stdout = "";
    this._onStdout = onStdout || null;
    this._resetProcessState();

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

    // Re-apply tty mode — _resetVM() above cleared the Vm struct flag.
    if (this._ttyEnabled && X.vm_tty_enable) {
      X.vm_tty_enable(this._vmPtr, 1, this._termCols || 80, this._termRows || 25);
    }

    return this._runLoop(maxSteps);
  }

  /**
   * Core execution loop. Runs the VM until exit, fault, snapshot sentinel, or budget exhaustion.
   * @param {number} maxSteps - Max instructions to execute
   * @returns {Promise<{exitCode: number, stdout: string, snapshotReady?: boolean}>}
   */
  async _runLoop(maxSteps) {
    const X = this._exports;
    const BUDGET = 100_000;
    const maxIter = Math.ceil(maxSteps / BUDGET);
    let yieldCounter = 0;
    let stepCounter = 0;
    let serverMode = false;
    this._snapshotRequested = false;
    this._lastYieldPc = null; // adaptive-yield progress tracker (see _adaptiveYield)
    this._serverMode = false; // set once a guest server is listening (see get serving)
    this._servingPort = null;
    const myRunId = ++this._runId;

    for (let iter = 0; iter < maxIter; iter++) {
      if (this._runId !== myRunId) {
        return { exitCode: -1, stdout: this._stdout, cancelled: true };
      }
      try {
        X.vm_step(this._vmPtr, BUDGET);
      } catch (e) {
        console.error("[nanovm] vm_step threw:", e);
        return { exitCode: -1, stdout: this._stdout };
      }

      stepCounter++;
      const status = X.debug_status(this._vmPtr);

      if (status === STATUS_FAULT) {
        // A forked child exiting: record its status, restore the parent, and make
        // the parent's clone() return the child pid. Otherwise it's the real exit.
        if (this._forkStack && this._forkStack.length > 0) {
          const frame = this._forkStack.pop();
          this._zombies.push({ pid: frame.childPid, exitCode: X.vm_exit_code(this._vmPtr) });
          this._forkRestore(frame.snap);
          const fdv = new DataView(this._memory.buffer);
          this._setA0(fdv, frame.childPid);
          fdv.setInt32(this._vmPtr + 528, STATUS_OK, true);
          continue;
        }
        return { exitCode: X.vm_exit_code(this._vmPtr), stdout: this._stdout };
      }

      if (status === STATUS_FS_PENDING) {
        this._processFsRequest();
        // Snapshot sentinel was hit — return control to caller
        if (this._snapshotRequested) {
          return { exitCode: 0, stdout: this._stdout, snapshotReady: true };
        }
        // Network sentinel: the guest wrote a request to /dev/__net__ and then
        // either closed it or read from it. Do the host fetch here (the run loop
        // is async); a read that triggered it is then served with the response.
        if (this._asyncNet) {
          const an = this._asyncNet;
          this._asyncNet = null;
          await this._netFetch();
          if (an.read) this._serveNetRead(an.bufPtr, an.bufLen);
        }
        iter--; // FS operations don't consume execution budget
        if (this._blockedOnStdin) {
          // Idle interactive prompt: sleep until keystrokes arrive (or a short
          // fallback) instead of busy-polling the tty ~50k times/sec.
          await this._parkStdin();
        } else if (++yieldCounter % 200 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
        continue;
      }

      if (status === STATUS_EPOLL_BLOCKED) {
        serverMode = true;
        this._serverMode = true; // a guest server is listening (footer indicator)
        await this._adaptiveYield(X);
        this._pollConnections();
        const dv = new DataView(this._memory.buffer);
        dv.setBigInt64(this._vmPtr + 80, BigInt(-4), true); // a0 = -EINTR
        dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
        iter--;
        continue;
      }

      if (status !== STATUS_OK && status !== STATUS_RUNNING) {
        return { exitCode: -1, stdout: this._stdout };
      }

      if (!serverMode && /listening/i.test(this._stdout)) {
        serverMode = true;
        this._serverMode = true;
        // Best-effort: pull the port from the server's banner ("listening on
        // 8080", "running at http://localhost:3000", ":5173", …).
        const tail = this._stdout.slice(-240);
        const m =
          /(?:listening|running|started)[^\d]{0,14}(\d{2,5})/i.exec(tail) ||
          /:(\d{2,5})\b/.exec(tail);
        if (m) this._servingPort = parseInt(m[1], 10);
      }
      if (serverMode) iter--;

      this._pollConnections();

      if (stepCounter % 5 === 0) {
        await this._adaptiveYield(X);
      }
    }

    return { exitCode: -1, stdout: this._stdout };
  }

  /**
   * Macrotask yield via MessageChannel. Unlike `setTimeout(0)` — which Chrome
   * clamps to ~1s in background/hidden tabs — `postMessage` is NOT throttled, so
   * an actively-running guest (cold-starting Node, serving HTTP) keeps full
   * interpreter speed even when the tab isn't focused. Used by {@link _adaptiveYield}.
   */
  _fastYield() {
    if (!this._yieldChannel) {
      this._yieldQueue = [];
      this._yieldChannel = new MessageChannel();
      this._yieldChannel.port1.onmessage = () => {
        const r = this._yieldQueue.shift();
        if (r) r();
      };
    }
    return new Promise((resolve) => {
      this._yieldQueue.push(resolve);
      this._yieldChannel.port2.postMessage(0);
    });
  }

  /**
   * Yield to the host event loop, fast or slow depending on whether the guest is
   * making progress. While it executes (PC advancing) or a connection is pending,
   * use the unthrottled MessageChannel yield; when idle (e.g. an interactive
   * shell parked on an empty stdin read — same PC, no pending work), fall back to
   * `setTimeout(0)` so a quiet terminal doesn't busy-spin the CPU.
   */
  _adaptiveYield(X) {
    const pc = X.debug_pc ? X.debug_pc(this._vmPtr) : null;
    const active = pc === null || pc !== this._lastYieldPc || this._pendingConnections.length > 0;
    this._lastYieldPc = pc;
    return active ? this._fastYield() : new Promise((r) => setTimeout(r, 0));
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
        conn.received = (conn.received || 0) + n;
        conn.stalePollCount = 0;
        // Once headers arrive, learn the expected length so we read the whole
        // body (a large static asset streams in many 16 KB chunks).
        if (conn.expectedTotal === undefined) conn.expectedTotal = this._expectedResponseLength(conn);
        if (conn.expectedTotal != null && conn.received >= conn.expectedTotal) {
          this._resolveConnection(X, conn, pending, i);
        }
      } else if (n === -1) {
        // Connection closed — response is complete
        this._resolveConnection(X, conn, pending, i);
      } else if (conn.responseChunks.length > 0) {
        // n === 0 (no bytes ready this poll). If a Content-Length told us the
        // body isn't finished, keep waiting — the server is mid-stream. Only
        // force-close when the length is unknown (Connection: close streaming),
        // after enough stale polls, to break the close-deadlock.
        if (conn.expectedTotal === undefined) conn.expectedTotal = this._expectedResponseLength(conn);
        conn.stalePollCount = (conn.stalePollCount || 0) + 1;
        const limit = conn.expectedTotal === null ? 200 : 20000; // unknown-len vs hung-server backstop
        if (conn.stalePollCount >= limit) {
          this._resolveConnection(X, conn, pending, i);
        }
      }
    }
  }

  /**
   * Inspect a connection's accumulated bytes and return the expected total
   * response size (header + body) once the headers are complete:
   *   - a number   → Content-Length known; read until `received` reaches it
   *   - `null`     → chunked or no Content-Length → rely on connection close
   *   - `undefined`→ headers not fully received yet → keep reading
   */
  _expectedResponseLength(conn) {
    let total = 0;
    for (const c of conn.responseChunks) total += c.length;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of conn.responseChunks) { buf.set(c, off); off += c.length; }
    let sep = -1;
    for (let j = 0; j + 3 < buf.length; j++) {
      if (buf[j] === 13 && buf[j + 1] === 10 && buf[j + 2] === 13 && buf[j + 3] === 10) { sep = j; break; }
    }
    if (sep === -1) return undefined; // headers not complete
    const header = new TextDecoder().decode(buf.subarray(0, sep));
    if (/transfer-encoding:\s*chunked/i.test(header)) return null;
    const m = /content-length:\s*(\d+)/i.exec(header);
    return m ? sep + 4 + parseInt(m[1], 10) : null;
  }

  _resolveConnection(X, conn, pending, i) {
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

  _resetVM() {
    const dv = new DataView(this._memory.buffer);
    const v = this._vmPtr;
    const X = this._exports;

    // Reset the guest block cache AND the Rust static globals (sockets, epoll,
    // eventfd, timerfd, signals, tty, pipe ids) before each program load.
    // Resetting blocks is mandatory for correctness: translated blocks are keyed
    // by guest address, so the next program (e.g. node after busybox `sh`) would
    // otherwise execute stale blocks at the same addresses and fault. The build
    // never exported a standalone `vm_reset_statics`; `vm_snapshot_restore_reset`
    // resets both blocks and statics, so prefer it when a dedicated statics
    // reset is absent.
    if (X.vm_reset_statics) {
      if (X.vm_reset_blocks) X.vm_reset_blocks();
      X.vm_reset_statics();
    } else if (X.vm_snapshot_restore_reset) {
      X.vm_snapshot_restore_reset();
    } else if (X.vm_reset_blocks) {
      X.vm_reset_blocks();
    }

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

  /** Read a NUL-terminated C string from guest address `gptr`. */
  _readGuestCStr(gptr) {
    if (!gptr) return "";
    const view = new Uint8Array(this._memory.buffer, this._ramPtr + (gptr >>> 0));
    let e = 0;
    while (e < view.length && e < 8192 && view[e] !== 0) e++;
    // `.slice()` (not `.subarray()`) — copies into a non-shared ArrayBuffer.
    // The browser's TextDecoder rejects views backed by the SharedArrayBuffer
    // that `_memory.buffer` is (WASM memory is shared:true). Node's is lenient,
    // so this only bites in the browser (e.g. reading execve argv).
    return new TextDecoder().decode(view.slice(0, e));
  }

  /** Read a NULL-terminated array of guest string pointers (argv/envp). */
  _readGuestStrArray(gptr) {
    const out = [];
    if (!gptr) return out;
    const dv = new DataView(this._memory.buffer);
    let p = this._ramPtr + (gptr >>> 0);
    for (let i = 0; i < 4096; i++) {
      const strPtr = Number(dv.getBigUint64(p, true));
      if (strPtr === 0) break;
      out.push(this._readGuestCStr(strPtr));
      p += 8;
    }
    return out;
  }

  /**
   * execve: replace the current process image, preserving inherited fds and cwd.
   * Two cases are supported: the target resolves to /bin/busybox (an applet
   * symlink or busybox itself) → run the bundled busybox image, dispatched by
   * argv[0]; OR it's any other executable ELF in the VFS (e.g. a catalog-installed
   * /usr/bin/<tool>) → load THAT image. argv/envp are read from the OLD image
   * before the reset overwrites RAM. Resumes at the new ELF entry; on failure
   * writes a negative errno to a0 (execve "returns" only on error).
   */
  _doExecve(dv, execPath, argvPtr, envpPtr) {
    const X = this._exports;
    const argv = this._readGuestStrArray(argvPtr);
    const envp = this._readGuestStrArray(envpPtr);

    // Resolve the target in the guest VFS (following symlinks).
    const target = this._memfs.resolve(execPath, true);
    if (!target || !target.isFile) {
      this._setA0(dv, -2); // ENOENT
      dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
      return;
    }
    if (!(target.mode & 0o111)) {
      this._setA0(dv, -13); // EACCES — present but not executable
      dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
      return;
    }

    // Applet symlinks (and busybox itself) run the bundled busybox image, which
    // dispatches on argv[0]. Anything else runs its own ELF bytes from the VFS.
    const busyboxNode = this._memfs.resolve("/bin/busybox", true);
    const elfBytes = (busyboxNode && target === busyboxNode && this._busyboxElf)
      ? this._busyboxElf
      : (target.data && target.data.length ? target.data : null);
    if (!elfBytes || elfBytes.length < 4 ||
        elfBytes[0] !== 0x7f || elfBytes[1] !== 0x45 ||
        elfBytes[2] !== 0x4c || elfBytes[3] !== 0x46) {
      this._setA0(dv, -8); // ENOEXEC — not an ELF image
      dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
      return;
    }

    // Preserve inherited fds + cwd + tty/termios across the image replacement.
    // Like a real execve, the controlling tty's state (isatty + winsize + the
    // termios flags, incl. OPOST/ONLCR) belongs to the terminal, not the process
    // image, so it must survive the reset — otherwise the new program writes with
    // no output post-processing and every '\n' line-feeds without a carriage
    // return (the classic "staircase"). Block [3632, 3680) = tty_enabled, ws_row,
    // ws_col, c_iflag/oflag/cflag/lflag, c_cc[19], c_line (see src/types.rs).
    const v = this._vmPtr;
    const fdTable = new Uint8Array(this._memory.buffer, v + FD_TABLE_OFF, 64 * 24).slice();
    const cwd = new Uint8Array(this._memory.buffer, v + 3680, 256).slice();
    const ttyState = new Uint8Array(this._memory.buffer, v + 3632, 48).slice();

    this._resetVM();

    new Uint8Array(this._memory.buffer).set(fdTable, v + FD_TABLE_OFF);
    new Uint8Array(this._memory.buffer).set(cwd, v + 3680);
    new Uint8Array(this._memory.buffer).set(ttyState, v + 3632);

    // Load the new image and set up argv/envp.
    new Uint8Array(this._memory.buffer).set(elfBytes, this._ramPtr);
    const loadRc = X.vm_load_elf(v, 0, elfBytes.length);
    const dv2 = new DataView(this._memory.buffer);
    if (loadRc !== 0) {
      this._setA0(dv2, -8); // ENOEXEC
      dv2.setInt32(v + 528, STATUS_OK, true);
      return;
    }
    this._setupArgv(argv.length ? argv : [execPath], envp);

    // Resume at the new entry; vm_load_elf set pc/sp, _setupArgv set the argv stack.
    dv2.setInt32(v + 528, STATUS_OK, true);
  }

  // ---- Network bridge (Tier 1): host-brokered fetch via /dev/__net__ ----

  /**
   * Configure the network bridge. `corsProxyUrl` (Tier 1.5) is a CORS-proxy
   * Worker the bridge retries through when a direct fetch is CORS-blocked;
   * `disabled` turns the /dev/__net__ device off (open returns EACCES).
   */
  setNetwork({ corsProxyUrl = null, disabled = false } = {}) {
    this._corsProxyUrl = corsProxyUrl;
    this._netDisabled = !!disabled;
  }

  // Concatenate the accumulated request bytes, do the host fetch, buffer the
  // HTTP-like response for the guest's reads.
  async _netFetch() {
    const parts = this._netReq || []; this._netReq = [];
    let total = 0; for (const p of parts) total += p.length;
    const reqBytes = new Uint8Array(total); let o = 0;
    for (const p of parts) { reqBytes.set(p, o); o += p.length; }
    this._netResp = await this._doNetFetch(reqBytes);
    this._netRespPos = 0;
  }

  async _doNetFetch(reqBytes) {
    // Parse "METHOD URL\nHeader: v\n...\n\nbody".
    const text = new TextDecoder().decode(reqBytes);
    const sep = text.indexOf("\n\n");
    const head = sep >= 0 ? text.slice(0, sep) : text;
    const body = sep >= 0 ? text.slice(sep + 2) : "";
    const lines = head.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);
    const first = (lines.shift() || "GET ").trim().split(/\s+/);
    const method = (first[0] || "GET").toUpperCase();
    const url = first[1];
    const headers = {};
    for (const l of lines) { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
    if (!url) return this._httpResp(400, "Bad Request", {}, "nano-net: missing URL");
    const opts = { method, headers };
    if (method !== "GET" && method !== "HEAD" && body) opts.body = body;
    try {
      let resp;
      try {
        resp = await fetch(url, opts);
      } catch (e) {
        // Direct fetch blocked (CORS/network) → retry via the Tier-1.5 proxy if set.
        if (this._corsProxyUrl) {
          const u = this._corsProxyUrl + (this._corsProxyUrl.includes("?") ? "&" : "?") + "apiurl=" + encodeURIComponent(url);
          resp = await fetch(u, opts);
        } else throw e;
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      const hdrs = {}; resp.headers.forEach((v, k) => { hdrs[k] = v; });
      return this._httpResp(resp.status, resp.statusText || "", hdrs, buf);
    } catch (e) {
      return this._httpResp(502, "Bad Gateway", {}, "nano-net: " + (e?.message || String(e)));
    }
  }

  // Copy the next chunk of the buffered response into the guest read buffer and
  // complete the read (a0 = bytes copied; 0 = EOF). Resets status to OK.
  _serveNetRead(bufPtr, bufLen) {
    const dv = new DataView(this._memory.buffer);
    const resp = this._netResp || new Uint8Array(0);
    const pos = this._netRespPos || 0;
    const n = Math.min(bufLen, resp.length - pos);
    if (n > 0) {
      new Uint8Array(this._memory.buffer, this._ramPtr + bufPtr, n).set(resp.subarray(pos, pos + n));
      this._netRespPos = pos + n;
    }
    this._setA0(dv, n);
    dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
  }

  // Frame a host response as HTTP/1.1 (status line + headers + body) for the guest.
  _httpResp(status, statusText, headers, body) {
    const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
    head += `content-length: ${bodyBytes.length}\r\n\r\n`;
    const headBytes = new TextEncoder().encode(head);
    const out = new Uint8Array(headBytes.length + bodyBytes.length);
    out.set(headBytes, 0); out.set(bodyBytes, headBytes.length);
    return out;
  }

  _processFsRequest() {
    const X = this._exports;
    this._blockedOnStdin = false; // set true below when a stdin read parks (idle prompt)
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

    // In-VM stdin park: a stdin read()/ppoll() blocked waiting for input.
    // Re-attempt against the tty ring; if still waiting, leave FS_PENDING so the
    // run loop re-polls (and yields to the event loop so keystrokes can arrive).
    if (X.vm_io_retry && (syscallNr === SYS_READ || syscallNr === SYS_PPOLL)) {
      const isStdin = syscallNr === SYS_PPOLL ||
        (gfd >= 0 && gfd < MAX_FDS && this._fdRead(dv, gfd).fd_type === FD_TYPE_STDIN);
      if (isStdin) {
        X.vm_io_retry(this._vmPtr); // completes (sets a0 + status) or leaves pending
        // Still pending → the guest is parked on an idle interactive stdin read.
        // Let the run loop sleep until input arrives instead of busy-polling.
        this._blockedOnStdin = X.debug_status(this._vmPtr) === STATUS_FS_PENDING;
        return;
      }
    }

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

    if (syscallNr === SYS_EXECVE) {
      this._doExecve(dv, path, arg1, arg2);
      return;
    }

    if (syscallNr === SYS_CLONE) {
      // Serialized fork: snapshot the parent and run the child first (clone
      // returns 0 to the child). The parent is restored when the child exits.
      this._forkStack.push({ snap: this._forkSnapshot(), childPid: this._nextPid++ });
      this._setA0(dv, 0);
      dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
      return;
    }

    if (syscallNr === SYS_WAIT4) {
      const wpid = arg1 | 0; // -1 / 0 = any child
      const statusPtr = arg2 >>> 0;
      let zi = -1;
      for (let i = 0; i < this._zombies.length; i++) {
        if (wpid <= 0 || this._zombies[i].pid === wpid) { zi = i; break; }
      }
      if (zi >= 0) {
        const z = this._zombies.splice(zi, 1)[0];
        // wait status: WEXITSTATUS = (status >> 8) & 0xff.
        if (statusPtr) dv.setInt32(this._ramPtr + statusPtr, (z.exitCode & 0xff) << 8, true);
        this._setA0(dv, z.pid);
      } else {
        this._setA0(dv, -10); // ECHILD
      }
      dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
      return;
    }

    // Snapshot sentinel: detect openat for /dev/__snapshot__
    // writeFileSync will open, write, then close. We intercept the open
    // to assign a sentinel host_fd (-99), and intercept the write to that
    // fd to trigger the snapshot.
    if (syscallNr === SYS_OPENAT && path === "/dev/__snapshot__") {
      const newGfd = this._fdAlloc(dv);
      if (newGfd >= 0) {
        this._fdWrite(dv, newGfd, FD_TYPE_FILE, -99, 0, 0);
      }
      this._setA0(dv, newGfd >= 0 ? newGfd : -28);
      dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
      return;
    }

    // Network sentinel: openat /dev/__net__ assigns host_fd -98. The guest writes
    // a request ("METHOD URL\nHeader: v\n\nbody") then reads back an HTTP-like
    // response; the actual host fetch runs in the (async) run loop after close.
    if (syscallNr === SYS_OPENAT && path === "/dev/__net__") {
      if (this._netDisabled) { this._setA0(dv, -13); dv.setInt32(this._vmPtr + 528, STATUS_OK, true); return; } // EACCES
      const newGfd = this._fdAlloc(dv);
      if (newGfd >= 0) this._fdWrite(dv, newGfd, FD_TYPE_FILE, -98, 0, 0);
      this._setA0(dv, newGfd >= 0 ? newGfd : -28);
      dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
      return;
    }
    // Handle sentinel fd operations (host_fd === -99)
    if (gfd >= 0 && gfd < MAX_FDS) {
      const fe = this._fdRead(dv, gfd);
      if (fe.host_fd === -99) {
        if (syscallNr === SYS_WRITE) {
          // Pretend write succeeded
          const count = bufLen || arg1;
          this._setA0(dv, count);
          dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
          return;
        }
        if (syscallNr === SYS_FSTAT) {
          // Return fake regular file stat
          const statBufPhys = ramPtr + (arg1 >>> 0);
          new Uint8Array(this._memory.buffer, statBufPhys, 128).fill(0);
          const sdv = new DataView(this._memory.buffer, statBufPhys, 128);
          sdv.setUint32(16, 0o100644, true); // st_mode = regular file
          sdv.setUint32(20, 1, true);        // st_nlink
          sdv.setInt32(56, 4096, true);      // st_blksize
          this._setA0(dv, 0);
          dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
          return;
        }
        if (syscallNr === SYS_CLOSE) {
          // Close triggers the snapshot — writeFileSync is complete
          this._fdClear(dv, gfd);
          this._snapshotRequested = true;
          this._setA0(dv, 0);
          dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
          return;
        }
      }
      // Network sentinel fd (host_fd === -98): accumulate the request on write,
      // serve the buffered response on read; close after a write triggers fetch.
      if (fe.host_fd === -98) {
        if (syscallNr === SYS_WRITE) {
          const count = bufLen || arg1;
          (this._netReq = this._netReq || []).push(
            new Uint8Array(this._memory.buffer, ramPtr + bufPtr, count).slice());
          this._setA0(dv, count);
          dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
          return;
        }
        if (syscallNr === SYS_READ) {
          // First read after a written request (single-fd RDWR shim): fetch first,
          // then serve — the run loop awaits and calls _serveNetRead.
          if (this._netReq && this._netReq.length && !this._netResp) {
            this._asyncNet = { read: true, bufPtr, bufLen };
            return; // leave FS_PENDING; the run loop completes this read
          }
          this._serveNetRead(bufPtr, bufLen);
          return;
        }
        if (syscallNr === SYS_FSTAT) {
          const statBufPhys = ramPtr + (arg1 >>> 0);
          new Uint8Array(this._memory.buffer, statBufPhys, 128).fill(0);
          const sdv = new DataView(this._memory.buffer, statBufPhys, 128);
          sdv.setUint32(16, 0o100644, true); sdv.setUint32(20, 1, true); sdv.setInt32(56, 4096, true);
          this._setA0(dv, 0);
          dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
          return;
        }
        if (syscallNr === SYS_CLOSE) {
          this._fdClear(dv, gfd);
          // A request written then closed without reading (printf>; cat pattern):
          // fetch now so the next open+read serves it.
          if (this._netReq && this._netReq.length && !this._netResp) this._asyncNet = { read: false };
          this._setA0(dv, 0);
          dv.setInt32(this._vmPtr + 528, STATUS_OK, true);
          return;
        }
      }
    }

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
        if (fe.fd_type === FD_TYPE_STDIN) {
          const avail = this._stdinAvailable();
          if (avail > 0) {
            const count = bufLen || arg1;
            result = this._stdinDrain(ramPtr + bufPtr, Math.min(count, avail));
            break;
          }
          // No queued input. In interactive mode park the read (leave the VM
          // FS_PENDING so _runLoop re-polls) until writeStdin() supplies data;
          // otherwise preserve legacy EOF-on-empty semantics for batch runs.
          if (this._stdinInteractive && !this._stdinEof) return;
          result = 0;
          break;
        }
        if (fe.fd_type === FD_TYPE_PIPE) { result = this._pipeRead(fe.host_fd, ramPtr + bufPtr, bufLen || arg1); break; }
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
        if (fe.fd_type === FD_TYPE_PIPE) { result = this._pipeWrite(fe.host_fd, ramPtr + bufPtr, bufLen || arg1); break; }
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
