# RISC-V Runner (the emulator core)

The `riscv` runner is NanoVM's high-fidelity oracle: a `#![no_std]` Rust RV64GC RISC-V
emulator that compiles to WebAssembly and runs a full Linux userland — enough to execute
BusyBox, Node.js, and the npm/TypeScript toolchain — entirely in the browser with zero
server-side components. It is the slowest of the four runners but the reference for
correctness; the other tiers (`node`, `wasm`, `boa`) are validated against it. For how the
runners fit together, see [Architecture](architecture.md).

Its sources live under `runners/riscv/`: `src/` (the Rust emulator), `host/` (the JS host
wrapper), and `images/` (RV64 ELF binaries, tracked via Git LFS).

## Design Principles

The interpreter follows Fabrice Bellard's approach to high-performance interpreters:

- **Monolithic interpreter** — A single `exec()` function with dense dispatch compiles to WASM `br_table` (jump table). Source code is split across files with `#[inline(always)]`; fat LTO fuses everything back into one function.
- **Hot state in locals** — CPU registers (`x[32]`, `pc`, `f[32]`) are kept in local variables inside `exec()`, not repeatedly loaded from the VM struct.
- **No allocation in the hot path** — No heap allocation, trait objects, HashMap, or recursion in the CPU dispatch loop.
- **Cooperative yielding** — An instruction budget counter returns control to the JS host periodically, allowing the browser event loop to process I/O.
- **Minimal host boundary** — Only a handful of WASM imports. All filesystem I/O goes through a shared-memory request/response protocol, not per-instruction callbacks. See [Host API](host-api.md).

## Memory Layout

```
WASM Linear Memory
├── VM struct (12,680 bytes)         ← vm_create() allocates this
├── Guest RAM (configurable; demo    ← vm_create() allocates this
│   uses ~1.8GB, 2GB WASM max)

├── Scratch buffer (32KB)            ← malloc() for virtual server I/O
└── WASM data section                ← bundled ELFs, if any (see below)
```

Guest RAM hosts the ELF program text, heap (grows up via brk/mmap), and stack (grows down from top of RAM). The guest uses 64-bit virtual addresses that map directly to offsets within the RAM region.

The WASM data section only holds bundled ELFs when the build embeds them. The **default
build embeds nothing** (guest programs install on demand from the catalog); the legacy
`make build-full` bundle embeds busybox + node + devenv. See [Build Guide](build.md).

## Execution Model

```
                    ┌──────────────┐
                    │   Browser    │
                    │   (JS Host)  │
                    └──────┬───────┘
                           │ vm_step(budget)
                           ▼
                    ┌──────────────┐
                    │  WASM Module │
                    │   exec()     │◄── RV64 instruction loop
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         STATUS_OK   STATUS_FAULT  STATUS_FS_PENDING
         (continue)  (exit/trap)   (needs I/O)
```

1. JS calls `vm_step(vm_ptr, budget)` with an instruction budget
2. The Rust interpreter decodes and executes RISC-V instructions
3. On ECALL (syscall), the handler either:
   - Resolves it internally (brk, mmap, clock_gettime, socket ops, etc.)
   - Sets `STATUS_FS_PENDING` for filesystem I/O (JS must process via MemFS)
4. Execution returns when budget exhausted, process exits, or I/O needed

## RV64 Instruction Decode

RISC-V instructions are decoded from their fields:

```
opcode (7b) → primary dispatch lane
funct3 (3b) → secondary
funct7 (7b) → tertiary (ALU/shift variants)
```

These are compressed into a dense index for `match` dispatch. The WASM compiler lowers dense match arms into `br_table` instructions (O(1) jump tables).

Both 32-bit (RV64IMAFDC) and 16-bit compressed (RVC) instructions are supported. The decoder checks the low 2 bits: `0b11` = 32-bit, otherwise 16-bit compressed.

## VM Struct (12,680 bytes)

The `Vm` struct is `#[repr(C)]` with compile-time size assertion. Key regions:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 560 | CPU state: `x[32]`, `pc`, `f[32]`, `fcsr`, status, exit_code, budget, fault info |
| 560 | 40 | Memory: brk_start, brk_current, stack_limit |
| 600 | 1536 | fd_table[64] (24 bytes each: fd_type, host_fd, offset, flags) |
| 2216 | 552 | FsRequest (syscall_nr, fd, args, path[256], path2[256]) |
| 2768 | 24 | FsResponse |
| 2792 | 512 | mmap_entries[16] |
| 3320 | 40 | Signal state |
| 3360 | 16 | TLS (tls_base, clear_child_tid) |
| 3376 | 64 | Thread/pipe/eventfd state |
| 3680 | 256 | Current working directory |
| 3936 | 36 | Run state (tid, ram_base, ram_size, heap_ptr) |
| 3972 | 8708 | Thread area (16 slots x 544 bytes) |

These offsets are shared between Rust and the JS host — both sides must agree on the layout.

## Threading Model

The runner implements cooperative multithreading within a single WASM instance:

- **clone()** creates new thread slots in the thread area
- **futex** wait/wake provides synchronization
- **Context switching** happens at syscall boundaries (epoll_pwait, futex_wait)
- Thread state (registers, PC) is saved/restored from the 544-byte thread slots

This is sufficient for Node.js's libuv thread pool (UV_THREADPOOL_SIZE=0 disables worker threads; the main thread + event loop thread suffice). WASM linear memory is built shared, with `+atomics`/`+bulk-memory` enabled, so this threading is active — not a future capability.

## Terminal / Console model

Two source files implement the in-VM half of the terminal's model/render split:

- `term.rs` — the ANSI/`vte` parser plus the fixed-capacity cell grid that the guest's stdout byte stream renders into. It lives inside `nano.wasm` (no_std, no heap); the `terminal/` front-end reads the grid out of linear memory and draws it.
- `tty.rs` — the in-VM tty line discipline and stdin ring. The host pushes raw keystrokes via `vm_stdin_push`; this module applies cooked (ICANON) mode — echo, erase, ^C/^D, line buffering — or raw pass-through, and exposes the readable bytes to `read()`/`ppoll()`.

## Source Files (`runners/riscv/src/`)

| File | Purpose |
|------|---------|
| `runners/riscv/src/cpu.rs` | Main RV64GC interpreter loop with instruction decode/dispatch |
| `runners/riscv/src/decode.rs` | Instruction field extraction helpers |
| `runners/riscv/src/syscall.rs` | Linux syscall dispatch (~80 syscalls) — see [Syscalls](syscalls.md) |
| `runners/riscv/src/mem.rs` | Guest memory read/write operations |
| `runners/riscv/src/elf.rs` | ELF loader (segments, argv/envp/auxv stack setup) |
| `runners/riscv/src/types.rs` | VM struct definition (12,680 bytes, `#[repr(C)]`) |
| `runners/riscv/src/exports.rs` | WASM exports (vm_create, vm_step, vm_load_elf, debug_*, vm_inject_connection, etc.) |
| `runners/riscv/src/term.rs` | Terminal (VTE) Console model — ANSI parser + cell grid |
| `runners/riscv/src/tty.rs` | In-VM tty line discipline + stdin ring |
| `runners/riscv/src/alloc.rs` | Bump allocator for WASM linear memory |
| `runners/riscv/src/host.rs` | Host import declarations |
| `runners/riscv/src/lib.rs` | Crate root, panic handler |

The JS host wrapper is at `runners/riscv/host/nanovm.mjs` (imports the WASM, provides the
high-level API, registers the `vm` delegate with the kernel router) and
`runners/riscv/host/memfs.mjs` (re-exports the kernel MemFS at `kernel/vfs/memfs.mjs`).
