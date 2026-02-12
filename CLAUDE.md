# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**NanoVM** — a Rust reimplementation of Bellard's JSLinux/TinyEMU x86_64 emulator targeting WASM. The project has three parts:

1. **`src/`** — The Rust reimplementation. Compiles to a ~828KB WASM binary with a monolithic 660KB CPU interpreter function (via fat LTO fusion of paged source functions). Builds with `cargo build --target wasm32-unknown-unknown --release`.
2. **`jslinux/`** — Full extraction and decompilation of the original JSLinux Alpine x86_64 VM, captured from a live HAR trace of `bellard.org/jslinux/`. The original emulator is TinyEMU compiled from C to WASM via Emscripten. This is the reverse-engineering reference.
3. **`specs/IDEA.md`** — Rust architecture spec for the reimplementation. Key constraints: monolithic interpreter function (compiles to WASM `br_table`), lazy EFLAGS, software TLB, cooperative scheduling, no dynamic dispatch in hot path, `#[repr(C)]` structs, `opt-level = "z"` + LTO.

## VM Configuration (Original)

```javascript
// jslinux/alpine-x86_64.cfg
machine: "pc"             // PC platform emulation
memory_size: 256          // 256MB RAM
kernel: "kernel-x86_64.bin"
cmdline: "loglevel=3 console=hvc0 root=root rootfstype=9p rootflags=trans=virtio ro"
fs0: { file: "https://vfsync.org/u/os/alpine-x86_64" }  // 9p root filesystem via VFSync
eth0: { driver: "user" }  // User-mode networking (SLiRP)
```

---

## Build System

### Target & Toolchain
- Target: `wasm32-unknown-unknown`
- Build: `cargo build --target wasm32-unknown-unknown --release`
- Check: `cargo check --target wasm32-unknown-unknown` (0 errors, 0 warnings)

### Build Profiles

```toml
[profile.dev]
opt-level = 0        # Fast iteration
debug = 0
incremental = true
codegen-units = 256  # Max parallelism

[profile.release]
opt-level = "z"      # Size-optimize (best for interpreter i-cache)
lto = "fat"          # Fat LTO fuses page functions back into monolith
codegen-units = 1    # Single CGU for maximum optimization
panic = "abort"
strip = true
```

### Build Times & Binary Size

| Profile | Time | Binary | Notes |
|---------|------|--------|-------|
| Dev | ~20s | N/A | Fast iteration, no optimization |
| Release | ~3min | 828KB | Fat LTO reconstructs 660KB monolithic exec() |

### Paged Dispatch & LTO Fusion

The source code uses **paged dispatch** (32 page functions) for compiler ergonomics, but the WASM binary has a **single monolithic interpreter** thanks to LTO:

1. **Source**: `exec()` dispatches to `exec_page_0..f()` and `exec_0f_page_0..f()` — all marked `#[inline(always)]`
2. **Compile**: rustc compiles each page function as a manageable unit (no OOM)
3. **Link**: Fat LTO inlines all page functions back into `exec()` → one 660KB WASM function
4. **Result**: Bellard-style monolithic interpreter with br_table dispatch, identical to original architecture

The refactoring script `refactor.py` performs the mechanical page splitting and can be re-run after adding new opcodes.

---

## NanoVM Source Architecture

### Source Files

| File | Lines | Description |
|------|-------|-------------|
| `src/cpu.rs` | ~7400 | CPU interpreter: exec() dispatch + 16 main page fns + 16 0F page fns + helpers |
| `src/types.rs` | — | `#[repr(C)]` CPU struct, PrefixState, constants (register indices, flags, exception vectors) |
| `src/mem.rs` | — | Memory access: TLB lookup, page walk, load/store with fault handling |
| `src/flags.rs` | — | Lazy EFLAGS: set_lazy(), eval_cc(), materialize_flags() |
| `src/pic.rs` | — | 8259 PIC (dual master/slave, ICW/OCW state machine) |
| `src/pit.rs` | — | 8254 PIT (timer, IRQ 0) |
| `src/uart.rs` | — | 16550 UART (COM1, IRQ 4) |
| `src/pci.rs` | — | PCI config space with BAR size probing |
| `src/virtio.rs` | — | VirtIO common infrastructure |
| `src/virtio_console.rs` | — | VirtIO console (TX/RX queues, console_write) |
| `src/boot.rs` | — | Page tables, GDT, boot params, bzImage loader, VirtIO device registration |
| `src/exports.rs` | — | WASM exports: vm_init, vm_start, vm_step, load_kernel, console_queue_char, malloc/free |
| `web/nanovm.js` | — | JS host: WASM loader, import stubs, cooperative scheduler, keyboard |
| `refactor.py` | ~460 | Mechanical refactoring script: splits monolithic match into paged dispatch |

### CPU Dispatch Structure (cpu.rs)

```
exec() main loop:
  1. Check budget, interrupts, halt state
  2. Decode prefixes (REX, segment, 0x66, 0x67, LOCK, REP)
  3. Fetch opcode, compute lane (LANE16/LANE32/LANE64)
  4. match (opcode >> 4) → exec_page_X(cpu, ram, ram_size, opcode, lane)
     └─ Each page: match opcode { ... } with try_or_fault_page!
     └─ Page 0 contains 0x0F handler → match (op2 >> 4) → exec_0f_page_X(...)
  5. if fault { continue } else { next iteration }
```

All page functions are `#[inline(always)]` — fat LTO fuses them into a single WASM function.

### Macro Variants

- **`try_or_fault!`** — in exec() main loop, uses `continue` on fault
- **`try_or_fault_page!`** — in page functions, uses `return true` on fault (true = fault occurred)

### Inline Annotation Policy

| Category | Annotation | Examples |
|----------|-----------|----------|
| Tiny helpers | `#[inline(always)]` | fetch_imm8/16/32/64, read_reg8, write_reg8, raise_exception |
| Medium helpers | `#[inline]` | grp1_ev_imm, decode_modrm_addr, string_*, shift_op*, alu_* |
| Large helpers | none | exec_fpu, exec_sse_arith, exec_sse_int_op, exec_sse_shift_imm |
| Page functions | `#[inline(always)]` | exec_page_0..f, exec_0f_page_0..f (fused by LTO) |

### Page Breakdown (Main Dispatch)

| Function | Opcodes | Content |
|----------|---------|---------|
| `exec_page_0` | 0x00-0x0F | ALU byte ops (ADD/OR), AL imm, **0x0F prefix** → 0F sub-dispatch |
| `exec_page_1` | 0x10-0x1F | ALU ADC/SBB byte+word |
| `exec_page_2` | 0x20-0x2F | AND/SUB byte+word |
| `exec_page_3` | 0x30-0x3F | XOR/CMP byte+word |
| `exec_page_4` | 0x40-0x4F | (REX — handled in prefix loop, UD in non-64-bit) |
| `exec_page_5` | 0x50-0x5F | PUSH/POP reg |
| `exec_page_6` | 0x60-0x6F | PUSH imm, IMUL, INS/OUTS |
| `exec_page_7` | 0x70-0x7F | Jcc short |
| `exec_page_8` | 0x80-0x8F | GRP1, TEST, XCHG, MOV r/m, LEA, MOV seg |
| `exec_page_9` | 0x90-0x9F | NOP, XCHG AX, CBW/CWD, PUSHF/POPF, SAHF/LAHF |
| `exec_page_a` | 0xA0-0xAF | MOV moffs, string ops, TEST AX imm |
| `exec_page_b` | 0xB0-0xBF | MOV r8/r16/r32/r64 imm |
| `exec_page_c` | 0xC0-0xCF | GRP2 imm, RET, MOV r/m imm, ENTER/LEAVE, INT, IRET |
| `exec_page_d` | 0xD0-0xDF | GRP2 1/CL, XLAT, FPU D8-DF |
| `exec_page_e` | 0xE0-0xEF | LOOP, JCXZ, IN/OUT, CALL/JMP |
| `exec_page_f` | 0xF0-0xFF | HLT, CMC, GRP3, CLC/STC/CLI/STI/CLD/STD, GRP5 |

### Page Breakdown (0F Sub-dispatch)

| Function | op2 | Content |
|----------|-----|---------|
| `exec_0f_page_0` | 0x00-0x0F | GRP6/7, SYSCALL/SYSRET, WBINVD, UD2 |
| `exec_0f_page_1` | 0x10-0x1F | SSE MOV (MOVUPS/SS/SD, MOVHPS/LPS) |
| `exec_0f_page_2` | 0x20-0x2F | CR/DR MOV, SSE MOV/CVT, UCOMISS/SD |
| `exec_0f_page_3` | 0x30-0x3F | RDTSC, RDMSR/WRMSR |
| `exec_0f_page_4` | 0x40-0x4F | CMOVcc |
| `exec_0f_page_5` | 0x50-0x5F | MOVMSKPS, SSE logical, SSE arith |
| `exec_0f_page_6` | 0x60-0x6F | SSE packed int (PUNPCK, PACKSS, PCMPGT, MOVD/Q) |
| `exec_0f_page_7` | 0x70-0x7F | PSHUFD, SSE shift imm, PCMPEQ, EMMS |
| `exec_0f_page_8` | 0x80-0x8F | Jcc rel32 |
| `exec_0f_page_9` | 0x90-0x9F | SETcc |
| `exec_0f_page_a` | 0xA0-0xAF | PUSH/POP FS/GS, BT/BTS, SHLD/SHRD, IMUL |
| `exec_0f_page_b` | 0xB0-0xBF | CMPXCHG, MOVZX, MOVSX, BTR/BTC, BSF/BSR |
| `exec_0f_page_c` | 0xC0-0xCF | XADD, CMPPS, PINSRW/PEXTRW, SHUFPS, BSWAP |
| `exec_0f_page_d` | 0xD0-0xDF | SSE packed int (PSRL, PMULLW, MOVQ) |
| `exec_0f_page_e` | 0xE0-0xEF | SSE packed int (PAVGB, PMULHUW, POR, PADDSB) |
| `exec_0f_page_f` | 0xF0-0xFF | SSE packed int (PSLLW, PMULUDQ, PSADBW, PADDB) |

### Key Constants

| Constant | Value | Description |
|----------|-------|-------------|
| VirtIO console | PCI slot 1, BAR0 0xC000, IRQ 10 | Console device |
| VirtIO 9p | PCI slot 2, BAR0 0xC040, IRQ 11 | Filesystem device |
| PIC master | vectors 0x20-0x27 | Hardware interrupts 0-7 |
| PIC slave | vectors 0x28-0x2F | Hardware interrupts 8-15 |
| Kernel entry | 0x100000 | Physical load address |
| Boot params | 0x90000 | Linux boot protocol struct |
| Cmdline | 0x90880 | Kernel command line |

---

## Reference File Inventory

### Original Runtime Files (in `jslinux/`)

| File | Size | Description |
|------|------|-------------|
| `vm.html` | 864B | Minimal HTML shell — loads jslinux.js, mounts terminal |
| `style.css` | 2.2KB | Terminal and scrollbar styling |
| `jslinux.js` | 19KB | Main orchestrator — config parsing, VM lifecycle, display/keyboard/network/filesystem bridging |
| `term.js` | 43KB | Custom terminal emulator with VT100/xterm escape sequence handling, selection, scrollback |
| `x86_64emu-wasm.js` | 27KB | Emscripten JS glue — WASM instantiation, heap management, import function wiring, main loop |
| `x86_64emu-wasm.wasm` | 519KB | The x86_64 PC emulator binary (TinyEMU compiled to WASM) |
| `kernel-x86_64.bin` | 9.3MB | Linux kernel binary (bzImage format) |
| `alpine-x86_64.cfg` | 311B | VM configuration (JS object literal, not JSON) |
| `images/` | 4.5KB | Terminal UI assets (scrollbar, upload icon PNGs) |

### VFSync Root Filesystem (in `jslinux/vfsync/`)

| File | Size | Description |
|------|------|-------------|
| `vfsync/head` | 119B | VFSync metadata header (version 1, revision 9, ~16K files, ~1.6GB filesystem) |
| `vfsync/files/0000000000004053` | 863KB | Root filesystem directory tree |
| `vfsync/files/0000000000001ca3` | 2.4MB | BusyBox binary (provides /bin/sh and ~300 commands) |
| `vfsync/files/0000000000003cd9` | 786KB | Additional filesystem data |
| `vfsync/files/*` | various | Other filesystem nodes (configs, libraries, etc.) |

VFSync is Bellard's custom HTTP-based 9p filesystem protocol. The guest kernel mounts it as a virtio-9p device. Files are fetched on-demand from `vfsync.org` using numbered file IDs.

### Decompilation Outputs (in `jslinux/`)

| File | Size | Lines | Source Tool | Coverage |
|------|------|-------|-------------|----------|
| `x86_64emu.c` | 7.1MB | ~180K | wasm2c (WABT) | 100% — raw mechanical C translation of all WASM functions |
| `x86_64emu.h` | 4.1KB | 177 | wasm2c (WABT) | Header with all export/import declarations |
| `x86_64emu.dcmp` | 1.8MB | ~60K | wasm-decompile (WABT) | 100% — higher-level pseudocode with inferred types |
| `ghidra-decompiled.c` | 1.2MB | 40,938 | Ghidra 12.0.3 | 449/450 functions — typed C with variable names |
| `ghidra-functions.txt` | 64KB | 504 | Ghidra 12.0.3 | Function index: address, size, name, signature |
| `cpu-cases.c` | 198KB | 7,346 | Python (parsed from .dcmp) | CPU dispatch cases annotated with x86 opcode names |
| `ghidra-monster-asm.txt` | 682KB | 20,765 | Ghidra 12.0.3 | Control flow dump of the CPU function (blocks, branches, calls) |
| `ghidra-monster-chunks.c` | 82KB | 2,279 | Ghidra 12.0.3 | Attempted chunk decompilation (mostly failed — see notes) |
| `ghidra-monster-highpcode.c` | 128MB | 366K | Ghidra 12.0.3 | Raw p-code listing (very verbose, can be deleted) |
| `x86_64emu-wasm.wasm.i64` | 2.3MB | — | wasm2c | Intermediate (can be deleted) |

### Recommended Reading Order (for reverse engineering)

1. **`jslinux/ghidra-functions.txt`** — function index, find what you're looking for
2. **`jslinux/ghidra-decompiled.c`** — typed C for 449 helper functions (everything except the CPU loop)
3. **`jslinux/cpu-cases.c`** — annotated opcode handlers with x86 instruction names
4. **`jslinux/x86_64emu.dcmp`** — full pseudocode when you need complete context
5. **`specs/IDEA.md`** — Rust architecture spec for the reimplementation

---

## Architecture

### WASM Module Structure

- **504 total functions** (Ghidra count, including imports and thunks)
- **435 internal functions** (actual emulator code)
- **27 imported functions** (Emscripten builtins + I/O callbacks from JS)
- **17 exported functions** (VM API + memory management)

Function size distribution:
- 1 giant function (300KB) — the CPU interpreter loop
- 50 medium functions (1–10KB) — device emulation, memory management, instruction helpers
- 426 small functions (<1KB) — utility functions, flag computations, TLB ops

### Export Table (WASM → JS)

These are the public API functions exposed by the WASM module:

| Export | C Name | Signature | Description |
|--------|--------|-----------|-------------|
| `B` | `memory` | `WebAssembly.Memory` | Linear memory (heap) |
| `C` | `__wasm_call_ctors` | `void()` | Runtime initialization (called once at startup) |
| `D` | `console_queue_char` | `void(u32 char)` | Send a keystroke to the VM's console input |
| `E` | `console_resize_event` | `void()` | Notify VM that terminal dimensions changed |
| `F` | `display_key_event` | `void(u32 keycode, u32 down)` | Send keyboard event to graphical display |
| `G` | `__indirect_function_table` | `Table` | Function pointer table (for indirect calls) |
| `H` | `display_mouse_event` | `void(u32 dx, u32 dy, u32 buttons)` | Send mouse event to graphical display |
| `I` | `display_wheel_event` | `void(u32 delta)` | Send mouse wheel event |
| `J` | `net_write_packet` | `u32(u32 buf, u32 len, ...)` | Write an Ethernet frame to the virtual NIC |
| `K` | `net_set_carrier` | `void(u32 carrier)` | Set network link carrier state (up/down) |
| `L` | `vm_start` | `void(u32 cfg, u32 w, u32 h, ...)` | **Main entry point** — parse config, create VM, boot kernel |
| `M` | `free` | `void(u32 ptr)` | Heap free |
| `N` | `malloc` | `u32(u32 size)` | Heap malloc (5189 bytes — custom allocator) |
| `O` | `fs_import_file` | `void(u32 name, u32 buf, u32 len)` | Import a file into the VM's filesystem |
| `P` | `__emscripten_stack_restore` | `void(u32)` | Emscripten stack management |
| `Q` | `__emscripten_stack_alloc` | `u32(u32)` | Emscripten stack allocation |
| `R` | `_emscripten_stack_get_current` | `u32()` | Get current stack pointer |

### Import Table (JS → WASM)

Functions the WASM module calls out to the JS host:

| Import | JS Name | Signature | Description |
|--------|---------|-----------|-------------|
| `a` | `___assert_fail` | `void(u32, u32, u32, u32)` | Assertion failure handler |
| `b` | `_exit` | `void(u32)` | Process exit |
| `c` | `_file_buffer_write` | `void(u32, u32, u32, u32)` | Write data to a file buffer |
| `d` | `_file_buffer_read` | `void(u32, u32, u32, u32)` | Read data from a file buffer |
| `e` | `_emscripten_random` | `f32()` | Random number generator (`Math.random()`) |
| `f` | `_fs_wget_update_downloading` | `void(u32)` | Update filesystem download indicator |
| `g` | `_file_buffer_resize` | `u32(u32, u32)` | Resize a file buffer |
| `h` | `_file_buffer_init` | `void(u32)` | Initialize a file buffer |
| `i` | `_file_buffer_reset` | `void(u32)` | Reset a file buffer |
| `j` | `_emscripten_async_wget3_data` | `u32(u32 * 11)` | Async HTTP fetch (XHR) for network/filesystem |
| `k` | `_fd_write` | `u32(u32, u32, u32, u32)` | WASI fd_write (stdout/stderr) |
| `l` | `_emscripten_async_call` | `void(u32, u32, u32)` | Schedule async callback (setTimeout/rAF) |
| `m` | `_emscripten_date_now` | `f64()` | `Date.now()` — wall clock time |
| `n` | `_fs_export_file` | `void(u32, u32, u32)` | Export/download a file from VM to host |
| `o` | `_net_recv_packet` | `void(u32, u32, u32)` | Deliver received Ethernet frame to VM |
| `p` | `_console_write` | `void(u32, u32, u32)` | Write text to the terminal |
| `q` | `_fb_refresh` | `void(u32 * 7)` | Refresh framebuffer region (graphical display) |
| `r` | `_emscripten_resize_heap` | `u32(u32)` | Grow WASM linear memory |
| `s` | `_fd_seek` | `u32(u32, u64, u32, u32)` | WASI fd_seek (stub, returns 70=ENOSYS) |
| `t` | `_fd_close` | `u32(u32)` | WASI fd_close (stub, returns 52=ENOSYS) |
| `u` | `__gmtime_js` | `void(u64, u32)` | Convert timestamp to UTC struct tm |
| `v` | `__localtime_js` | `void(u64, u32)` | Convert timestamp to local struct tm |
| `w` | `__tzset_js` | `void(u32, u32, u32, u32)` | Initialize timezone data |
| `x` | `_clock_time_get` | `u32(u32, u64, u32)` | WASI clock_time_get (monotonic/realtime) |
| `y` | `__abort_js` | `void()` | Abort execution |
| `z` | `_file_buffer_set` | `void(u32, u32, u32, u32)` | Memset a file buffer region |
| `A` | `_console_get_size` | `void(u32, u32)` | Get terminal dimensions (cols, rows) |

---

## Key Functions (by Ghidra name)

### CPU Core

| Ghidra Name | Size | wasm-decompile | Role |
|-------------|------|----------------|------|
| `unnamed_function_184` | 300,899B | `f_cg` | **The CPU interpreter** — main execution loop with 769-entry br_table dispatching all x86_64 opcodes across 3 operand sizes. Too large for Ghidra's decompiler; see `cpu-cases.c` and `x86_64emu.dcmp`. |
| `unnamed_function_80` | 7,680B | `f_bq` | **Instruction decoder/prefix handler** — processes prefix bytes (REX 0x40-0x4F, segment overrides 0x26-0x3E, operand size 0x66, address size 0x67), fetches opcode via TLB, dispatches to CPU interpreter. |
| `unnamed_function_93` | 5,641B | `f_cd` | **ModR/M decoder + memory operand handler** — decodes addressing modes (register, [base+index*scale+disp]), computes effective addresses. |
| `unnamed_function_84` | 2,939B | `f_bu` | **Interrupt/exception delivery** — pushes CPU state, loads IDT vector, switches to kernel stack. |
| `unnamed_function_27` | 709B | `f_ba` | **Memory read with TLB** — translates virtual address, checks TLB, page walks on miss. |
| `unnamed_function_28` | 1,720B | `f_bb` | **Memory write with TLB** — translates virtual address for writes, handles page faults. |
| `unnamed_function_29` | 459B | `f_bc` | **Page table walker** — 4-level page walk (PML4→PDP→PD→PT) for address translation. |
| `unnamed_function_31` | 275B | `f_be` | **EFLAGS computation** — lazy flags: computes actual EFLAGS from saved operation type + operands. |
| `unnamed_function_32` | 239B | `f_bf` | **Conditional code evaluation** — evaluates x86 condition codes (JZ, JB, JL, etc.) from lazy flags. |

### FPU / SSE

| Ghidra Name | Size | Role |
|-------------|------|------|
| `unnamed_function_58` | 2,145B | x87 FPU long double (80-bit) division |
| `unnamed_function_59` | 2,138B | x87 FPU long double multiplication |
| `unnamed_function_64` | 1,852B | x87 FPU instruction dispatcher |
| `unnamed_function_166` | 5,826B | FPU/SSE instruction execution |
| `unnamed_function_156` | 5,542B | Extended FPU operations (FSIN, FCOS, FSQRT, etc.) |

### Devices & I/O

| Ghidra Name | Size | Role |
|-------------|------|------|
| `unnamed_function_133` | 3,935B | I/O port dispatch (IN/OUT instructions) |
| `unnamed_function_162` | 2,492B | PCI configuration space handler |
| `unnamed_function_183` | 1,697B | VirtIO device handler |
| `unnamed_function_191` | 1,944B | VirtIO queue processing |
| `unnamed_function_192` | 1,784B | VirtIO block device (disk I/O) |
| `unnamed_function_205` | 2,726B | VirtIO network device |
| `unnamed_function_371` | 5,645B | VirtIO 9p filesystem (VFSync bridge) |

### Memory Management

| Ghidra Name | Size | Role |
|-------------|------|------|
| `N` (malloc) | 5,189B | Custom heap allocator (dlmalloc variant) |
| `M` (free) | 1,538B | Heap free |
| `unnamed_function_37` | 391B | sbrk — grow heap |

### VM Lifecycle

| Ghidra Name | Size | Role |
|-------------|------|------|
| `L` (vm_start) | ~70 lines | Entry point: allocate machine struct, parse config, create devices, load kernel, start CPU loop |
| `unnamed_function_436` | 6,429B | Machine initialization — create CPU, RAM, PCI bus, interrupt controller, serial ports |
| `unnamed_function_453` | 3,288B | Config parser — parse JS-style config object into machine parameters |

---

## CPU Interpreter Architecture

The CPU core (`unnamed_function_184` / `f_cg`) uses a **threaded interpreter** pattern:

### Dispatch Structure
```
Main loop (loop L_a):
  1. Decrement instruction counter
  2. Check for interrupts/exceptions
  3. Fetch opcode byte via TLB
  4. br_table[769 entries] → jump to handler
     - Entries 0-255:   16-bit operand size
     - Entries 256-511:  32-bit operand size
     - Entries 512-767:  64-bit operand size
  5. Handler executes instruction
  6. goto step 1 (continue B_b)
```

### Sub-dispatch Tables
104 additional br_table dispatches handle:
- 0F-prefixed opcodes (two-byte opcodes: CMOVcc, SETcc, MOVZX, MOVSX, etc.)
- x87 FPU opcodes (D8-DF groups, ModR/M-based dispatch)
- Group opcodes (GRP1-GRP5, shifts, bit operations)
- SSE/MMX instruction families

### Lazy EFLAGS
Instead of computing all x86 flags after every ALU operation (expensive), TinyEMU stores:
- `20688[0]:int` — operation type code (ADD=2, SUB=7, AND=5, etc.)
- `20672[0]:long` — source operand
- `20680[0]:long` — result
- Actual EFLAGS are computed on-demand by `unnamed_function_31` when a conditional branch needs them.

There are ~26 operation types (0x00–0x1a), each with its own flag derivation formula.

### Software TLB
Address translation uses a 256-entry software TLB (4-way, indexed by virtual address bits):
- `DAT_ram_000054b0` / offset 38064 — TLB tag array (virtual page numbers)
- `DAT_ram_000054b8` / offset 38072 — TLB value array (physical page base + offset)
- `DAT_ram_0000b4b0` / offset 46256 — TLB set index (read/write/exec separation)

On TLB miss → `unnamed_function_29` walks the 4-level page table (CR3 → PML4 → PDP → PD → PT).

### Key Memory-Mapped State

These are global variables in WASM linear memory used by the CPU:

| Offset (decimal) | Content |
|-------------------|---------|
| 20536 | GPR base — 16 general-purpose registers (8 bytes each) |
| 20664 | RIP (instruction pointer) |
| 20672 | Lazy flags: source operand |
| 20680 | Lazy flags: result |
| 20688 | Lazy flags: operation type |
| 21168 | Code segment base (for virtual → linear translation) |
| 21417 | Long mode flag (64-bit mode active) |
| 21544 | CPL (current privilege level, 0=kernel, 3=user) |
| 21596 | Decoded instruction prefix state |
| 21600 | Instruction counter (remaining in timeslice) |
| 21608 | Current instruction fetch pointer (physical address into TLB) |
| 21616 | Instruction start pointer (for fault recovery) |
| 21624 | Code segment offset (IP → physical mapping) |
| 21632 | Last memory access result |
| 21656 | APIC/interrupt controller pointer |
| 38064 | TLB tag array start |
| 46256 | TLB set index |

---

## Decompilation Notes

### Why the CPU Function (300KB) Failed in Ghidra

Ghidra's native C++ decompiler (`decompile` process) has hard-coded internal limits on:
- Control flow graph node count
- SSA variable count and merge iterations
- Structural recovery algorithm complexity

The CPU function has 140,768 WASM instructions, 2,858 block structures, and 104 br_table dispatches. The decompiler returns `completed: false` with an empty error message — a silent bail, not a timeout. This is not configurable from Java settings (`maxPayloadMBytes`, `maxInstructions` have no effect because the bottleneck is in the native structural analysis).

**Workaround used:** Parsed the wasm-decompile output (which handles the full function as pseudocode) and split it by br_table case labels, annotating each handler with x86 opcode names → `cpu-cases.c`.

### What Each Tool Provides

- **wasm2c** (`x86_64emu.c`): Raw, mechanically correct C. Every WASM instruction maps to a C statement. Unreadable but 100% faithful. Good for verifying behavior.
- **wasm-decompile** (`x86_64emu.dcmp`): Higher-level pseudocode with control flow, some type inference. The only tool that handles the full CPU function. Uses label-based gotos for the dispatch.
- **Ghidra** (`ghidra-decompiled.c`): Best type recovery and variable naming. Proper C with `if/while/for`. Works on 449 of 450 functions. The decompiled output is the most readable for all non-CPU functions.

### Ghidra Project

The Ghidra project is saved at `/tmp/ghidra_jslinux/` and can be opened with the Ghidra GUI for interactive exploration. Requires:
- Ghidra 12.0.3 at `/opt/homebrew/ghidra_12.0.3_PUBLIC/`
- JDK 21 at `/opt/homebrew/opt/openjdk@21/`
- ghidra-wasm-plugin v2.4.0 (already installed in `Ghidra/Extensions/`)

```bash
# Open in GUI
JAVA_HOME="/opt/homebrew/opt/openjdk@21" /opt/homebrew/ghidra_12.0.3_PUBLIC/ghidraRun

# Re-run headless analysis
JAVA_HOME="/opt/homebrew/opt/openjdk@21" \
  /opt/homebrew/ghidra_12.0.3_PUBLIC/support/analyzeHeadless \
  /tmp ghidra_jslinux -process x86_64emu-wasm.wasm -noanalysis \
  -scriptPath /tmp -postScript YourScript.java
```

---

## Deletable Files

These can be removed to save ~130MB with no information loss:

| File | Size | Why |
|------|------|-----|
| `ghidra-monster-highpcode.c` | 128MB | Raw p-code listing — too verbose to be useful, all info is in other files |
| `ghidra-monster-chunks.c` | 82KB | Failed chunk decompilation attempt (562/564 chunks failed) |
| `x86_64emu-wasm.wasm.i64` | 2.3MB | wasm2c intermediate file |

---

## The Engineering of JSLinux

JSLinux boots a real Linux kernel to a working shell in **519KB of WASM**. No JIT, no threads, no SharedArrayBuffer. It runs in every browser shipped since 2017. This section examines the three engineering pillars that make it possible: speed, size, and portability.

### By the Numbers

| Metric | Value |
|--------|-------|
| WASM binary | 519KB (531KB on disk) |
| Total functions | 504 (27 imports, 17 exports, 435 internal + 25 thunks) |
| CPU interpreter function | 300,899 bytes — one function, 58% of the binary |
| br_table dispatch entries | 769 (256 per operand size × 3) + 104 sub-dispatches |
| JS↔WASM imports | 27 (20 real, 4 WASI stubs returning ENOSYS, 3 time helpers) |
| Kernel binary | 9.3MB (bzImage, the only large download) |
| Guest RAM | 256MB (WASM linear memory) |
| x87 FPU precision | 80-bit long double (software emulation) |

### Why It's Fast

**1. Threaded interpreter via `br_table`**

The entire CPU lives in a single 300KB WASM function (`unnamed_function_184`). Every x86 opcode dispatches through one `br_table` instruction — WASM's native jump table, which compiles to a hardware-indirect jump on every modern CPU. There are no indirect function calls, no vtable lookups, no switch/case chains. The loop is:

```
fetch opcode byte → br_table[opcode + (operand_size × 256)] → handler → loop back
```

The 769-entry table covers all three operand sizes (16/32/64-bit) in a single dispatch. An additional 104 `br_table` sub-dispatches handle two-byte opcodes (0F prefix), FPU groups (D8–DF), and group extensions (GRP1–GRP5). The entire flow stays within one WASM function activation frame — no call/return overhead between opcodes.

Evidence: `cpu-cases.c` contains 333 annotated case blocks across 7,346 lines; `ghidra-monster-asm.txt` shows the 20,765-line control flow graph.

**2. Lazy EFLAGS**

x86 has 6 status flags (CF, PF, AF, ZF, SF, OF) updated by every ALU instruction. Computing them all after every ADD, SUB, AND, etc. costs 20–40 operations per instruction. TinyEMU skips this entirely. After each ALU operation, it stores three values:

```
20688[0]:int = 2          // operation type (ADD=2, SUB=7, AND=5, OR=4, ...)
20672[0]:long = source     // left operand
20680[0]:long = result     // computed result
```

That's 3 memory stores instead of ~30 flag computations. Actual EFLAGS are materialized on-demand — only when a conditional branch (`Jcc`), `PUSHF`, or `LAHF` reads them. The materializer (`unnamed_function_31`, just 275 bytes) switches on the operation type and operand size to reconstruct the exact flags. There are 26 operation type codes (0x00–0x1a), each with its own derivation formula.

Most x86 code does several ALU operations between flag-reading instructions, so the deferred flags are often overwritten before anyone reads them. The savings compound: in a tight loop doing `add/cmp/jne`, only the `cmp` result matters.

**3. Software TLB**

Virtual-to-physical translation is the most-called operation in any x86 emulator. TinyEMU uses a 256-entry software TLB, 4-way set-associative, indexed by virtual address bits:

```c
// TLB index computation (from ghidra-decompiled.c, unnamed_function_27 line 57)
index = (vaddr >> 8 & 0xff0) + set * 0x1000;

// Tag comparison
if (tlb_tags[index] == (vaddr & 0xfffffffffffff000)) {
    // HIT: physical_addr = tlb_values[index] + (vaddr & 0xfff)
}
```

On hit: 3 operations (index, compare, add). On miss: full 4-level page walk through PML4→PDP→PD→PT (`unnamed_function_29`, 459 bytes). The TLB arrays live at fixed offsets in linear memory (tags at offset 38064, values at 38072), so access is a constant-offset load — no pointer chasing.

**4. Monolithic function = register allocation**

Because the CPU loop is one function, WASM engines can allocate hot state (RIP, decoded operand, memory access result) to machine registers. If the interpreter were split across functions, every opcode handler would need to save/restore registers across call boundaries. The 300KB function pays a one-time JIT compilation cost at startup, then runs at near-native speed with all hot variables in registers.

**5. Zero-copy I/O**

JS ↔ WASM data sharing uses TypedArray views (`HEAP8`, `HEAP32`, `HEAPU8`) over the same `ArrayBuffer` backing WASM linear memory. When JS writes a network packet into the guest, it's a `HEAPU8.set(buf, wasm_addr)` — a memcpy into the WASM heap, no serialization. The guest reads it directly. Same for framebuffer updates: `_fb_refresh` passes a pointer to pixel data already in WASM memory; JS reads it out via `HEAPU8.subarray()`.

**Instruction cost comparison (approximate WASM ops per x86 instruction):**

| x86 Instruction | WASM Ops | Notes |
|-----------------|----------|-------|
| MOV reg, reg | ~6 | Load source reg, store to dest reg, update RIP |
| ADD reg, reg | ~10 | Load operands, add, store result + 3 lazy flag stores |
| CALL rel32 | ~9 | Compute target, push return addr, update RSP + RIP |
| CMP + Jcc | ~12 | SUB (no store) + flag stores + materialize + branch |
| MOV reg, [mem] | ~15 | TLB lookup (3 ops on hit) + load + reg store |
| DIV r/m64 | ~25 | Full division with exception check |

Compare to hardware-accurate simulators that cost 100–500 host instructions per guest instruction.

### Why It's Small (519KB)

**1. Minimal hardware emulation**

TinyEMU implements only what Linux strictly needs to boot:

| Emulated | NOT Emulated |
|----------|-------------|
| CPU (x86_64, long mode, ring 0/3) | ACPI, SMM, real mode BIOS |
| MMU (4-level paging, NX, WP) | IOMMU, PCID, 5-level paging |
| PIC (8259 dual) + PIT (8254) | APIC, HPET, TSC deadline |
| UART (16550, 1 port) | USB, audio, GPU, SMP |
| VirtIO (block, net, 9p, console) | IDE, AHCI, NVMe, e1000 |
| PCI (type 0 config space) | PCIe, MSI-X, hot-plug |

No BIOS, no UEFI, no firmware boot sequence. The kernel is loaded directly into WASM linear memory at the right address. This eliminates not just the firmware code but all the legacy initialization paths in the emulator.

**2. Delegation to the browser**

Every I/O device that would normally require thousands of lines of C is replaced by a JS callback:

| Function | C Code Replaced | JS Implementation |
|----------|----------------|-------------------|
| `_console_write(ctx, buf, len)` | UART TX FIFO, baud rate, interrupts | `term.write(String.fromCharCode(...))` |
| `_fb_refresh(ctx, data, x, y, w, h, stride)` | VGA controller, mode setting, VRAM | `ctx.putImageData(imageData, x, y)` |
| `_net_recv_packet(ctx, buf, len)` | Full NIC emulation, DMA, ring buffers | WebSocket relay to proxy server |
| `_emscripten_async_wget3_data(...)` | 9p filesystem server, block cache | XHR to VFSync HTTP API |
| `_emscripten_date_now()` | RTC chip, CMOS battery, NTP | `Date.now()` |
| `_emscripten_random()` | Hardware RNG, `/dev/random` entropy | `Math.random()` |

The entire I/O boundary is 27 function imports. The browser runtime provides what would otherwise require 10,000+ lines of C device model code.

**3. No JIT compiler**

TinyEMU is a pure interpreter. JIT engines like QEMU's TCG are 10–50MB because they include code generators, register allocators, and optimization passes for multiple host architectures. TinyEMU trades per-instruction speed for an order-of-magnitude size reduction — and WASM's own JIT compiler makes up some of the difference.

**4. No standard library**

The binary contains a custom `malloc` (5,189 bytes) and `free` (1,538 bytes) — a dlmalloc variant. No libc. Of the 27 imports, 4 are WASI stubs that return `ENOSYS` (`fd_seek`, `fd_close`) or are never called. The actual libc surface used: `assert`, `exit`, `abort`, `gmtime`, `localtime`, `tzset`. Everything else is custom.

**5. Emscripten size optimization**

The binary was compiled with `-Os` (optimize for size). All internal function names are stripped — exports are single letters (`L` = `vm_start`, `N` = `malloc`, `D` = `console_queue_char`). Dead code elimination removes any TinyEMU feature not reachable from the configured machine type.

### Why It's Portable

**1. No system calls needed**

The entire WASM module requires only: `malloc`/`free` (self-contained), `Math.random()`, `Date.now()`, `setTimeout`, `XMLHttpRequest`, and `String.fromCharCode()`. These are available in every browser since IE10, in Node.js, in Deno, in embedded WebViews, and in Cloudflare Workers. There are no filesystem calls, no network sockets, no process management.

**2. Cooperative timeslicing**

TinyEMU cannot monopolize the browser's main thread. It uses an instruction counter at offset 21600 in WASM linear memory — the CPU loop decrements it on every instruction and yields when it hits zero. The yield path:

```
CPU loop → counter reaches 0 → return to Emscripten scheduler
  → _emscripten_async_call(func, arg, millis)
    → millis >= 0: safeSetTimeout(wrapper, millis)
    → millis < 0:  safeRequestAnimationFrame(wrapper)
  → browser event loop runs (DOM updates, input events, network)
  → timer fires → getWasmTableEntry(func)(arg)
    → CPU loop resumes
```

No threads. No `SharedArrayBuffer`. No `Worker`. The emulator yields cooperatively and resumes via a callback, using Emscripten's indirect function table (`__indirect_function_table`) to bridge C function pointers with JS scheduling.

**3. Memory-mapped I/O → JS callbacks**

Device reads and writes in the C emulator map directly to imported JS functions. When the guest kernel writes to the UART data register, the emulator calls `_console_write(ctx, buf, len)` — which is a JS function that appends characters to the terminal. The mapping is static and complete at link time: 27 imports cover all I/O. No dynamic dispatch, no plugin system, no device discovery.

**4. Single-threaded by design**

No `pthread_create`, no `Atomics`, no `SharedArrayBuffer`, no `Worker`. This means:
- No `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers required
- No browser security restrictions on embedding
- Works in older browsers (Chrome 57+, Firefox 52+, Safari 11+)
- Works in WebViews (iOS WKWebView, Android WebView)
- Works in server-side runtimes (Node.js, Deno, Bun)
- No race conditions, no synchronization bugs

The trade-off: a single-threaded emulator can't use multiple host cores. But for a 256MB guest VM running Alpine Linux, one core is more than sufficient.

**5. On-demand filesystem**

The 9.3MB kernel is the only file downloaded at boot. The root filesystem is served lazily via VFSync — Bellard's custom HTTP protocol where the guest kernel's virtio-9p driver triggers XHR fetches (`_emscripten_async_wget3_data`) as files are accessed. The guest sees a normal filesystem; the host fetches content on demand. No need to bundle or pre-download a root filesystem image.

### What Bellard Chose NOT to Implement

These deliberate omissions are as important as the features:

| Omitted | Why It Matters |
|---------|---------------|
| **JIT compilation** | Would add 10–50MB, require host-specific code generation. WASM's own JIT compensates. |
| **SMP (multi-core)** | Would require SharedArrayBuffer + atomics, breaking portability. Single-core suffices for a shell. |
| **ACPI / power management** | Linux can boot without it. Saves ~5KB of device code and complex table generation. |
| **USB stack** | Replaced by VirtIO devices. USB would add ~20KB for HCI + hub + device class drivers. |
| **BIOS/UEFI firmware** | Direct kernel loading skips 100KB+ of firmware code and the entire real-mode boot path. |
| **GPU / display driver** | Canvas `putImageData()` replaces an entire VGA/SVGA emulator (~15KB). |
| **Sound** | No audio device. Would need Web Audio API integration + codec support. |
| **Accurate timing** | PIT/TSC don't track real wall-clock time precisely. Good enough for `sleep` and scheduling. |
| **x86 real mode** | No 16-bit boot. Kernel starts directly in protected/long mode. |
| **Hardware RNG** | `Math.random()` via Emscripten import. No RDRAND/RDSEED instruction emulation needed. |

Each omission removes not just code, but entire categories of complexity: interrupt routing, DMA engines, memory-mapped register banks, and the guest driver interfaces to match. The result is an emulator where 95% of functions (426 of 449) are under 1KB — the codebase is almost entirely "small functions calling other small functions," with one giant dispatch loop at the center.
