# NanoVM Implementation Plan

## Context

NanoVM is a Rust reimplementation of Bellard's JSLinux/TinyEMU x86_64 emulator targeting WASM. The original boots Alpine Linux in 519KB of WASM with no JIT, no threads, no SharedArrayBuffer. We have complete reverse-engineering documentation (CLAUDE.md), a Rust architecture spec (specs/IDEA.md), and decompiled reference files (jslinux/) to build from. No Rust code exists yet.

**Goal**: Produce a WASM binary that boots the same Linux kernel to a working shell, architecturally equivalent to Bellard's design.

**Architectural constraints** (from Bellard skill):
- Single monolithic `exec()` function (>100KB WASM, compiles to `br_table`)
- Dense `match` dispatch: 769 entries (256 opcodes x 3 operand sizes)
- Lazy EFLAGS: 3 stores per ALU op, 26 operation types, materialize on-demand
- Software TLB: 256 sets x 4 ways, 3 ops on hit, 4-level page walk on miss
- Cooperative scheduling via instruction budget counter
- `#[repr(C)]` flat structs, `unsafe` raw pointers, no heap alloc in CPU loop
- Build: `opt-level="z"`, `lto="fat"`, `codegen-units=1`, `panic="abort"`, `strip=true`
- Target: `wasm32-unknown-unknown` (`cdylib`)

---

## Phase 0: Project Scaffold & Build System
**Size: S** | **Depends on: nothing**

### Files to create
- `Cargo.toml` — package "nanovm", edition 2021, crate-type cdylib, release profile from IDEA.md
- `rust-toolchain.toml` — pin wasm32-unknown-unknown target
- `src/lib.rs` — crate root with `#![no_std]`, re-exports
- `web/index.html` — minimal HTML shell (modeled on jslinux/vm.html)
- `web/nanovm.js` — JS loader stub that instantiates the WASM module with import stubs
- `Makefile` — `cargo build --target wasm32-unknown-unknown --release`

### Verify
- `cargo build --target wasm32-unknown-unknown --release` succeeds
- `.wasm` file produced, HTML page loads it without errors

### Reference
- `specs/IDEA.md` lines 25-42 (Cargo.toml template)
- `jslinux/vm.html`, `jslinux/x86_64emu-wasm.js` (HTML/JS patterns)

---

## Phase 1: Core Data Structures & Host Interface
**Size: M** | **Depends on: Phase 0**

### Files to create
- `src/types.rs` — all `#[repr(C)]` structs following IDEA.md templates:
  - `FlagOp` enum (26 variants, `#[repr(u8)]`)
  - `LazyFlags` { op, width, lhs, rhs, res }
  - `TlbEntry` { tag, host_page, perms }
  - `Tlb` { sets: [[TlbEntry; 4]; 256] } — separate arrays for read/write/exec
  - `Cpu` { regs: [u64; 16], rip, rflags, cr0/cr3/cr4, lazy, tlb, segs, long_mode, cpl, ... }
  - `Machine` { cpu, ram: *mut u8, ram_size, device pointers }
- `src/host.rs` — `extern "C"` declarations for all 27 JS imports (console_write, emscripten_async_call, etc.)
- `src/exports.rs` — `#[no_mangle] pub extern "C"` stubs for all exports (vm_start, console_queue_char, vm_step, malloc, free, etc.)

### Verify
- Compiles to WASM; `wasm-objdump -x` shows correct exports/imports
- JS host instantiates module cleanly

### Reference
- `specs/IDEA.md` lines 52-117 (struct templates)
- SKILL.md cpu_state_offsets section (field layout reference)
- CLAUDE.md export/import tables

---

## Phase 2: Memory Subsystem — TLB & Page Walker
**Size: M** | **Depends on: Phase 1** | **Parallel with: Phases 3, 4**

### Implement in `src/mem.rs`
- `tlb_lookup(vaddr) -> Option<*mut u8>` — `#[inline(always)]`, 3 ops on hit: index, compare, add. Formula: `(vaddr >> 8 & 0xff0) + set * 0x1000`
- `tlb_insert(vaddr, host_page)` — evict way 0 of set
- `walk_page_tables(cr3, vaddr) -> Result<u64, Fault>` — 4-level: PML4->PDP->PD->PT. Check Present, R/W, U/S, NX bits. Set Accessed/Dirty.
- `load_u8/u16/u32/u64(vaddr)` — TLB lookup, page walk on miss, handle unaligned cross-page
- `store_u8/u16/u32/u64(vaddr, val)` — same with write TLB
- `tlb_flush_all()`, `tlb_flush_page(vaddr)` — fill with 0xFFFFFFFFFFFFFFFF

All use `read_unaligned`/`write_unaligned` on `(ram + phys_addr) as *const T` per IDEA.md pattern.

### Verify
- Unit test: set up page tables in raw memory, walk succeeds, TLB caches result
- Test unaligned cross-page reads/writes
- Test permission faults

### Reference
- `jslinux/ghidra-decompiled.c` unnamed_function_27 (TLB read), unnamed_function_28 (TLB write), unnamed_function_29 (page walk)
- `specs/IDEA.md` lines 125-164 (tlb_lookup, load_u8 templates)

---

## Phase 3: Instruction Decoder — Prefixes & ModR/M
**Size: L** | **Depends on: Phase 1** | **Parallel with: Phases 2, 4**

### Implement as inline code/macros within CPU exec()
- **Prefix loop** (before main dispatch): process REX (0x40-0x4F), segment overrides (0x26/0x2E/0x36/0x3E/0x64/0x65), operand size (0x66), address size (0x67), LOCK (0xF0), REP/REPNE (0xF2/0xF3). Store in prefix state word.
- **ModR/M decoder** (`#[inline(always)]`): parse mod/reg/rm fields, SIB byte, displacement. Handle all x86-64 addressing modes (reg direct, [base], [base+disp8/32], [base+index*scale+disp], RIP-relative).
- **Opsize lane computation**: `opcode + (lane << 8)` where lane = 0 (16-bit), 1 (32-bit), 2 (64-bit)

### Verify
- Test REX.W/R/X/B combinations
- Test all ModR/M addressing modes including SIB
- Test RIP-relative addressing

### Reference
- `jslinux/ghidra-decompiled.c` unnamed_function_80 (prefix handler, 7680B), unnamed_function_93 (ModR/M, 5641B)
- `jslinux/cpu-cases.c` lines 1-50 (shows how decoder is called)

---

## Phase 4: Lazy EFLAGS & Condition Codes
**Size: M** | **Depends on: Phase 1** | **Parallel with: Phases 2, 3**

### Implement in CPU struct methods
- `set_lazy(op, width, lhs, rhs, res)` — `#[inline(always)]`, 3 stores per IDEA.md template
- `materialize_flags()` — switch on op type (26 codes) + width (8/16/32/64) to compute CF, PF, AF, ZF, SF, OF:
  - CF: ADD → `res < lhs`; SUB → `lhs < rhs`; shifts → from source bit
  - ZF: `res == 0` (masked to width)
  - SF: `res >> (width-1) & 1`
  - OF: ADD → same-sign inputs, different-sign result; SUB → dual
  - PF: parity of low byte (precomputed 256-byte lookup table)
  - AF: `(lhs ^ rhs ^ res) & 0x10`
- `eval_cc(cc: u8) -> bool` — evaluate condition codes 0-15 (O, NO, B, NB, Z, NZ, BE, NBE, S, NS, P, NP, L, NL, LE, NLE)

### Verify
- Unit tests for each flag op type with known inputs/expected flags
- Test all 16 condition codes

### Reference
- `jslinux/ghidra-decompiled.c` unnamed_function_31 (materializer, 275B), unnamed_function_32 (condition eval, 239B)
- `jslinux/cpu-cases.c` — grep `20688\[0\]:int =` to catalog all operation type codes

---

## Phase 5: Monolithic CPU Interpreter — Opcode Handlers
**Size: XL** | **Depends on: Phases 2, 3, 4** | **Critical path**

### Implement `Cpu::exec()` in `src/cpu.rs`

Single function, dense `match idx` with 769 arms. Structure from IDEA.md:

```rust
pub unsafe fn exec(&mut self, mach: &mut Machine, mut budget: i32) -> i32 {
    loop {
        if budget <= 0 { return budget; }
        budget -= 1;
        // prefix loop → fetch opcode → compute idx
        let idx = opcode as u32 + ((opsize_lane as u32) << 8);
        match idx {
            // 769 arms here
            _ => { /* unimplemented */ }
        }
    }
}
```

### Implementation batches (ordered by Linux boot dependency)

**Batch A — Core** (minimum for early kernel execution):
- ALU: ADD, SUB, AND, OR, XOR, CMP, TEST, NOT, NEG, INC, DEC, ADC, SBB
- MOV: reg/reg, reg/imm, reg/mem, mem/reg, MOVZX, MOVSX, MOVSXD
- Stack: PUSH, POP, CALL rel32, RET, ENTER, LEAVE
- Control: JMP rel8/32, Jcc rel8/32, LOOP/LOOPZ/LOOPNZ
- LEA, XCHG, NOP, CBW/CWDE/CDQE, CWD/CDQ/CQO

**Batch B — System** (required for kernel mode transitions):
- INT, IRET, SYSCALL, SYSRET, HLT, CLI/STI
- CR/DR access: MOV CRn, MOV DRn
- GDT/IDT/LDT: LGDT, LIDT, LLDT, SGDT, SIDT, STR, LTR
- CPUID, RDMSR, WRMSR, RDTSC, INVLPG, WBINVD
- PUSHF/POPF, LAHF/SAHF, CLC/STC/CMC/CLD/STD

**Batch C — Extended** (needed for full kernel boot):
- Shifts/rotates: SHL, SHR, SAR, ROL, ROR, RCL, RCR (GRP2)
- Group instructions: GRP1 (imm ALU), GRP3 (TEST/NOT/NEG/MUL/DIV), GRP4/5
- MUL, IMUL, DIV, IDIV
- String ops: MOVS, CMPS, STOS, LODS, SCAS + REP/REPNE
- CMOVcc, SETcc, BT/BTS/BTR/BTC, BSF/BSR, BSWAP, XADD, CMPXCHG
- I/O: IN, OUT (port-mapped device access)

**Batch D — FPU/SSE** (needed for userspace):
- x87 FPU: D8-DF opcode groups, FPU register stack, FADD/FSUB/FMUL/FDIV, FLD/FST, FILD/FISTP, FSIN/FCOS/FSQRT, FCOM/FCOMI
- SSE2 basics: MOVAPS, MOVUPS, MOVD, MOVQ, XORPS (Linux kernel uses these for optimized memcpy)

### Verify
- Per-instruction unit tests: set state, execute, check result + flags
- Integration: hand-assembled programs (fibonacci, memcpy loop)
- `wasm-objdump -d` confirms br_table generation for the match

### Reference
- `jslinux/cpu-cases.c` — all 333 annotated handlers (primary blueprint)
- `jslinux/x86_64emu.dcmp` — full pseudocode when cpu-cases.c is unclear
- `specs/IDEA.md` lines 209-269 (exec() template with example handlers)

---

## Phase 6: Interrupt Controller (PIC) & Timer (PIT)
**Size: M** | **Depends on: Phase 5 Batch B**

### Implement
- **PIC (8259 dual)**: master ports 0x20-0x21, slave 0xA0-0xA1. ICW1-4 init, OCW1-3, IRQ masking, priority resolution, EOI, vector delivery.
- **PIT (8254)**: ports 0x40-0x43. Channel 0 system timer (IRQ 0), mode 2/3, counter readback. At yield points, check elapsed time and inject IRQ 0.
- **Interrupt delivery**: check IF flag, acknowledge from PIC, push RFLAGS/CS/RIP, load IDT vector, switch CPL if crossing privilege boundary.

### Verify
- PIC init + mask + deliver IRQ → correct vector dispatched
- PIT timer fires at expected intervals
- Exception delivery (div-by-zero, page fault) works

### Reference
- `jslinux/ghidra-decompiled.c` unnamed_function_133 (I/O port dispatch), unnamed_function_84 (interrupt delivery)
- `jslinux/ghidra-decompiled.c` unnamed_function_436 line 37540 (PIC setup)

---

## Phase 7: UART (Serial Console)
**Size: S** | **Depends on: Phase 6** | **HELLO WORLD MILESTONE**

### Implement
- **16550 UART** on ports 0x3F8-0x3FF: THR (write → `console_write` import), RBR (read → `console_queue_char` queue), IER, IIR, LCR, LSR, MCR registers.
- Wire `console_write` host import to JS terminal output.
- Wire `console_queue_char` export to keyboard input queue.

### Verify — FIRST MILESTONE
- Load a custom flat binary "mini-kernel" that writes "Hello from NanoVM" to UART
- Characters appear in the browser terminal
- Proves: memory, instruction execution, I/O dispatch, and host imports all work end-to-end

### Reference
- `jslinux/x86_64emu-wasm.js` `_console_write` implementation
- `jslinux/jslinux.js` lines 507-514 (console function wiring)

---

## Phase 8: PCI Bus
**Size: M** | **Depends on: Phase 6**

### Implement
- **PCI config space**: address port 0xCF8, data port 0xCFC-0xCFF
- Type 0 config (256 bytes/device): vendor/device ID, class, BARs, interrupt line/pin
- Device registration: each VirtIO device gets a PCI slot
- PCI vendor 0x1AF4 (Red Hat), device IDs for VirtIO types

### Verify
- Write 0xCF8, read 0xCFC → correct config space data
- Enumerate devices, see VirtIO vendor/device IDs

### Reference
- `jslinux/ghidra-decompiled.c` unnamed_function_162 (PCI config), unnamed_function_44 (I/O registration)
- `jslinux/ghidra-decompiled.c` unnamed_function_436 lines 37530-37542 (device setup)

---

## Phase 9: VirtIO Devices
**Size: L** | **Depends on: Phase 8**

### Implement (in priority order)
1. **VirtIO common**: virtqueue (descriptor table, available ring, used ring), device status, feature negotiation
2. **VirtIO console** (type 3): transmit queue → `console_write`, receive queue ← `console_queue_char`. This is what `console=hvc0` uses.
3. **VirtIO 9p** (type 9): 9p protocol messages via virtqueue → host XHR to VFSync (`emscripten_async_wget3_data`). On-demand filesystem.
4. **VirtIO block** (type 2): sector read/write via virtqueue (lower priority)
5. **VirtIO network** (type 1): Ethernet frames via virtqueue → WebSocket (lowest priority)

### Verify
- VirtIO console: kernel boot messages appear in terminal
- VirtIO 9p: kernel mounts root filesystem, `ls /` works

### Reference
- `jslinux/ghidra-decompiled.c` unnamed_function_183 (VirtIO handler), unnamed_function_191 (virtqueue), unnamed_function_371 (9p)
- `jslinux/x86_64emu-wasm.js` `_emscripten_async_wget3_data` (VFSync HTTP)

---

## Phase 10: Kernel Loading & Boot Sequence
**Size: M** | **Depends on: Phases 5-9** | **LINUX BOOT MILESTONE**

### Implement
- **bzImage loader**: validate magic (0x55AA at 0x1FE, "HdrS" at 0x202), parse setup header, copy protected-mode code to 0x100000, set up zero page (boot_params) at 0x90000, command line at 0x90880
- **Initial page tables**: identity-map first 4GB, set up PML4/PDP/PD entries
- **GDT**: flat code/data segments for protected + long mode
- **CPU init state**: CR0 (PE+PG), CR3 (page table base), CR4 (PAE), EFER (LME+LMA), CS/SS selectors, RIP → 0x100000
- **Machine init**: allocate 256MB RAM, create all devices, load kernel, start exec loop
- **vm_start export**: parse config params, orchestrate the above

### Verify — LINUX BOOT MILESTONE
- Load real `kernel-x86_64.bin` (9.3MB)
- Kernel decompresses, initializes, prints boot messages
- Reaches login prompt

### Reference
- `jslinux/ghidra-decompiled.c` unnamed_function_436 (full machine init, 6429B)
- `jslinux/ghidra-decompiled.c` function L at line 29712 (vm_start)
- `jslinux/alpine-x86_64.cfg` (config params)

---

## Phase 11: JS Host & Cooperative Scheduler
**Size: M** | **Depends on: Phase 10**

### Implement `web/nanovm.js`
- WASM instantiation: fetch .wasm, provide all 27 imports
- Terminal: integrate xterm.js or reuse jslinux/term.js
- Cooperative scheduling: `vm_step(ptr, budget)` → rAF loop per IDEA.md pattern
- Kernel fetch: XHR for kernel-x86_64.bin, write into WASM memory
- VFSync proxy: implement `emscripten_async_wget3_data` → XHR to vfsync.org
- File buffer APIs: file_buffer_init/read/write/resize/reset/set
- Network: WebSocket → `net_write_packet` / `net_recv_packet`

### Verify — FULL SYSTEM MILESTONE
- Open HTML page → kernel boots → shell prompt
- Type commands, output appears
- Filesystem loads files on demand

### Reference
- `jslinux/jslinux.js` (19KB — full JS host)
- `jslinux/x86_64emu-wasm.js` (27KB — Emscripten glue, import wiring, scheduling)
- `jslinux/term.js` (43KB — terminal emulator)

---

## Phase 12: Optimization & Ship
**Size: M** | **Depends on: Phase 11**

### Tasks
- Measure WASM binary size (target: <600KB, original: 519KB)
- Verify br_table in `wasm-objdump -d` output
- Verify TLB hit path is 3 ops, lazy flags are 3 stores
- Run `wasm-opt` (Binaryen) for additional size reduction
- Benchmark: instructions/second vs original
- Profile and eliminate any remaining heap allocations in hot path
- Ensure smooth terminal interaction (no frame drops)

---

## Dependency Graph

```
Phase 0 (scaffold)
  └─► Phase 1 (structs + host interface)
        ├─► Phase 2 (memory/TLB) ──────┐
        ├─► Phase 3 (decoder) ──────────┼─► Phase 5 (CPU interpreter) ─┐
        └─► Phase 4 (lazy flags) ───────┘                              │
                                          Phase 6 (PIC/PIT) ◄──────────┘
                                            ├─► Phase 7 (UART) ─── "Hello World"
                                            └─► Phase 8 (PCI) ──► Phase 9 (VirtIO)
                                                                      │
                                          Phase 10 (boot) ◄──────────┘
                                            └─► Phase 11 (JS host) ── "Linux Boot"
                                                  └─► Phase 12 (optimize) ── "Ship"
```

Phases 2, 3, 4 are **parallelizable**. Phase 5 is the **critical path** (XL).

---

## Milestones

| # | Milestone | Phase | Proof |
|---|-----------|-------|-------|
| 1 | WASM builds & loads | 0-1 | Module instantiates in browser |
| 2 | Memory works | 2 | TLB + page walk unit tests pass |
| 3 | Hello World | 5+6+7 | Custom mini-kernel prints text in browser terminal |
| 4 | Linux boots | 10 | Real kernel reaches login prompt |
| 5 | Full system | 11 | Interactive shell with filesystem |
| 6 | Ship | 12 | Size/perf targets met |

---

## File Structure (final)

```
nanovm/
├── Cargo.toml
├── rust-toolchain.toml
├── Makefile
├── src/
│   ├── lib.rs          # crate root, #![no_std]
│   ├── types.rs        # #[repr(C)] structs: Cpu, Machine, LazyFlags, Tlb, etc.
│   ├── host.rs         # extern "C" imports (27 host functions)
│   ├── exports.rs      # #[no_mangle] exports (vm_start, vm_step, console_*, etc.)
│   ├── mem.rs          # TLB, page walker, load/store
│   ├── cpu.rs          # THE monolithic exec() function (>100KB WASM)
│   ├── flags.rs        # Lazy EFLAGS materializer + condition evaluator
│   ├── pic.rs          # 8259 PIC (interrupt controller)
│   ├── pit.rs          # 8254 PIT (timer)
│   ├── uart.rs         # 16550 UART (serial)
│   ├── pci.rs          # PCI config space
│   ├── virtio.rs       # VirtIO common (virtqueue)
│   ├── virtio_console.rs
│   ├── virtio_9p.rs
│   ├── virtio_blk.rs
│   ├── virtio_net.rs
│   └── boot.rs         # bzImage loader, machine init
├── web/
│   ├── index.html      # minimal HTML shell
│   └── nanovm.js       # JS host: loader, imports, scheduler, terminal
├── specs/
│   ├── IDEA.md         # Rust architecture spec
│   └── plans/
│       └── implementation.md  # this plan
└── CLAUDE.md           # reverse-engineering documentation
```

---

## Critical Reference Files

| File | Use for |
|------|---------|
| `jslinux/cpu-cases.c` | Blueprint for all 333 opcode handlers in Phase 5 |
| `jslinux/ghidra-decompiled.c` | Typed C for TLB, page walk, EFLAGS, devices, machine init |
| `jslinux/x86_64emu.dcmp` | Full pseudocode when ghidra/cpu-cases are unclear |
| `specs/IDEA.md` | Rust struct templates, exec() pattern, build flags |
| `.claude/skills/bellard/SKILL.md` | Architectural constraints enforced throughout |
| `jslinux/jslinux.js` + `x86_64emu-wasm.js` | JS host patterns for Phase 11 |
