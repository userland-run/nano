# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NanoVM is a `#![no_std]` Rust WebAssembly emulator implementing an **RV64 RISC-V Linux userland emulator** targeting BusyBox and Node.js workloads in the browser. The architecture is defined in `.claude/skills/bellard/SKILL.md`.

## Build Commands

```bash
make build          # Default: fully-bundled wasm/nano.wasm (busybox + node + devenv)
make build-minimal  # Bare emulator (~585KB) — no bundled binaries
make devenv         # Build devenv Docker image + extract tarball (slow first time)
make clean          # cargo clean + remove wasm/nano.wasm
make serve          # Build + serve wasm/ on localhost:8080
make demo           # Build + copy WASM to demo + start vite dev server
make test           # Build minimal + run all tests (ELF + MemFS + BusyBox)
make test-devenv    # Build bundled + run all tests including devenv tools

# Fast iteration (type-check only, no linking):
cargo check --target wasm32-unknown-unknown
```

## Test Suite

Tests are in `test/` and run via Node.js:

```bash
bash test/run_tests.sh              # Run tests (requires wasm/nano.wasm)
bash test/run_tests.sh --build      # Build test ELFs first (requires cross-compiler)
bash test/run_tests.sh --devenv     # Include devenv tool tests (requires bundled WASM + images/node)

# Run single ELF test:
node test/run.mjs test/hello.elf

# Run busybox command:
node test/run.mjs images/busybox --cmd echo Hello

# Run with syscall tracing:
node test/run.mjs images/busybox --trace --cmd ls /tmp
```

**Test phases**: MemFS unit tests → ELF execution (hello, test_suite, test_rvc, test_memory, test_syscalls, test_float) → BusyBox smoke tests (17 applets) → Devenv tool tests (node, tsc, npm, eslint, prettier).

## Build Configuration

- **Target**: `wasm32-unknown-unknown` (Rust stable toolchain)
- **Crate type**: `cdylib` (produces `.wasm`)
- **Only dependency**: `libm` (math functions for no_std)
- **Release profile**: `opt-level = "z"`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`
- **Dev profile**: `opt-level = 1`, `codegen-units = 256` (fast incremental builds)
- **WASM memory**: 1MB stack, 4MB initial, 512MB max (set in `.cargo/config.toml`)
- **Features**: `demo` (default) — embeds busybox + node + devenv into the WASM data section

## Architecture

### Bellard-Style Monolithic Interpreter

The core design principle is a **single monolithic `exec()` function** with dense dispatch that compiles to WASM `br_table` (jump table). Source code is split across files marked `#[inline(always)]`; fat LTO with `codegen-units = 1` fuses them into one function at compile time.

### Key Architectural Rules (from SKILL.md)

- All VM structs must be `#[repr(C)]` for stable layout
- Hot CPU state lives in **locals inside `exec()`**, not repeated struct reads
- No heap allocation, trait objects, HashMap, or recursion in the CPU hot path
- Cooperative yielding via instruction budget counter
- Syscalls batched through shared memory request/response blocks
- Threading via SharedArrayBuffer + Web Workers; worker entrypoints take `vm_ptr: u32` explicitly

### Source Layout

- `src/cpu.rs` — Main RV64 interpreter loop (`exec()`) with instruction decode/dispatch
- `src/decode.rs` — Instruction decode helpers
- `src/syscall.rs` — Linux syscall dispatch (handles ~50 syscalls for BusyBox + Node.js)
- `src/mem.rs` — Guest memory access (read/write with bounds checking)
- `src/elf.rs` — ELF loader (parses segments, sets up stack with argv/envp/auxv)
- `src/types.rs` — VM struct layout (12680 bytes, `#[repr(C)]`, compile-time size assertion)
- `src/exports.rs` — WASM exports (vm_create, vm_step, vm_load_elf, debug_*, etc.)
- `src/alloc.rs` — Bump allocator for WASM linear memory
- `src/host.rs` — Host import declarations (console_write, debug_log, etc.)

### VM Struct Layout (types.rs, 12680 bytes)

Key offsets (must stay in sync with JS host code):
- `0..560` — CPU state (x[32], pc, f[32], fcsr, status, exit_code, budget, fault info)
- `560..600` — brk/memory (brk_start, brk_current, stack_limit)
- `600..2136` — fd_table[64] (24 bytes each: fd_type, host_fd, offset, flags)
- `2216..2768` — FsRequest (552 bytes: syscall_nr, fd, args, path[256], path2[256])
- `2768..2792` — FsResponse (24 bytes)
- `3680..3936` — cwd[256]
- `3936..3972` — run state (tid, run_status, ram_base, ram_size, heap_ptr)

### FS_PENDING Protocol

When the VM needs filesystem I/O:
1. Rust fills `FsRequest` struct (syscall_nr, fd, path, args)
2. Sets `vm.status = STATUS_FS_PENDING` (6)
3. JS host reads request, processes via MemFS, writes result to `a0` register
4. JS host resets `vm.status = STATUS_OK` (0)
5. VM resumes execution

### Host Boundary (JS ↔ WASM)

**WASM exports**: `vm_create`, `vm_step`, `vm_load_elf`, `vm_fs_request_ptr`, `vm_ram_ptr`, `vm_ram_size`, `vm_exit_code`, `debug_pc`, `debug_reg`, `debug_status`, `vm_bundled_*`

**WASM imports**: `memory` (SharedArrayBuffer), `console_write(fd, ptr, len)`, `debug_log(val)`, `abort_js()`, `emscripten_random()`, `emscripten_date_now()`

### Web Demo (`web/demo/`)

React + Vite app with three-panel IDE layout (FileTree, Editor, Preview/Console).

- `container/nanovm.mjs` — Browser NanoVM wrapper (imports WASM, provides high-level API)
- `container/memfs.mjs` — In-memory POSIX filesystem
- `web/demo/src/vm/runtime.ts` — Singleton VM management, wraps NanoVM for React
- `web/demo/src/vm/sw-bridge.ts` — Service Worker bridge for HTTP preview
- `web/demo/src/vm/examples.ts` — Example files seeded into VFS

The `@container` alias in vite.config.ts resolves to `container/` (project root).
