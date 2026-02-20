# NanoVM Architecture

NanoVM is a `#![no_std]` Rust RISC-V emulator that compiles to WebAssembly. It runs a full RV64GC Linux userland — enough to execute BusyBox, Node.js, and the npm/TypeScript toolchain — entirely in the browser with zero server-side components.

## Design Principles

The architecture follows Fabrice Bellard's approach to high-performance interpreters:

- **Monolithic interpreter** — A single `exec()` function with dense dispatch compiles to WASM `br_table` (jump table). Source code is split across files with `#[inline(always)]`; fat LTO fuses everything back into one function.
- **Hot state in locals** — CPU registers (`x[32]`, `pc`, `f[32]`) are kept in local variables inside `exec()`, not repeatedly loaded from the VM struct.
- **No allocation in the hot path** — No heap allocation, trait objects, HashMap, or recursion in the CPU dispatch loop.
- **Cooperative yielding** — An instruction budget counter returns control to the JS host periodically, allowing the browser event loop to process I/O.
- **Minimal host boundary** — Only 5 WASM imports. All filesystem I/O goes through a shared-memory request/response protocol, not per-instruction callbacks.

## Memory Layout

```
WASM Linear Memory
├── VM struct (12,680 bytes)         ← vm_create() allocates this
├── Guest RAM (configurable, ~512MB) ← vm_create() allocates this
├── Scratch buffer (32KB)            ← malloc() for virtual server I/O
└── WASM data section                ← bundled ELFs (busybox, node, devenv)
```

Guest RAM hosts the ELF program text, heap (grows up via brk/mmap), and stack (grows down from top of RAM). The guest uses 64-bit virtual addresses that map directly to offsets within the RAM region.

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

These offsets are shared between Rust and JS — both sides must agree on the layout.

## Threading Model

NanoVM implements cooperative multithreading within a single WASM instance:

- **clone()** creates new thread slots in the thread area
- **futex** wait/wake provides synchronization
- **Context switching** happens at syscall boundaries (epoll_pwait, futex_wait)
- Thread state (registers, PC) is saved/restored from the 544-byte thread slots

This is sufficient for Node.js's libuv thread pool (UV_THREADPOOL_SIZE=0 disables worker threads; the main thread + event loop thread suffice).

## Source Files

| File | Purpose |
|------|---------|
| `src/cpu.rs` | Main RV64GC interpreter loop with instruction decode/dispatch |
| `src/decode.rs` | Instruction field extraction helpers |
| `src/syscall.rs` | Linux syscall dispatch (~80 syscalls) |
| `src/mem.rs` | Guest memory read/write operations |
| `src/elf.rs` | ELF loader (segments, argv/envp/auxv stack setup) |
| `src/types.rs` | VM struct definition (12,680 bytes, `#[repr(C)]`) |
| `src/exports.rs` | WASM exports (vm_create, vm_step, vm_load_elf, debug_*, vm_inject_connection, etc.) |
| `src/alloc.rs` | Bump allocator for WASM linear memory |
| `src/host.rs` | Host import declarations |
| `src/lib.rs` | Crate root, panic handler |
