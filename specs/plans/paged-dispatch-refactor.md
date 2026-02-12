# Plan: Paged Dispatch Refactor — Fix Pathological Compile Times

## Context

The monolithic `exec()` in `src/cpu.rs` (~7100 lines, ~3500 lines of match dispatch + inlined helpers) causes rustc/LLVM OOM (30+ GB RAM, SIGKILL) on both release and dev builds. The ~2700 new lines from Phases 1-4 (BT/SHLD/SHRD, FPU D8-DF, SSE/SSE2) pushed past the compiler's memory threshold. `cargo check` passes (0 errors, 0 warnings) — the code is correct, it just can't be compiled into machine code.

**Root cause:** One massive function → huge MIR → huge LLVM IR → superlinear optimization cost. Combined with fat LTO + CGU=1 + opt-level="z", this exceeds available memory.

---

## What to change

### 1. Page the main `match idx` by opcode high nibble

Replace the single ~3500-line `match idx { ... }` with a two-level dispatch:

```rust
let page = opcode >> 4;
let fault = match page {
    0x0 => exec_page_0(cpu, ram, ram_size, opcode, lane, idx),
    0x1 => exec_page_1(cpu, ram, ram_size, opcode, lane, idx),
    ...
    0xF => exec_page_f(cpu, ram, ram_size, opcode, lane, idx),
    _ => unreachable!(),
};
if fault { continue; }
```

Each `exec_page_X` returns `bool` — `true` means a fault/exception occurred and the main loop should `continue`.

**16 page functions**, each handling ~16 opcodes × 3 lanes.

### 2. Page the 0x0F secondary dispatch the same way

Inside `exec_page_0`, the `0x0F` arm sub-dispatches by `op2 >> 4`:

```rust
0x0F | 0x10F | 0x20F => {
    let op2 = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
    match op2 >> 4 {
        0x0 => exec_0f_page_0(cpu, ram, ram_size, op2, lane),
        ...
        0xF => exec_0f_page_f(cpu, ram, ram_size, op2, lane),
        _ => unreachable!(),
    }
}
```

**16 sub-page functions** for the 0F prefix space.

### 3. Fix `try_or_fault!` for page functions

Two macro variants:

- **`try_or_fault!`** (in `exec()` main loop): uses `continue`
- **`try_or_fault_page!`** (in page functions): uses `return true`

```rust
macro_rules! try_or_fault_page {
    ($cpu:expr, $expr:expr) => {
        match $expr {
            Ok(v) => v,
            Err(e) => {
                match e {
                    mem::MemFault::PageFault { vaddr, error_code } => {
                        $cpu.cr2 = vaddr;
                        raise_exception($cpu, EXC_PF, error_code);
                    }
                    mem::MemFault::DeviceAccess { .. } => {
                        raise_exception($cpu, EXC_GP, 0);
                    }
                }
                return true;
            }
        }
    };
}
```

### 4. Restore `#[inline(always)]` on tiny helpers only

Current state: bulk-replaced all to `#[inline]`. Restore `#[inline(always)]` for:
- `fetch_imm8/16/32/64`, `read_reg8`, `write_reg8`, `write_reg8_al`, `write_reg16`
- `read_phys_u32/u64`, `write_phys_u64`, `raise_exception`

Keep `#[inline]` (LLVM decides) for medium helpers:
- `grp1_rm_imm`, `grp2_rm`, `grp3_rm`, `grp5_rm`, `grp1_ev_imm`, `grp2_ev`, `grp3_eb`, `grp3_ev`, `grp5`
- `alu_op_rm_r`, `alu_op_r_rm`, `alu_ev_gv_reg/mem`, `alu_gv_ev`
- `string_*`, `load_rm`, `store_rm`, `shift_op*`, `do_alu*`
- `decode_modrm_addr`, `decode_sib`

Keep as plain functions (no inline hint):
- `exec_fpu` (~525 lines), `exec_sse_arith` (~100), `exec_sse_int_op` (~330), `exec_sse_shift_imm` (~45)

### 5. Fix Cargo.toml profiles

```toml
[profile.dev]
opt-level = 0
debug = 0
incremental = true
codegen-units = 256

[profile.release]
opt-level = "s"
lto = "thin"
codegen-units = 16
panic = "abort"
strip = true
```

---

## Page breakdown

### Main dispatch (16 pages by `opcode >> 4`)

| Fn | Opcodes | Content |
|----|---------|---------|
| `exec_page_0` | 0x00-0x0F | ALU Eb/Ev/Gb/Eb byte ops, ADD/OR AL imm, **0x0F prefix** → sub-dispatch |
| `exec_page_1` | 0x10-0x1F | ALU ADC/SBB byte+word, ADC/SBB AL/AX imm |
| `exec_page_2` | 0x20-0x2F | AND/SUB byte+word, AND/SUB AL/AX imm |
| `exec_page_3` | 0x30-0x3F | XOR/CMP byte+word, XOR/CMP AL/AX imm |
| `exec_page_4` | 0x40-0x4F | REX (handled in prefix loop — UD in non-64-bit) |
| `exec_page_5` | 0x50-0x5F | PUSH/POP reg |
| `exec_page_6` | 0x60-0x6F | PUSH imm, IMUL, INS/OUTS |
| `exec_page_7` | 0x70-0x7F | Jcc short |
| `exec_page_8` | 0x80-0x8F | GRP1, TEST, XCHG, MOV r/m, LEA, MOV seg, POP r/m |
| `exec_page_9` | 0x90-0x9F | NOP, XCHG AX, CBW/CWD, PUSHF/POPF, SAHF/LAHF, FWAIT |
| `exec_page_a` | 0xA0-0xAF | MOV moffs, string ops, TEST AX imm |
| `exec_page_b` | 0xB0-0xBF | MOV r8/r16/r32/r64 imm |
| `exec_page_c` | 0xC0-0xCF | GRP2 imm, RET, MOV r/m imm, ENTER/LEAVE, INT, IRET |
| `exec_page_d` | 0xD0-0xDF | GRP2 1/CL, XLAT, FPU D8-DF |
| `exec_page_e` | 0xE0-0xEF | LOOP, JCXZ, IN/OUT, CALL/JMP |
| `exec_page_f` | 0xF0-0xFF | HLT, CMC, GRP3, CLC/STC/CLI/STI/CLD/STD, GRP5 |

### 0F sub-dispatch (16 pages by `op2 >> 4`)

| Fn | op2 | Content |
|----|-----|---------|
| `exec_0f_page_0` | 0x00-0x0F | GRP6/7, SYSCALL/SYSRET, WBINVD, UD2, NOP hints |
| `exec_0f_page_1` | 0x10-0x1F | SSE MOV (MOVUPS/SS/SD, MOVHPS/LPS), NOP hints |
| `exec_0f_page_2` | 0x20-0x2F | CR/DR MOV, SSE MOV/CVT, UCOMISS/SD |
| `exec_0f_page_3` | 0x30-0x3F | RDTSC, RDMSR/WRMSR |
| `exec_0f_page_4` | 0x40-0x4F | CMOVcc |
| `exec_0f_page_5` | 0x50-0x5F | MOVMSKPS, SSE logical, SSE arith |
| `exec_0f_page_6` | 0x60-0x6F | SSE packed int (PUNPCK, PACKSS, PCMPGT, MOVD/Q) |
| `exec_0f_page_7` | 0x70-0x7F | PSHUFD, SSE shift imm, PCMPEQ, EMMS, MOVD/Q |
| `exec_0f_page_8` | 0x80-0x8F | Jcc rel32 |
| `exec_0f_page_9` | 0x90-0x9F | SETcc |
| `exec_0f_page_a` | 0xA0-0xAF | PUSH/POP FS/GS, BT/BTS, SHLD/SHRD, fences, IMUL |
| `exec_0f_page_b` | 0xB0-0xBF | CMPXCHG, LSS/LFS/LGS, MOVZX, BTR/BTC, BT grp8, BSF/BSR, MOVSX |
| `exec_0f_page_c` | 0xC0-0xCF | XADD, CMPPS, MOVNTI, PINSRW/PEXTRW, SHUFPS, CMPXCHG8B, BSWAP |
| `exec_0f_page_d` | 0xD0-0xDF | SSE packed int (PSRL, PMULLW, MOVQ, PMOVMSKB, PSUBUSB...) |
| `exec_0f_page_e` | 0xE0-0xEF | SSE packed int (PAVGB, PMULHUW, MOVNTDQ, POR, PADDSB...), CVT |
| `exec_0f_page_f` | 0xF0-0xFF | SSE packed int (PSLLW, PMULUDQ, PSADBW, PSUBB, PADDB...) |

---

## Files modified

| File | Changes |
|------|---------|
| `src/cpu.rs` | Refactor exec() into 16 main + 16 0F page fns; fix try_or_fault; fix inline annotations |
| `Cargo.toml` | Release: thin LTO, CGU=16, opt-level="s"; Dev: debug=0, CGU=256 |

## Implementation order

1. Add `try_or_fault_page!` macro and `handle_fault()` helper
2. Create 16 main page functions — mechanical move of match arms
3. Create 16 0F sub-page functions — mechanical move of match arms
4. Wire up two-level dispatch in exec()
5. Restore `#[inline(always)]` on tiny helpers
6. Update Cargo.toml
7. `cargo check` — 0 errors, 0 warnings
8. `cargo build --target wasm32-unknown-unknown` — dev build completes
9. `cargo build --target wasm32-unknown-unknown --release` — release build completes

## Verification

1. `cargo check --target wasm32-unknown-unknown` — 0 errors, 0 warnings
2. Dev build completes without OOM
3. Release build completes without OOM
4. `ls -la target/wasm32-unknown-unknown/release/nanovm.wasm` — binary size check
5. Boot test via `web/nanovm.js` (manual)
