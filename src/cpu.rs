// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

use crate::decode;
use crate::mem;
use crate::syscall;
use crate::types::*;

// WASM native sqrt via compiler builtins (lowers to f32.sqrt / f64.sqrt opcodes)
extern "C" {
    fn sqrt(x: f64) -> f64;
    fn sqrtf(x: f32) -> f32;
}

// =====================================================================
// Basic Block Cache — pre-decoded instruction sequences for hot loops
// =====================================================================

const MAX_BLOCK_OPS: usize = 64;
const BLOCK_CACHE_SIZE: usize = 16384; // direct-mapped, power-of-2 (C2: 4x to cut aliasing)

// Op IDs — dense u8 identifiers for pre-decoded instructions
const OP_LD: u8 = 0;
const OP_LW: u8 = 1;
const OP_LWU: u8 = 2;
const OP_LOAD_OTHER: u8 = 3; // LB/LBU/LH/LHU — dispatch by f3
const OP_SD: u8 = 4;
const OP_SW: u8 = 5;
const OP_STORE_OTHER: u8 = 6; // SB/SH — dispatch by f3
const OP_ADDI: u8 = 7;
const OP_ANDI: u8 = 8;
const OP_ORI: u8 = 9;
const OP_XORI: u8 = 10;
const OP_SLTI: u8 = 11; // SLTI/SLTIU by f3
const OP_SLLI: u8 = 12;
const OP_SRLI: u8 = 13;
const OP_SRAI: u8 = 14;
const OP_ADDIW: u8 = 15;
const OP_IMM32_SHIFT: u8 = 16; // SLLIW/SRLIW/SRAIW
const OP_ADD: u8 = 17;
const OP_SUB: u8 = 18;
const OP_OP_BITWISE: u8 = 19; // AND/OR/XOR by f3
const OP_OP_SHIFT: u8 = 20; // SLL/SRL/SRA by f3+f7b5
const OP_OP_CMP: u8 = 21; // SLT/SLTU by f3
const OP_MUL: u8 = 22; // MUL/MULH/MULHSU/MULHU by f3
const OP_DIV: u8 = 23; // DIV/DIVU/REM/REMU by f3
const OP_ADDW: u8 = 24;
const OP_SUBW: u8 = 25;
const OP_OP32_SHIFT: u8 = 26; // SLLW/SRLW/SRAW
const OP_OP32_MULDIV: u8 = 27; // MULW/DIVW/REMW
const OP_LUI: u8 = 28;
const OP_AUIPC: u8 = 29;
const OP_JAL: u8 = 30; // terminator
const OP_JALR: u8 = 31; // terminator
const OP_BEQ: u8 = 32; // terminator
const OP_BNE: u8 = 33; // terminator
const OP_BRANCH_OTHER: u8 = 34; // BLT/BGE/BLTU/BGEU — terminator
const OP_ECALL: u8 = 35; // terminator
const OP_FENCE: u8 = 36;
const OP_CSR: u8 = 37;
const OP_FP_LOAD: u8 = 38; // FLD/FLW
const OP_FP_STORE: u8 = 39; // FSD/FSW
const OP_FP_OP: u8 = 40; // all FP ops — imm = raw insn
const OP_AMO: u8 = 41; // all AMO — imm = raw insn
const OP_UNKNOWN: u8 = 63; // fallback — terminates block

// Packed instruction: single u64 per op
// Upper 32 bits: op_id:8 | rd:5 | rs1:5 | rs2:5 | f3:3 | f7b5:1 | step4:1 | reserved:4
// Lower 32 bits: pre-extracted immediate (as u32, interpret as i32)
//
// step4: 0 = step is 2 (RVC origin), 1 = step is 4 (32-bit)

#[repr(C)]
#[derive(Clone, Copy)]
struct BlockEntry {
    start_pc: u64,                      // tag (0 = empty slot)
    packed: [u64; MAX_BLOCK_OPS],       // packed op+imm (1 load per insn)
    len: u16,                           // number of ops
    total_budget: u16,                  // instruction count (for budget)
    _pad: u32,
}

const EMPTY_BLOCK: BlockEntry = BlockEntry {
    start_pc: 0,
    packed: [0; MAX_BLOCK_OPS],
    len: 0,
    total_budget: 0,
    _pad: 0,
};

static mut BLOCKS: [BlockEntry; BLOCK_CACHE_SIZE] = [EMPTY_BLOCK; BLOCK_CACHE_SIZE];

// === C1 instrumentation: block-cache hit-rate / dispatch coverage ===
// Cheap u64 counters (no atomics — single cooperative thread runs exec at a time).
// Read out via debug_block_* exports; reset on block-cache reset.
static mut BLOCK_HITS: u64 = 0;       // exec_block invocations (block dispatches)
static mut BLOCK_BUILDS: u64 = 0;     // blocks built (cache misses)
static mut BLOCK_INSNS: u64 = 0;      // instructions executed inside blocks
static mut BASELINE_INSNS: u64 = 0;   // instructions executed in the baseline loop
// Diagnostic: which control-flow ops the baseline takes that DON'T enter a block
// (the cache only triggers on backward branch/JAL). Confirms where the hot path goes.
static mut JALR_EXECS: u64 = 0;       // baseline indirect jumps (JALR) — calls/returns/dispatch
static mut JALFWD_EXECS: u64 = 0;     // baseline forward JAL (direct calls)
static mut BRFWD_EXECS: u64 = 0;      // baseline forward taken branches

#[inline(always)]
pub fn stat_block_hits() -> u64 { unsafe { BLOCK_HITS } }
#[inline(always)]
pub fn stat_block_builds() -> u64 { unsafe { BLOCK_BUILDS } }
#[inline(always)]
pub fn stat_block_insns() -> u64 { unsafe { BLOCK_INSNS } }
#[inline(always)]
pub fn stat_baseline_insns() -> u64 { unsafe { BASELINE_INSNS } }
#[inline(always)]
pub fn stat_jalr_execs() -> u64 { unsafe { JALR_EXECS } }
#[inline(always)]
pub fn stat_jalfwd_execs() -> u64 { unsafe { JALFWD_EXECS } }
#[inline(always)]
pub fn stat_brfwd_execs() -> u64 { unsafe { BRFWD_EXECS } }

/// Reset instrumentation counters.
pub fn reset_stats() {
    unsafe {
        BLOCK_HITS = 0;
        BLOCK_BUILDS = 0;
        BLOCK_INSNS = 0;
        BASELINE_INSNS = 0;
        JALR_EXECS = 0;
        JALFWD_EXECS = 0;
        BRFWD_EXECS = 0;
    }
}

/// Zero all block tags — cheap invalidation that leaves stats and code-page marks alone.
#[inline(always)]
unsafe fn clear_block_tags() {
    for i in 0..BLOCK_CACHE_SIZE {
        BLOCKS[i].start_pc = 0;
    }
}

/// Clear the block cache (call on program load or snapshot restore)
pub fn reset_blocks() {
    unsafe {
        clear_block_tags();
        mem::clear_code_pages();
    }
    reset_stats();
}

/// Classify a 32-bit instruction into (op_id, immediate)
#[inline(always)]
fn classify_insn(insn: u32) -> (u8, i32) {
    let opcode = insn & 0x7f;
    let opcode_5 = (opcode >> 2) & 0x1f;
    let funct3 = (insn >> 12) & 0x7;
    let funct7 = (insn >> 25) & 0x7f;

    match opcode_5 {
        // LOAD
        0x00 => {
            let imm = imm_i(insn);
            match funct3 {
                3 => (OP_LD, imm),
                2 => (OP_LW, imm),
                6 => (OP_LWU, imm),
                _ => (OP_LOAD_OTHER, imm),
            }
        }
        // LOAD-FP — store raw insn so exec_block can re-decode (A0)
        0x01 => (OP_FP_LOAD, insn as i32),
        // FENCE
        0x03 => (OP_FENCE, 0),
        // OP-IMM
        0x04 => {
            let imm = imm_i(insn);
            match funct3 {
                0 => (OP_ADDI, imm),
                7 => (OP_ANDI, imm),
                6 => (OP_ORI, imm),
                4 => (OP_XORI, imm),
                2 | 3 => (OP_SLTI, imm),
                1 => (OP_SLLI, imm),
                5 => {
                    if (insn >> 26) & 0x10 != 0 { (OP_SRAI, imm) } else { (OP_SRLI, imm) }
                }
                _ => (OP_UNKNOWN, 0),
            }
        }
        // AUIPC
        0x05 => (OP_AUIPC, (insn & 0xFFFFF000) as i32),
        // OP-IMM-32
        0x06 => {
            let imm = imm_i(insn);
            match funct3 {
                0 => (OP_ADDIW, imm),
                1 | 5 => (OP_IMM32_SHIFT, imm),
                _ => (OP_UNKNOWN, 0),
            }
        }
        // STORE
        0x08 => {
            let imm = imm_s(insn);
            match funct3 {
                3 => (OP_SD, imm),
                2 => (OP_SW, imm),
                _ => (OP_STORE_OTHER, imm),
            }
        }
        // STORE-FP — store raw insn so exec_block can re-decode (A0)
        0x09 => (OP_FP_STORE, insn as i32),
        // AMO
        0x0B => (OP_AMO, insn as i32),
        // OP
        0x0C => {
            if funct7 == 1 {
                // M-extension
                if funct3 < 4 { (OP_MUL, 0) } else { (OP_DIV, 0) }
            } else {
                match funct3 {
                    0 => if funct7 == 0x20 { (OP_SUB, 0) } else { (OP_ADD, 0) },
                    4 | 6 | 7 => (OP_OP_BITWISE, 0),
                    1 | 5 => (OP_OP_SHIFT, 0),
                    2 | 3 => (OP_OP_CMP, 0),
                    _ => (OP_UNKNOWN, 0),
                }
            }
        }
        // LUI
        0x0D => (OP_LUI, (insn & 0xFFFFF000) as i32),
        // OP-32
        0x0E => {
            if funct7 == 1 {
                (OP_OP32_MULDIV, 0)
            } else {
                match funct3 {
                    0 => if funct7 == 0x20 { (OP_SUBW, 0) } else { (OP_ADDW, 0) },
                    1 | 5 => (OP_OP32_SHIFT, 0),
                    _ => (OP_UNKNOWN, 0),
                }
            }
        }
        // FMADD/FMSUB/FNMSUB/FNMADD/OP-FP
        0x10 | 0x11 | 0x12 | 0x13 | 0x14 => (OP_FP_OP, insn as i32),
        // BRANCH
        0x18 => {
            let imm = imm_b(insn);
            match funct3 {
                0 => (OP_BEQ, imm),
                1 => (OP_BNE, imm),
                _ => (OP_BRANCH_OTHER, imm),
            }
        }
        // JALR
        0x19 => (OP_JALR, (insn as i32) >> 20),
        // JAL
        0x1B => (OP_JAL, imm_j(insn)),
        // SYSTEM
        0x1C => {
            if funct3 == 0 {
                if insn == 0x00000073 { (OP_ECALL, 0) }
                else { (OP_UNKNOWN, 0) }
            } else {
                (OP_CSR, insn as i32)
            }
        }
        _ => (OP_UNKNOWN, 0),
    }
}

// =====================================================================
// Block builder — pre-decode instructions into packed op arrays
// =====================================================================

#[inline(never)] // cold path, don't bloat exec()
unsafe fn build_block(blk: &mut BlockEntry, start_pc: u64, base: u32) {
    BLOCK_BUILDS += 1; // C1: count cache misses (blocks built)
    blk.start_pc = start_pc;
    let mut pc = start_pc;
    let mut count = 0u16;
    let mut total = 0u16;

    while (count as usize) < MAX_BLOCK_OPS {
        let raw = ((base + pc as u32) as *const u32).read_unaligned();
        let (insn, step): (u32, u8) = if raw & 3 != 3 {
            let expanded = decode::expand_compressed(raw as u16);
            if expanded == 0 { break; }
            (expanded, 2)
        } else {
            (raw, 4)
        };

        let (op_id, imm) = classify_insn(insn);
        if op_id == OP_UNKNOWN { break; }

        // A0: FP/AMO are now executed inside blocks (see exec_block arms).
        // Only CSR still falls back to the baseline interpreter.
        match op_id {
            OP_CSR => break,
            _ => {}
        }

        let rd = ((insn >> 7) & 0x1f) as u32;
        let rs1 = ((insn >> 15) & 0x1f) as u32;
        let rs2 = ((insn >> 20) & 0x1f) as u32;
        let f3 = ((insn >> 12) & 0x7) as u32;
        let f7_bit5 = ((insn >> 30) & 1) as u32;

        let step4 = if step == 4 { 1u32 } else { 0u32 };
        let op_word = op_id as u32
            | (rd << 8)
            | (rs1 << 13)
            | (rs2 << 18)
            | (f3 << 23)
            | (f7_bit5 << 26)
            | (step4 << 27);

        let idx = count as usize;
        blk.packed[idx] = ((op_word as u64) << 32) | (imm as u32 as u64);
        count += 1;
        total += step as u16;
        pc = pc.wrapping_add(step as u64);

        // Stop at terminators (included in block — exec_block has handlers).
        // B3 superblocks: forward conditional branches stay IN the block as internal
        // multi-exit points — exec_block returns the target when the branch is taken
        // and falls through to the next op when not. Only backward/self conditional
        // branches (loop back-edges) end the block, so loop_back detection and the
        // per-block budget stay correct. Unconditional control flow still terminates.
        match op_id {
            OP_JAL | OP_JALR | OP_ECALL => break,
            OP_BEQ | OP_BNE | OP_BRANCH_OTHER => {
                if imm <= 0 { break; } // backward / self → loop back-edge, end block
            }
            _ => {}
        }
    }

    blk.len = count;
    blk.total_budget = count; // match main loop: 1 budget per instruction
    // A2: mark the page(s) this block was decoded from for self-modifying-code detection
    if count > 0 {
        mem::mark_code_page(start_pc);
        if total > 1 {
            mem::mark_code_page(start_pc + (total as u64) - 1);
        }
    }
}

// =====================================================================
// Block runner — execute pre-decoded blocks with minimal dispatch
// =====================================================================

#[inline(always)]
unsafe fn exec_block(
    blk: &BlockEntry,
    base: u32,
    x: &mut [u64; 32],
    f: &mut [u64; 32],
    fcsr: &mut u32,
    vm: &mut Vm,
    remaining: &mut i32,
) -> u64 {
    BLOCK_HITS += 1; // C1: count block dispatches
    let mut pc = blk.start_pc;

    loop {
        // Budget check once per block iteration. Run if ANY budget remains (may dip
        // slightly negative); the outer loop breaks on remaining <= 0. This guarantees
        // forward progress when dispatched from the loop top with low remaining budget.
        if *remaining <= 0 {
            break;
        }
        *remaining -= blk.total_budget as i32;
        BLOCK_INSNS += blk.total_budget as u64; // C1: instructions executed in blocks

        pc = blk.start_pc;
        let mut i = 0usize;
        let len = blk.len as usize;
        let mut loop_back = false;

        while i < len {
            let p = blk.packed[i];
            let op = (p >> 32) as u32;
            let imm = p as u32 as i32;
            let step: u64 = if op & (1 << 27) != 0 { 4 } else { 2 };
            let op_id = (op & 0xFF) as u8;
            let rd = ((op >> 8) & 0x1f) as usize;
            let rs1 = ((op >> 13) & 0x1f) as usize;
            let rs2 = ((op >> 18) & 0x1f) as usize;
            let f3 = (op >> 23) & 0x7;
            let f7b5 = (op >> 26) & 1;

            // Integer-only block dispatch — no FP/AMO/CSR handlers
            // (blocks are terminated before those ops in build_block)
            match op_id {
                OP_LD => {
                    let addr = x[rs1].wrapping_add(imm as i64 as u64);
                    if rd != 0 { x[rd] = mem::read_u64(base, addr); }
                    pc = pc.wrapping_add(step);
                }
                OP_LW => {
                    let addr = x[rs1].wrapping_add(imm as i64 as u64);
                    if rd != 0 { x[rd] = mem::read_i32(base, addr) as i64 as u64; }
                    pc = pc.wrapping_add(step);
                }
                OP_LWU => {
                    let addr = x[rs1].wrapping_add(imm as i64 as u64);
                    if rd != 0 { x[rd] = mem::read_u32(base, addr) as u64; }
                    pc = pc.wrapping_add(step);
                }
                OP_LOAD_OTHER => {
                    let addr = x[rs1].wrapping_add(imm as i64 as u64);
                    if rd != 0 {
                        x[rd] = match f3 {
                            0 => mem::read_i8(base, addr) as i64 as u64,
                            1 => mem::read_i16(base, addr) as i64 as u64,
                            4 => mem::read_u8(base, addr) as u64,
                            5 => mem::read_u16(base, addr) as u64,
                            _ => 0,
                        };
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_SD => {
                    let addr = x[rs1].wrapping_add(imm as i64 as u64);
                    mem::write_u64(base, addr, x[rs2]);
                    pc = pc.wrapping_add(step);
                }
                OP_SW => {
                    let addr = x[rs1].wrapping_add(imm as i64 as u64);
                    mem::write_u32(base, addr, x[rs2] as u32);
                    pc = pc.wrapping_add(step);
                }
                OP_STORE_OTHER => {
                    let addr = x[rs1].wrapping_add(imm as i64 as u64);
                    match f3 {
                        0 => mem::write_u8(base, addr, x[rs2] as u8),
                        1 => mem::write_u16(base, addr, x[rs2] as u16),
                        _ => {}
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_ADDI => {
                    if rd != 0 { x[rd] = x[rs1].wrapping_add(imm as i64 as u64); }
                    pc = pc.wrapping_add(step);
                }
                OP_ANDI => {
                    if rd != 0 { x[rd] = x[rs1] & (imm as i64 as u64); }
                    pc = pc.wrapping_add(step);
                }
                OP_ORI => {
                    if rd != 0 { x[rd] = x[rs1] | (imm as i64 as u64); }
                    pc = pc.wrapping_add(step);
                }
                OP_XORI => {
                    if rd != 0 { x[rd] = x[rs1] ^ (imm as i64 as u64); }
                    pc = pc.wrapping_add(step);
                }
                OP_SLTI => {
                    if rd != 0 {
                        x[rd] = if f3 == 2 {
                            if (x[rs1] as i64) < (imm as i64) { 1 } else { 0 }
                        } else {
                            if x[rs1] < (imm as i64 as u64) { 1 } else { 0 }
                        };
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_SLLI => {
                    if rd != 0 {
                        let shamt = (imm as u32) & 0x3f;
                        x[rd] = x[rs1] << shamt;
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_SRLI => {
                    if rd != 0 {
                        let shamt = (imm as u32) & 0x3f;
                        x[rd] = x[rs1] >> shamt;
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_SRAI => {
                    if rd != 0 {
                        let shamt = (imm as u32) & 0x3f;
                        x[rd] = ((x[rs1] as i64) >> shamt) as u64;
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_ADDIW => {
                    if rd != 0 {
                        x[rd] = (x[rs1] as i32).wrapping_add(imm as i32) as i64 as u64;
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_IMM32_SHIFT => {
                    if rd != 0 {
                        let v = x[rs1] as i32;
                        let shamt = (imm as u32) & 0x1f;
                        x[rd] = (match f3 {
                            1 => v << shamt,                                    // SLLIW
                            5 => if f7b5 != 0 { v >> shamt }                  // SRAIW
                                 else { ((v as u32) >> shamt) as i32 },        // SRLIW
                            _ => v,
                        }) as i64 as u64;
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_ADD => {
                    if rd != 0 { x[rd] = x[rs1].wrapping_add(x[rs2]); }
                    pc = pc.wrapping_add(step);
                }
                OP_SUB => {
                    if rd != 0 { x[rd] = x[rs1].wrapping_sub(x[rs2]); }
                    pc = pc.wrapping_add(step);
                }
                OP_OP_BITWISE => {
                    if rd != 0 {
                        x[rd] = match f3 {
                            4 => x[rs1] ^ x[rs2],
                            6 => x[rs1] | x[rs2],
                            7 => x[rs1] & x[rs2],
                            _ => x[rs1],
                        };
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_OP_SHIFT => {
                    if rd != 0 {
                        let shamt = (x[rs2] & 0x3f) as u32;
                        x[rd] = match f3 {
                            1 => x[rs1] << shamt,
                            5 => if f7b5 != 0 { ((x[rs1] as i64) >> shamt) as u64 }
                                 else { x[rs1] >> shamt },
                            _ => x[rs1],
                        };
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_OP_CMP => {
                    if rd != 0 {
                        x[rd] = match f3 {
                            2 => if (x[rs1] as i64) < (x[rs2] as i64) { 1 } else { 0 },
                            3 => if x[rs1] < x[rs2] { 1 } else { 0 },
                            _ => 0,
                        };
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_MUL => {
                    if rd != 0 { x[rd] = exec_mul_div_64(x[rs1], x[rs2], f3); }
                    pc = pc.wrapping_add(step);
                }
                OP_DIV => {
                    if rd != 0 { x[rd] = exec_mul_div_64(x[rs1], x[rs2], f3); }
                    pc = pc.wrapping_add(step);
                }
                OP_ADDW => {
                    if rd != 0 { x[rd] = (x[rs1] as i32).wrapping_add(x[rs2] as i32) as i64 as u64; }
                    pc = pc.wrapping_add(step);
                }
                OP_SUBW => {
                    if rd != 0 { x[rd] = (x[rs1] as i32).wrapping_sub(x[rs2] as i32) as i64 as u64; }
                    pc = pc.wrapping_add(step);
                }
                OP_OP32_SHIFT => {
                    if rd != 0 {
                        let v = x[rs1] as i32;
                        let shamt = (x[rs2] & 0x1f) as u32;
                        x[rd] = (match f3 {
                            1 => v << shamt,
                            5 => if f7b5 != 0 { v >> shamt } else { ((v as u32) >> shamt) as i32 },
                            _ => v,
                        }) as i64 as u64;
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_OP32_MULDIV => {
                    if rd != 0 { x[rd] = exec_mul_div_32(x[rs1] as i32, x[rs2] as i32, f3); }
                    pc = pc.wrapping_add(step);
                }
                OP_LUI => {
                    if rd != 0 { x[rd] = imm as i64 as u64; }
                    pc = pc.wrapping_add(step);
                }
                OP_AUIPC => {
                    if rd != 0 { x[rd] = pc.wrapping_add(imm as i64 as u64); }
                    pc = pc.wrapping_add(step);
                }
                OP_FENCE => {
                    pc = pc.wrapping_add(step);
                }
                // === Terminators ===
                OP_JAL => {
                    if rd != 0 { x[rd] = pc.wrapping_add(step); }
                    let target = pc.wrapping_add(imm as i64 as u64);
                    if target == blk.start_pc {
                        loop_back = true;
                        break;
                    }
                    x[0] = 0;
                    return target;
                }
                OP_JALR => {
                    let target = x[rs1].wrapping_add(imm as i64 as u64) & !1;
                    if rd != 0 { x[rd] = pc.wrapping_add(step); }
                    x[0] = 0;
                    return target;
                }
                OP_BEQ => {
                    if x[rs1] == x[rs2] {
                        let target = pc.wrapping_add(imm as i64 as u64);
                        if target == blk.start_pc { loop_back = true; break; }
                        x[0] = 0;
                        return target;
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_BNE => {
                    if x[rs1] != x[rs2] {
                        let target = pc.wrapping_add(imm as i64 as u64);
                        if target == blk.start_pc { loop_back = true; break; }
                        x[0] = 0;
                        return target;
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_BRANCH_OTHER => {
                    let taken = match f3 {
                        4 => (x[rs1] as i64) < (x[rs2] as i64),
                        5 => (x[rs1] as i64) >= (x[rs2] as i64),
                        6 => x[rs1] < x[rs2],
                        7 => x[rs1] >= x[rs2],
                        _ => false,
                    };
                    if taken {
                        let target = pc.wrapping_add(imm as i64 as u64);
                        if target == blk.start_pc { loop_back = true; break; }
                        x[0] = 0;
                        return target;
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_ECALL => {
                    vm.x = *x; vm.pc = pc.wrapping_add(step);
                    vm.f = *f; vm.fcsr = *fcsr;
                    syscall::handle(vm);
                    // Deliver a pending signal at the syscall boundary (unless the
                    // syscall parked or faulted — a parked stdin op is interrupted
                    // via vm_io_retry instead).
                    if vm.status == STATUS_RUNNING || vm.status == STATUS_OK {
                        syscall::deliver_signals(vm);
                    }
                    *x = vm.x; pc = vm.pc; *f = vm.f; *fcsr = vm.fcsr;
                    x[0] = 0;
                    return pc;
                }
                // A0: FP / AMO executed inline (raw insn carried in the imm slot).
                // rd/f3/rs1/rs2 come from the packed word (same decode as the raw insn);
                // funct7/rs3/fmt are recovered from the raw insn by the helpers.
                OP_FP_LOAD => {
                    let insn = imm as u32;
                    exec_load_fp(base, f, x, &mut pc, step, insn, rd, f3, rs1);
                }
                OP_FP_STORE => {
                    let insn = imm as u32;
                    exec_store_fp(base, f, x, &mut pc, step, insn, f3, rs1, rs2);
                }
                OP_FP_OP => {
                    let insn = imm as u32;
                    match (insn >> 2) & 0x1f {
                        0x10 => exec_fma(insn, f, fcsr, false, false),
                        0x11 => exec_fma(insn, f, fcsr, true, false),
                        0x12 => exec_fma(insn, f, fcsr, false, true),
                        0x13 => exec_fma(insn, f, fcsr, true, true),
                        _ => {
                            let funct7 = (insn >> 25) & 0x7f;
                            exec_op_fp(insn, x, f, fcsr, rd, f3, rs1, rs2, funct7);
                        }
                    }
                    pc = pc.wrapping_add(step);
                }
                OP_AMO => {
                    let insn = imm as u32;
                    let funct7 = (insn >> 25) & 0x7f;
                    exec_amo(base, x, &mut pc, step, insn, rd, f3, rs1, rs2, funct7);
                }
                _ => {
                    pc = pc.wrapping_add(step);
                }
            }
            i += 1;
        }
        if !loop_back {
            break;
        }
        // loop_back: branch went to start_pc, re-check budget and re-execute
    }
    x[0] = 0;
    pc
}

// =====================================================================
// RVC immediate helpers — extract offsets/immediates directly from
// the 16-bit compressed instruction (as u32 for ergonomics)
// =====================================================================

#[inline(always)]
fn c_ld_off(i: u32) -> u64 {
    let b76 = (i >> 5) & 0x3;
    let b53 = (i >> 10) & 0x7;
    ((b53 << 3) | (b76 << 6)) as u64
}

#[inline(always)]
fn c_lw_off(i: u32) -> u64 {
    let b6 = (i >> 5) & 1;
    let b2 = (i >> 6) & 1;
    let b53 = (i >> 10) & 0x7;
    ((b53 << 3) | (b6 << 6) | (b2 << 2)) as u64
}

#[inline(always)]
fn c_ldsp_off(i: u32) -> u64 {
    let b5 = (i >> 12) & 1;
    let b43 = (i >> 5) & 0x3;
    let b86 = (i >> 2) & 0x7;
    ((b43 << 3) | (b5 << 5) | (b86 << 6)) as u64
}

#[inline(always)]
fn c_lwsp_off(i: u32) -> u64 {
    let b5 = (i >> 12) & 1;
    let b42 = (i >> 4) & 0x7;
    let b76 = (i >> 2) & 0x3;
    ((b42 << 2) | (b5 << 5) | (b76 << 6)) as u64
}

#[inline(always)]
fn c_sdsp_off(i: u32) -> u64 {
    let b53 = (i >> 10) & 0x7;
    let b86 = (i >> 7) & 0x7;
    ((b53 << 3) | (b86 << 6)) as u64
}

#[inline(always)]
fn c_swsp_off(i: u32) -> u64 {
    let b52 = (i >> 9) & 0xf;
    let b76 = (i >> 7) & 0x3;
    ((b52 << 2) | (b76 << 6)) as u64
}

#[inline(always)]
fn c_imm6s(i: u32) -> i64 {
    let lo = (i >> 2) & 0x1f;
    let hi = (i >> 12) & 1;
    let val = lo | (hi << 5);
    if hi != 0 { (val | 0xFFFFFFC0) as i32 as i64 } else { val as i64 }
}

#[inline(always)]
fn c_shamt_v(i: u32) -> u32 {
    ((i >> 2) & 0x1f) | (((i >> 12) & 1) << 5)
}

#[inline(always)]
fn c_j_off(i: u32) -> i64 {
    let b5 = (i >> 2) & 1;
    let b31 = (i >> 3) & 0x7;
    let b7 = (i >> 6) & 1;
    let b6 = (i >> 7) & 1;
    let b10 = (i >> 8) & 1;
    let b98 = (i >> 9) & 0x3;
    let b4 = (i >> 11) & 1;
    let b11 = (i >> 12) & 1;
    let val = (b31 << 1) | (b4 << 4) | (b5 << 5) | (b6 << 6) | (b7 << 7)
        | (b98 << 8) | (b10 << 10) | (b11 << 11);
    if b11 != 0 { (val | 0xFFFFF000) as i32 as i64 } else { val as i64 }
}

#[inline(always)]
fn c_br_off(i: u32) -> i64 {
    let b5 = (i >> 2) & 1;
    let b21 = (i >> 3) & 0x3;
    let b76 = (i >> 5) & 0x3;
    let b43 = (i >> 10) & 0x3;
    let b8 = (i >> 12) & 1;
    let val = (b21 << 1) | (b43 << 3) | (b5 << 5) | (b76 << 6) | (b8 << 8);
    if b8 != 0 { (val | 0xFFFFFE00) as i32 as i64 } else { val as i64 }
}

#[inline(always)]
fn c_addi16sp(i: u32) -> i64 {
    let b5 = (i >> 2) & 1;
    let b87 = (i >> 3) & 0x3;
    let b6 = (i >> 5) & 1;
    let b4 = (i >> 6) & 1;
    let b9 = (i >> 12) & 1;
    let val = (b5 << 5) | (b87 << 7) | (b6 << 6) | (b4 << 4) | (b9 << 9);
    if b9 != 0 { (val | 0xFFFFFC00) as i32 as i64 } else { val as i64 }
}

#[inline(always)]
fn c_lui_v(i: u32) -> i64 {
    let lo = (i >> 2) & 0x1f;
    let hi = (i >> 12) & 1;
    let val = (lo | (hi << 5)) << 12;
    if hi != 0 { (val | 0xFFFC0000) as i32 as i64 } else { val as i64 }
}

#[inline(always)]
fn c_addi4spn_v(i: u32) -> u64 {
    let b3 = (i >> 5) & 1;
    let b2 = (i >> 6) & 1;
    let b96 = (i >> 7) & 0xf;
    let b54 = (i >> 11) & 0x3;
    ((b3 << 3) | (b2 << 2) | (b96 << 6) | (b54 << 4)) as u64
}

// =====================================================================
// Direct RVC dispatch — execute common compressed instructions inline
// without expand-to-32-bit + re-decode overhead.
// Returns true if handled (pc updated), false for fallback.
// =====================================================================

#[inline(always)]
unsafe fn try_exec_rvc(
    raw: u32,
    base: u32,
    x: &mut [u64; 32],
    f: &mut [u64; 32],
    pc: &mut u64,
) -> bool {
    let i = raw & 0xFFFF;
    let op = i & 0x3;
    let f3 = (i >> 13) & 0x7;

    // Dense dispatch index: (op << 3) | funct3 → range 0..23
    match (op << 3) | f3 {
        // ---- Quadrant 0 ----
        // C.ADDI4SPN: addi rd', x2, nzuimm
        0 => {
            let nzuimm = c_addi4spn_v(i);
            if nzuimm == 0 { return false; }
            let rd = (((i >> 2) & 0x7) + 8) as usize;
            x[rd] = x[2].wrapping_add(nzuimm);
            *pc = pc.wrapping_add(2);
            true
        }
        // C.FLD: fld rd', off(rs1')
        1 => {
            let rd = (((i >> 2) & 0x7) + 8) as usize;
            let rs1 = (((i >> 7) & 0x7) + 8) as usize;
            let addr = x[rs1].wrapping_add(c_ld_off(i));
            f[rd] = ((base + addr as u32) as *const u64).read_unaligned();
            *pc = pc.wrapping_add(2);
            true
        }
        // C.LW: lw rd', off(rs1')
        2 => {
            let rd = (((i >> 2) & 0x7) + 8) as usize;
            let rs1 = (((i >> 7) & 0x7) + 8) as usize;
            let addr = x[rs1].wrapping_add(c_lw_off(i));
            x[rd] = ((base + addr as u32) as *const u32).read_unaligned() as i32 as i64 as u64;
            *pc = pc.wrapping_add(2);
            true
        }
        // C.LD: ld rd', off(rs1')
        3 => {
            let rd = (((i >> 2) & 0x7) + 8) as usize;
            let rs1 = (((i >> 7) & 0x7) + 8) as usize;
            let addr = x[rs1].wrapping_add(c_ld_off(i));
            x[rd] = ((base + addr as u32) as *const u64).read_unaligned();
            *pc = pc.wrapping_add(2);
            true
        }
        // Reserved
        4 => false,
        // C.FSD: fsd rs2', off(rs1')
        5 => {
            let rs2 = (((i >> 2) & 0x7) + 8) as usize;
            let rs1 = (((i >> 7) & 0x7) + 8) as usize;
            let addr = x[rs1].wrapping_add(c_ld_off(i));
            ((base + addr as u32) as *mut u64).write_unaligned(f[rs2]);
            *pc = pc.wrapping_add(2);
            true
        }
        // C.SW: sw rs2', off(rs1')
        6 => {
            let rs2 = (((i >> 2) & 0x7) + 8) as usize;
            let rs1 = (((i >> 7) & 0x7) + 8) as usize;
            let addr = x[rs1].wrapping_add(c_lw_off(i));
            ((base + addr as u32) as *mut u32).write_unaligned(x[rs2] as u32);
            *pc = pc.wrapping_add(2);
            true
        }
        // C.SD: sd rs2', off(rs1')
        7 => {
            let rs2 = (((i >> 2) & 0x7) + 8) as usize;
            let rs1 = (((i >> 7) & 0x7) + 8) as usize;
            let addr = x[rs1].wrapping_add(c_ld_off(i));
            ((base + addr as u32) as *mut u64).write_unaligned(x[rs2]);
            *pc = pc.wrapping_add(2);
            true
        }

        // ---- Quadrant 1 ----
        // C.NOP / C.ADDI
        8 => {
            let rd = ((i >> 7) & 0x1f) as usize;
            if rd != 0 {
                x[rd] = x[rd].wrapping_add(c_imm6s(i) as u64);
                // Fusion: C.ADDI + C.BEQZ/C.BNEZ (loop counter pattern)
                // Only fuse forward branches — backward branches go through block cache
                let next_hw = raw >> 16;
                if next_hw & 0xC003 == 0xC001 {
                    let br_rs1 = (((next_hw >> 7) & 0x7) + 8) as usize;
                    if br_rs1 == rd {
                        let off = c_br_off(next_hw);
                        if off >= 0 {
                            let cond = if next_hw & 0x2000 != 0 { x[rd] != 0 } else { x[rd] == 0 };
                            if cond {
                                *pc = (*pc + 2).wrapping_add(off as u64);
                            } else {
                                *pc = pc.wrapping_add(4);
                            }
                            return true;
                        }
                    }
                }
            }
            *pc = pc.wrapping_add(2);
            true
        }
        // C.ADDIW
        9 => {
            let rd = ((i >> 7) & 0x1f) as usize;
            if rd == 0 { return false; }
            x[rd] = (x[rd] as i32).wrapping_add(c_imm6s(i) as i32) as i64 as u64;
            // Fusion: C.ADDIW + C.BEQZ/C.BNEZ — only fuse forward branches
            let next_hw = raw >> 16;
            if next_hw & 0xC003 == 0xC001 {
                let br_rs1 = (((next_hw >> 7) & 0x7) + 8) as usize;
                if br_rs1 == rd {
                    let off = c_br_off(next_hw);
                    if off >= 0 {
                        let cond = if next_hw & 0x2000 != 0 { x[rd] != 0 } else { x[rd] == 0 };
                        if cond {
                            *pc = (*pc + 2).wrapping_add(off as u64);
                        } else {
                            *pc = pc.wrapping_add(4);
                        }
                        return true;
                    }
                }
            }
            *pc = pc.wrapping_add(2);
            true
        }
        // C.LI
        10 => {
            let rd = ((i >> 7) & 0x1f) as usize;
            if rd != 0 { x[rd] = c_imm6s(i) as u64; }
            *pc = pc.wrapping_add(2);
            true
        }
        // C.LUI / C.ADDI16SP
        11 => {
            let rd = ((i >> 7) & 0x1f) as usize;
            if rd == 2 {
                let imm = c_addi16sp(i);
                if imm == 0 { return false; }
                x[2] = x[2].wrapping_add(imm as u64);
                // Fusion: C.ADDI16SP + C.JR ra (function epilogue pattern)
                if raw >> 16 == 0x8082 {
                    *pc = x[1] & !1;
                    return true;
                }
            } else if rd != 0 {
                let imm = c_lui_v(i);
                if imm == 0 { return false; }
                x[rd] = imm as u64;
            }
            *pc = pc.wrapping_add(2);
            true
        }
        // C.SRLI / C.SRAI / C.ANDI / C.SUB / C.XOR / C.OR / C.AND / C.SUBW / C.ADDW
        12 => {
            let rd = (((i >> 7) & 0x7) + 8) as usize;
            let funct2 = (i >> 10) & 0x3;
            match funct2 {
                0 => { x[rd] = x[rd] >> c_shamt_v(i); } // C.SRLI
                1 => { x[rd] = ((x[rd] as i64) >> c_shamt_v(i)) as u64; } // C.SRAI
                2 => { x[rd] = x[rd] & (c_imm6s(i) as u64); } // C.ANDI
                3 => {
                    let rs2 = (((i >> 2) & 0x7) + 8) as usize;
                    let f1 = (i >> 12) & 1;
                    let f2b = (i >> 5) & 0x3;
                    match (f1, f2b) {
                        (0, 0) => x[rd] = x[rd].wrapping_sub(x[rs2]),
                        (0, 1) => x[rd] = x[rd] ^ x[rs2],
                        (0, 2) => x[rd] = x[rd] | x[rs2],
                        (0, 3) => x[rd] = x[rd] & x[rs2],
                        (1, 0) => x[rd] = (x[rd] as i32).wrapping_sub(x[rs2] as i32) as i64 as u64,
                        (1, 1) => x[rd] = (x[rd] as i32).wrapping_add(x[rs2] as i32) as i64 as u64,
                        _ => return false,
                    }
                }
                _ => return false,
            }
            *pc = pc.wrapping_add(2);
            true
        }
        // C.J
        13 => {
            let off = c_j_off(i);
            if off < 0 { return false; } // backward jump — fall through to block cache
            *pc = pc.wrapping_add(off as u64);
            true
        }
        // C.BEQZ
        14 => {
            let rs1 = (((i >> 7) & 0x7) + 8) as usize;
            if x[rs1] == 0 {
                let off = c_br_off(i);
                if off < 0 { return false; } // backward — fall through to block cache
                *pc = pc.wrapping_add(off as u64);
            } else {
                *pc = pc.wrapping_add(2);
            }
            true
        }
        // C.BNEZ
        15 => {
            let rs1 = (((i >> 7) & 0x7) + 8) as usize;
            if x[rs1] != 0 {
                let off = c_br_off(i);
                if off < 0 { return false; } // backward — fall through to block cache
                *pc = pc.wrapping_add(off as u64);
            } else {
                *pc = pc.wrapping_add(2);
            }
            true
        }

        // ---- Quadrant 2 ----
        // C.SLLI
        16 => {
            let rd = ((i >> 7) & 0x1f) as usize;
            if rd == 0 { return false; }
            x[rd] = x[rd] << c_shamt_v(i);
            *pc = pc.wrapping_add(2);
            true
        }
        // C.FLDSP: fld rd, off(sp)
        17 => {
            let rd = ((i >> 7) & 0x1f) as usize;
            let addr = x[2].wrapping_add(c_ldsp_off(i));
            f[rd] = ((base + addr as u32) as *const u64).read_unaligned();
            *pc = pc.wrapping_add(2);
            true
        }
        // C.LWSP: lw rd, off(sp)
        18 => {
            let rd = ((i >> 7) & 0x1f) as usize;
            if rd == 0 { return false; }
            let addr = x[2].wrapping_add(c_lwsp_off(i));
            x[rd] = ((base + addr as u32) as *const u32).read_unaligned() as i32 as i64 as u64;
            *pc = pc.wrapping_add(2);
            true
        }
        // C.LDSP: ld rd, off(sp)
        19 => {
            let rd = ((i >> 7) & 0x1f) as usize;
            if rd == 0 { return false; }
            let addr = x[2].wrapping_add(c_ldsp_off(i));
            x[rd] = ((base + addr as u32) as *const u64).read_unaligned();
            // Fusion: C.LDSP + C.JR (load + indirect jump pattern)
            let next_hw = raw >> 16;
            if next_hw & 0xF07F == 0x8002 {
                let jr_rs1 = ((next_hw >> 7) & 0x1f) as usize;
                if jr_rs1 == rd {
                    *pc = x[rd] & !1;
                    return true;
                }
            }
            *pc = pc.wrapping_add(2);
            true
        }
        // C.JR / C.MV / C.EBREAK / C.JALR / C.ADD
        20 => {
            let rd = ((i >> 7) & 0x1f) as usize;
            let rs2 = ((i >> 2) & 0x1f) as usize;
            let bit12 = (i >> 12) & 1;
            if bit12 == 0 {
                if rs2 == 0 {
                    // C.JR
                    if rd == 0 { return false; }
                    *pc = x[rd] & !1;
                } else {
                    // C.MV
                    if rd != 0 { x[rd] = x[rs2]; }
                    *pc = pc.wrapping_add(2);
                }
            } else {
                if rs2 == 0 && rd == 0 {
                    // C.EBREAK
                    return false;
                } else if rs2 == 0 {
                    // C.JALR
                    let target = x[rd] & !1;
                    x[1] = pc.wrapping_add(2);
                    *pc = target;
                } else {
                    // C.ADD
                    if rd != 0 { x[rd] = x[rd].wrapping_add(x[rs2]); }
                    *pc = pc.wrapping_add(2);
                }
            }
            true
        }
        // C.FSDSP: fsd rs2, off(sp)
        21 => {
            let rs2 = ((i >> 2) & 0x1f) as usize;
            let addr = x[2].wrapping_add(c_sdsp_off(i));
            ((base + addr as u32) as *mut u64).write_unaligned(f[rs2]);
            *pc = pc.wrapping_add(2);
            true
        }
        // C.SWSP: sw rs2, off(sp)
        22 => {
            let rs2 = ((i >> 2) & 0x1f) as usize;
            let addr = x[2].wrapping_add(c_swsp_off(i));
            ((base + addr as u32) as *mut u32).write_unaligned(x[rs2] as u32);
            *pc = pc.wrapping_add(2);
            true
        }
        // C.SDSP: sd rs2, off(sp)
        23 => {
            let rs2 = ((i >> 2) & 0x1f) as usize;
            let addr = x[2].wrapping_add(c_sdsp_off(i));
            ((base + addr as u32) as *mut u64).write_unaligned(x[rs2]);
            *pc = pc.wrapping_add(2);
            true
        }

        _ => false,
    }
}

// =====================================================================
// Monolithic RV64GC interpreter
// =====================================================================

/// Monolithic RV64GC interpreter.
/// Hot CPU state (registers, PC) kept in locals for performance.
/// Compiles to a single large WASM function via #[inline(always)] + fat LTO.
pub unsafe fn exec(vm: &mut Vm, budget: i32) -> i32 {
    let mut pc = vm.pc;
    let mut remaining = budget;

    // Load registers into locals for hot path
    let mut x = vm.x;
    let mut f = vm.f;
    let mut fcsr = vm.fcsr;

    // ram_base as local — avoids repeated struct access in mem functions
    let base = vm.ram_base;

    loop {
        if remaining <= 0 {
            break;
        }

        // === A2: invalidate stale blocks if guest code was written since last check ===
        if mem::take_code_dirty() {
            clear_block_tags();
        }

        // === A1: block dispatch at the top of the loop ===
        // Every control transfer (branch/jal/jalr) lands here; run a cached block at
        // `pc` if present, building one lazily (evicting on collision) otherwise.
        // exec_block returns the next pc, so consecutive blocks chain back-to-back
        // through this point with only a cache lookup between them.
        let bidx = (pc >> 1) as usize & (BLOCK_CACHE_SIZE - 1);
        if BLOCKS[bidx].start_pc != pc {
            build_block(&mut BLOCKS[bidx], pc, base);
        }
        if BLOCKS[bidx].len > 0 {
            pc = exec_block(&mut BLOCKS[bidx], base, &mut x, &mut f, &mut fcsr, vm, &mut remaining);
            if vm.status != STATUS_OK && vm.status != STATUS_RUNNING {
                remaining = 0;
                break;
            }
            continue;
        }

        // === baseline single-step (block head not cacheable here, e.g. CSR/illegal) ===
        remaining -= 1;
        BASELINE_INSNS += 1; // C1: instructions executed in the baseline loop

        // Single 32-bit fetch (1 WASM i32.load instruction)
        let raw = ((base + pc as u32) as *const u32).read_unaligned();

        let (insn, step): (u32, u64);

        if raw & 0x3 != 0x3 {
            // 16-bit compressed instruction — try direct dispatch
            if try_exec_rvc(raw, base, &mut x, &mut f, &mut pc) {
                continue;
            }
            // Fallback: expand to 32-bit
            insn = decode::expand_compressed(raw as u16);
            if insn == 0 {
                vm.status = STATUS_FAULT;
                vm.fault_pc = pc;
                vm.fault_addr = pc;
                break;
            }
            step = 2;
        } else {
            insn = raw;
            step = 4;
        }

        // Decode fields
        let opcode = insn & 0x7f;
        let rd = ((insn >> 7) & 0x1f) as usize;
        let funct3 = (insn >> 12) & 0x7;
        let rs1 = ((insn >> 15) & 0x1f) as usize;
        let rs2 = ((insn >> 20) & 0x1f) as usize;
        let funct7 = (insn >> 25) & 0x7f;
        let opcode_5 = (opcode >> 2) & 0x1f;

        // Single dispatch point — all decoded fields are locals
        match opcode_5 {
            // LOAD
            0x00 => {
                exec_load(base, &mut x, &mut pc, step, insn, rd, funct3, rs1);
            }
            // LOAD-FP
            0x01 => {
                exec_load_fp(base, &mut f, &mut x, &mut pc, step, insn, rd, funct3, rs1);
            }
            // MISC-MEM (FENCE)
            0x03 => {
                pc = pc.wrapping_add(step);
            }
            // OP-IMM
            0x04 => {
                exec_op_imm(insn, &mut x, rd, funct3, rs1, rs2, funct7);
                pc = pc.wrapping_add(step);
            }
            // AUIPC
            0x05 => {
                let imm = (insn & 0xFFFFF000) as i32;
                if rd != 0 {
                    x[rd] = pc.wrapping_add(imm as i64 as u64);
                }
                pc = pc.wrapping_add(step);
            }
            // OP-IMM-32
            0x06 => {
                exec_op_imm_32(insn, &mut x, rd, funct3, rs1, funct7);
                pc = pc.wrapping_add(step);
            }
            // STORE
            0x08 => {
                exec_store(base, &x, &mut pc, step, insn, funct3, rs1, rs2);
            }
            // STORE-FP
            0x09 => {
                exec_store_fp(base, &f, &x, &mut pc, step, insn, funct3, rs1, rs2);
            }
            // AMO
            0x0B => {
                exec_amo(base, &mut x, &mut pc, step, insn, rd, funct3, rs1, rs2, funct7);
            }
            // OP
            0x0C => {
                exec_op(insn, &mut x, rd, funct3, rs1, rs2, funct7);
                pc = pc.wrapping_add(step);
            }
            // LUI
            0x0D => {
                let imm = (insn & 0xFFFFF000) as i32;
                if rd != 0 {
                    x[rd] = imm as i64 as u64;
                }
                pc = pc.wrapping_add(step);
            }
            // OP-32
            0x0E => {
                exec_op_32(insn, &mut x, rd, funct3, rs1, rs2, funct7);
                pc = pc.wrapping_add(step);
            }
            // FMADD
            0x10 => {
                exec_fma(insn, &mut f, &mut fcsr, false, false);
                pc = pc.wrapping_add(step);
            }
            // FMSUB
            0x11 => {
                exec_fma(insn, &mut f, &mut fcsr, true, false);
                pc = pc.wrapping_add(step);
            }
            // FNMSUB
            0x12 => {
                exec_fma(insn, &mut f, &mut fcsr, false, true);
                pc = pc.wrapping_add(step);
            }
            // FNMADD
            0x13 => {
                exec_fma(insn, &mut f, &mut fcsr, true, true);
                pc = pc.wrapping_add(step);
            }
            // OP-FP
            0x14 => {
                exec_op_fp(insn, &mut x, &mut f, &mut fcsr, rd, funct3, rs1, rs2, funct7);
                pc = pc.wrapping_add(step);
            }
            // BRANCH — block dispatch at the loop top runs the block at the target
            0x18 => {
                if exec_branch(&x, funct3, rs1, rs2) {
                    pc = pc.wrapping_add(imm_b(insn) as i64 as u64);
                } else {
                    pc = pc.wrapping_add(step);
                }
            }
            // JALR
            0x19 => {
                let imm = (insn as i32) >> 20;
                let target = x[rs1].wrapping_add(imm as i64 as u64) & !1;
                if rd != 0 {
                    x[rd] = pc.wrapping_add(step);
                }
                pc = target;
            }
            // JAL
            0x1B => {
                if rd != 0 {
                    x[rd] = pc.wrapping_add(step);
                }
                pc = pc.wrapping_add(imm_j(insn) as i64 as u64);
            }
            // SYSTEM
            0x1C => {
                if funct3 == 0 {
                    if insn == 0x00000073 {
                        // ECALL
                        vm.x = x;
                        vm.pc = pc.wrapping_add(step);
                        vm.f = f;
                        vm.fcsr = fcsr;
                        syscall::handle(vm);
                        x = vm.x;
                        pc = vm.pc;
                        f = vm.f;
                        fcsr = vm.fcsr;
                        if vm.status != STATUS_OK && vm.status != STATUS_RUNNING {
                            remaining = 0;
                            break;
                        }
                        x[0] = 0;
                        continue;
                    } else if insn == 0x00100073 {
                        vm.status = STATUS_FAULT;
                        vm.fault_pc = pc;
                        break;
                    } else {
                        pc = pc.wrapping_add(step);
                    }
                } else {
                    exec_csr(&mut x, &mut fcsr, rd, funct3, rs1, insn);
                    pc = pc.wrapping_add(step);
                }
            }
            _ => {
                vm.status = STATUS_FAULT;
                vm.fault_pc = pc;
                vm.fault_addr = pc;
                break;
            }
        }

    }

    // Write back state
    x[0] = 0;
    vm.x = x;
    vm.pc = pc;
    vm.f = f;
    vm.fcsr = fcsr;

    remaining
}

// --- Immediate extractors ---

#[inline(always)]
fn imm_i(insn: u32) -> i32 {
    (insn as i32) >> 20
}

#[inline(always)]
fn imm_s(insn: u32) -> i32 {
    let lo = (insn >> 7) & 0x1f;
    let hi = (insn >> 25) & 0x7f;
    let val = lo | (hi << 5);
    ((val as i32) << 20) >> 20
}

#[inline(always)]
fn imm_b(insn: u32) -> i32 {
    let b11 = (insn >> 7) & 1;
    let b4_1 = (insn >> 8) & 0xf;
    let b10_5 = (insn >> 25) & 0x3f;
    let b12 = (insn >> 31) & 1;
    let val = (b4_1 << 1) | (b10_5 << 5) | (b11 << 11) | (b12 << 12);
    ((val as i32) << 19) >> 19
}

#[inline(always)]
fn imm_j(insn: u32) -> i32 {
    let b19_12 = (insn >> 12) & 0xff;
    let b11 = (insn >> 20) & 1;
    let b10_1 = (insn >> 21) & 0x3ff;
    let b20 = (insn >> 31) & 1;
    let val = (b10_1 << 1) | (b11 << 11) | (b19_12 << 12) | (b20 << 20);
    ((val as i32) << 11) >> 11
}

// --- Page functions: each #[inline(always)] so LTO fuses them into exec() ---

/// LOAD: lb, lh, lw, ld, lbu, lhu, lwu
#[inline(always)]
unsafe fn exec_load(
    base: u32,
    x: &mut [u64; 32],
    pc: &mut u64,
    step: u64,
    insn: u32,
    rd: usize,
    funct3: u32,
    rs1: usize,
) {
    let imm = imm_i(insn);
    let addr = x[rs1].wrapping_add(imm as i64 as u64);

    let val: u64 = match funct3 {
        0 => mem::read_i8(base, addr) as i64 as u64,    // LB
        1 => mem::read_i16(base, addr) as i64 as u64,   // LH
        2 => mem::read_i32(base, addr) as i64 as u64,   // LW
        3 => mem::read_u64(base, addr),                  // LD
        4 => mem::read_u8(base, addr) as u64,            // LBU
        5 => mem::read_u16(base, addr) as u64,           // LHU
        6 => mem::read_u32(base, addr) as u64,           // LWU
        _ => 0,
    };

    if rd != 0 {
        x[rd] = val;
    }
    *pc = pc.wrapping_add(step);
}

/// LOAD-FP: flw, fld
#[inline(always)]
unsafe fn exec_load_fp(
    base: u32,
    f: &mut [u64; 32],
    x: &mut [u64; 32],
    pc: &mut u64,
    step: u64,
    insn: u32,
    rd: usize,
    funct3: u32,
    rs1: usize,
) {
    let imm = imm_i(insn);
    let addr = x[rs1].wrapping_add(imm as i64 as u64);

    match funct3 {
        2 => {
            // FLW - load 32-bit float, NaN-box it
            let bits = mem::read_u32(base, addr);
            f[rd] = 0xFFFFFFFF00000000 | bits as u64;
        }
        3 => {
            // FLD - load 64-bit double
            f[rd] = mem::read_u64(base, addr);
        }
        _ => {}
    }
    *pc = pc.wrapping_add(step);
}

/// STORE: sb, sh, sw, sd
#[inline(always)]
unsafe fn exec_store(
    base: u32,
    x: &[u64; 32],
    pc: &mut u64,
    step: u64,
    insn: u32,
    funct3: u32,
    rs1: usize,
    rs2: usize,
) {
    let imm = imm_s(insn);
    let addr = x[rs1].wrapping_add(imm as i64 as u64);
    let val = x[rs2];

    match funct3 {
        0 => mem::write_u8(base, addr, val as u8),       // SB
        1 => mem::write_u16(base, addr, val as u16),     // SH
        2 => mem::write_u32(base, addr, val as u32),     // SW
        3 => mem::write_u64(base, addr, val),            // SD
        _ => {}
    }
    *pc = pc.wrapping_add(step);
}

/// STORE-FP: fsw, fsd
#[inline(always)]
unsafe fn exec_store_fp(
    base: u32,
    f: &[u64; 32],
    x: &[u64; 32],
    pc: &mut u64,
    step: u64,
    insn: u32,
    funct3: u32,
    rs1: usize,
    rs2: usize,
) {
    let imm = imm_s(insn);
    let addr = x[rs1].wrapping_add(imm as i64 as u64);

    match funct3 {
        2 => mem::write_u32(base, addr, f[rs2] as u32), // FSW
        3 => mem::write_u64(base, addr, f[rs2]),         // FSD
        _ => {}
    }
    *pc = pc.wrapping_add(step);
}

/// OP-IMM: addi, slti, sltiu, xori, ori, andi, slli, srli, srai
#[inline(always)]
fn exec_op_imm(
    insn: u32,
    x: &mut [u64; 32],
    rd: usize,
    funct3: u32,
    rs1: usize,
    _rs2: usize,
    _funct7: u32,
) {
    if rd == 0 {
        return;
    }
    let imm = imm_i(insn) as i64 as u64;
    let v1 = x[rs1];
    let shamt = (insn >> 20) & 0x3f;

    x[rd] = match funct3 {
        0 => v1.wrapping_add(imm),                          // ADDI
        1 => v1 << shamt,                                    // SLLI
        2 => {
            if (v1 as i64) < (imm as i64) { 1 } else { 0 }  // SLTI
        }
        3 => {
            if v1 < imm { 1 } else { 0 }                     // SLTIU
        }
        4 => v1 ^ imm,                                       // XORI
        5 => {
            if (insn >> 26) & 0x10 != 0 {
                // SRAI
                ((v1 as i64) >> shamt) as u64
            } else {
                // SRLI
                v1 >> shamt
            }
        }
        6 => v1 | imm,                                       // ORI
        7 => v1 & imm,                                       // ANDI
        _ => v1,
    };
}

/// OP-IMM-32: addiw, slliw, srliw, sraiw
#[inline(always)]
fn exec_op_imm_32(
    insn: u32,
    x: &mut [u64; 32],
    rd: usize,
    funct3: u32,
    rs1: usize,
    _funct7: u32,
) {
    if rd == 0 {
        return;
    }
    let imm = imm_i(insn);
    let v1 = x[rs1] as i32;
    let shamt = (insn >> 20) & 0x1f;

    let result: i32 = match funct3 {
        0 => v1.wrapping_add(imm as i32),                     // ADDIW
        1 => v1 << shamt,                                     // SLLIW
        5 => {
            if (insn >> 25) & 0x20 != 0 {
                v1 >> shamt                                     // SRAIW
            } else {
                ((v1 as u32) >> shamt) as i32                   // SRLIW
            }
        }
        _ => v1,
    };
    x[rd] = result as i64 as u64;
}

/// OP: add, sub, sll, slt, sltu, xor, srl, sra, or, and + M-extension mul/div
#[inline(always)]
fn exec_op(
    _insn: u32,
    x: &mut [u64; 32],
    rd: usize,
    funct3: u32,
    rs1: usize,
    rs2: usize,
    funct7: u32,
) {
    if rd == 0 {
        return;
    }
    let v1 = x[rs1];
    let v2 = x[rs2];

    // M-extension (funct7 == 1)
    if funct7 == 1 {
        x[rd] = exec_mul_div_64(v1, v2, funct3);
        return;
    }

    let shamt = (v2 & 0x3f) as u32;

    x[rd] = match (funct3, funct7) {
        (0, 0x00) => v1.wrapping_add(v2),                    // ADD
        (0, 0x20) => v1.wrapping_sub(v2),                    // SUB
        (1, _) => v1 << shamt,                                // SLL
        (2, _) => {
            if (v1 as i64) < (v2 as i64) { 1 } else { 0 }    // SLT
        }
        (3, _) => {
            if v1 < v2 { 1 } else { 0 }                       // SLTU
        }
        (4, _) => v1 ^ v2,                                    // XOR
        (5, 0x00) => v1 >> shamt,                              // SRL
        (5, 0x20) => ((v1 as i64) >> shamt) as u64,           // SRA
        (6, _) => v1 | v2,                                     // OR
        (7, _) => v1 & v2,                                     // AND
        _ => v1,
    };
}

/// OP-32: addw, subw, sllw, srlw, sraw + M-extension mul/div-w
#[inline(always)]
fn exec_op_32(
    _insn: u32,
    x: &mut [u64; 32],
    rd: usize,
    funct3: u32,
    rs1: usize,
    rs2: usize,
    funct7: u32,
) {
    if rd == 0 {
        return;
    }
    let v1 = x[rs1] as i32;
    let v2 = x[rs2] as i32;

    // M-extension W variants (funct7 == 1)
    if funct7 == 1 {
        x[rd] = exec_mul_div_32(v1, v2, funct3);
        return;
    }

    let shamt = (v2 & 0x1f) as u32;

    let result: i32 = match (funct3, funct7) {
        (0, 0x00) => v1.wrapping_add(v2),                    // ADDW
        (0, 0x20) => v1.wrapping_sub(v2),                    // SUBW
        (1, _) => v1 << shamt,                                // SLLW
        (5, 0x00) => ((v1 as u32) >> shamt) as i32,           // SRLW
        (5, 0x20) => v1 >> shamt,                              // SRAW
        _ => v1,
    };
    x[rd] = result as i64 as u64;
}

/// M-extension 64-bit: mul, mulh, mulhsu, mulhu, div, divu, rem, remu
#[inline(always)]
fn exec_mul_div_64(v1: u64, v2: u64, funct3: u32) -> u64 {
    match funct3 {
        0 => v1.wrapping_mul(v2),
        1 => {
            let a = v1 as i64 as i128;
            let b = v2 as i64 as i128;
            ((a * b) >> 64) as u64
        }
        2 => {
            let a = v1 as i64 as i128;
            let b = v2 as u128 as i128;
            ((a * b) >> 64) as u64
        }
        3 => {
            let a = v1 as u128;
            let b = v2 as u128;
            ((a * b) >> 64) as u64
        }
        4 => {
            let a = v1 as i64;
            let b = v2 as i64;
            if b == 0 { u64::MAX }
            else if a == i64::MIN && b == -1 { a as u64 }
            else { (a / b) as u64 }
        }
        5 => {
            if v2 == 0 { u64::MAX } else { v1 / v2 }
        }
        6 => {
            let a = v1 as i64;
            let b = v2 as i64;
            if b == 0 { v1 }
            else if a == i64::MIN && b == -1 { 0 }
            else { (a % b) as u64 }
        }
        7 => {
            if v2 == 0 { v1 } else { v1 % v2 }
        }
        _ => 0,
    }
}

/// M-extension 32-bit: mulw, divw, divuw, remw, remuw
#[inline(always)]
fn exec_mul_div_32(v1: i32, v2: i32, funct3: u32) -> u64 {
    let result: i32 = match funct3 {
        0 => v1.wrapping_mul(v2),
        4 => {
            if v2 == 0 { -1 }
            else if v1 == i32::MIN && v2 == -1 { v1 }
            else { v1 / v2 }
        }
        5 => {
            let a = v1 as u32;
            let b = v2 as u32;
            if b == 0 { -1i32 } else { (a / b) as i32 }
        }
        6 => {
            if v2 == 0 { v1 }
            else if v1 == i32::MIN && v2 == -1 { 0 }
            else { v1 % v2 }
        }
        7 => {
            let a = v1 as u32;
            let b = v2 as u32;
            if b == 0 { v1 } else { (a % b) as i32 }
        }
        _ => 0,
    };
    result as i64 as u64
}

/// BRANCH: beq, bne, blt, bge, bltu, bgeu
#[inline(always)]
fn exec_branch(x: &[u64; 32], funct3: u32, rs1: usize, rs2: usize) -> bool {
    let v1 = x[rs1];
    let v2 = x[rs2];

    match funct3 {
        0 => v1 == v2,                          // BEQ
        1 => v1 != v2,                          // BNE
        4 => (v1 as i64) < (v2 as i64),        // BLT
        5 => (v1 as i64) >= (v2 as i64),       // BGE
        6 => v1 < v2,                           // BLTU
        7 => v1 >= v2,                          // BGEU
        _ => false,
    }
}

/// AMO: atomic memory operations (A-extension)
#[inline(always)]
unsafe fn exec_amo(
    base: u32,
    x: &mut [u64; 32],
    pc: &mut u64,
    step: u64,
    _insn: u32,
    rd: usize,
    funct3: u32,
    rs1: usize,
    rs2: usize,
    funct7: u32,
) {
    let addr = x[rs1];
    let amo_op = funct7 >> 2;

    match funct3 {
        2 => {
            match amo_op {
                0x02 => {
                    let val = mem::read_i32(base, addr) as i64 as u64;
                    if rd != 0 { x[rd] = val; }
                }
                0x03 => {
                    mem::write_u32(base, addr, x[rs2] as u32);
                    if rd != 0 { x[rd] = 0; }
                }
                _ => {
                    let old = mem::read_i32(base, addr);
                    let src = x[rs2] as i32;
                    let new_val = amo_op_32(amo_op, old, src);
                    mem::write_u32(base, addr, new_val as u32);
                    if rd != 0 { x[rd] = old as i64 as u64; }
                }
            }
        }
        3 => {
            match amo_op {
                0x02 => {
                    let val = mem::read_u64(base, addr);
                    if rd != 0 { x[rd] = val; }
                }
                0x03 => {
                    mem::write_u64(base, addr, x[rs2]);
                    if rd != 0 { x[rd] = 0; }
                }
                _ => {
                    let old = mem::read_u64(base, addr);
                    let src = x[rs2];
                    let new_val = amo_op_64(amo_op, old, src);
                    mem::write_u64(base, addr, new_val);
                    if rd != 0 { x[rd] = old; }
                }
            }
        }
        _ => {}
    }
    *pc = pc.wrapping_add(step);
}

#[inline(always)]
fn amo_op_32(op: u32, old: i32, src: i32) -> i32 {
    match op {
        0x01 => src,
        0x00 => old.wrapping_add(src),
        0x04 => old ^ src,
        0x0C => old & src,
        0x08 => old | src,
        0x10 => if old < src { old } else { src },
        0x14 => if old > src { old } else { src },
        0x18 => if (old as u32) < (src as u32) { old } else { src },
        0x1C => if (old as u32) > (src as u32) { old } else { src },
        _ => old,
    }
}

#[inline(always)]
fn amo_op_64(op: u32, old: u64, src: u64) -> u64 {
    match op {
        0x01 => src,
        0x00 => old.wrapping_add(src),
        0x04 => old ^ src,
        0x0C => old & src,
        0x08 => old | src,
        0x10 => if (old as i64) < (src as i64) { old } else { src },
        0x14 => if (old as i64) > (src as i64) { old } else { src },
        0x18 => if old < src { old } else { src },
        0x1C => if old > src { old } else { src },
        _ => old,
    }
}

/// CSR instructions: csrrw, csrrs, csrrc, csrrwi, csrrsi, csrrci
#[inline(always)]
fn exec_csr(
    x: &mut [u64; 32],
    fcsr: &mut u32,
    rd: usize,
    funct3: u32,
    rs1: usize,
    insn: u32,
) {
    let csr = (insn >> 20) & 0xFFF;
    let uimm = rs1 as u32;

    let old = match csr {
        0x001 => *fcsr & 0x1F,
        0x002 => (*fcsr >> 5) & 0x7,
        0x003 => *fcsr & 0xFF,
        0xC00 => 0,
        0xC01 => 0,
        0xC02 => 0,
        _ => 0,
    };

    let src = match funct3 {
        1 | 5 => {
            if funct3 == 5 { uimm as u64 } else { x[rs1] }
        }
        2 | 6 => {
            let s = if funct3 == 6 { uimm as u64 } else { x[rs1] };
            old as u64 | s
        }
        3 | 7 => {
            let c = if funct3 == 7 { uimm as u64 } else { x[rs1] };
            old as u64 & !c
        }
        _ => old as u64,
    };

    let do_write = match funct3 {
        1 | 5 => true,
        2 | 3 => rs1 != 0,
        6 | 7 => uimm != 0,
        _ => false,
    };

    if do_write {
        match csr {
            0x001 => *fcsr = (*fcsr & !0x1F) | (src as u32 & 0x1F),
            0x002 => *fcsr = (*fcsr & !0xE0) | ((src as u32 & 0x7) << 5),
            0x003 => *fcsr = src as u32 & 0xFF,
            _ => {}
        }
    }

    if rd != 0 {
        x[rd] = old as u64;
    }
}

// --- Floating-point operations ---

#[inline(always)]
fn unbox_f32(bits: u64) -> f32 {
    if (bits >> 32) == 0xFFFFFFFF {
        f32::from_bits(bits as u32)
    } else {
        f32::from_bits(0x7FC00000)
    }
}

#[inline(always)]
fn nanbox_f32(val: f32) -> u64 {
    0xFFFFFFFF00000000 | val.to_bits() as u64
}

#[inline(always)]
fn exec_fma(
    insn: u32,
    f: &mut [u64; 32],
    _fcsr: &mut u32,
    negate_c: bool,
    negate_product: bool,
) {
    let rd = ((insn >> 7) & 0x1f) as usize;
    let rs1 = ((insn >> 15) & 0x1f) as usize;
    let rs2 = ((insn >> 20) & 0x1f) as usize;
    let rs3 = ((insn >> 27) & 0x1f) as usize;
    let fmt = (insn >> 25) & 0x3;

    match fmt {
        0 => {
            let a = unbox_f32(f[rs1]) as f64;
            let b = unbox_f32(f[rs2]) as f64;
            let c = unbox_f32(f[rs3]) as f64;
            let na = if negate_product { -a } else { a };
            let nc = if negate_c { -c } else { c };
            let result = na * b + nc;
            f[rd] = nanbox_f32(result as f32);
        }
        1 => {
            let a = f64::from_bits(f[rs1]);
            let b = f64::from_bits(f[rs2]);
            let c = f64::from_bits(f[rs3]);
            let na = if negate_product { -a } else { a };
            let nc = if negate_c { -c } else { c };
            let result = na * b + nc;
            f[rd] = result.to_bits();
        }
        _ => {}
    }
}

#[inline(always)]
fn exec_op_fp(
    insn: u32,
    x: &mut [u64; 32],
    f: &mut [u64; 32],
    _fcsr: &mut u32,
    rd: usize,
    _funct3: u32,
    rs1: usize,
    rs2: usize,
    funct7: u32,
) {
    match funct7 {
        0x00 => { let a = unbox_f32(f[rs1]); let b = unbox_f32(f[rs2]); f[rd] = nanbox_f32(a + b); }
        0x04 => { let a = unbox_f32(f[rs1]); let b = unbox_f32(f[rs2]); f[rd] = nanbox_f32(a - b); }
        0x08 => { let a = unbox_f32(f[rs1]); let b = unbox_f32(f[rs2]); f[rd] = nanbox_f32(a * b); }
        0x0C => { let a = unbox_f32(f[rs1]); let b = unbox_f32(f[rs2]); f[rd] = nanbox_f32(a / b); }
        0x2C => { let a = unbox_f32(f[rs1]); f[rd] = nanbox_f32(unsafe { sqrtf(a) }); }
        0x10 => {
            let a = f[rs1] as u32; let b = f[rs2] as u32;
            let funct3 = ((insn >> 12) & 0x7) as u32;
            let result = match funct3 {
                0 => (a & 0x7FFFFFFF) | (b & 0x80000000),
                1 => (a & 0x7FFFFFFF) | ((b ^ 0x80000000) & 0x80000000),
                2 => (a & 0x7FFFFFFF) | ((a ^ b) & 0x80000000),
                _ => a,
            };
            f[rd] = nanbox_f32(f32::from_bits(result));
        }
        0x14 => {
            let a = unbox_f32(f[rs1]); let b = unbox_f32(f[rs2]);
            let funct3 = (insn >> 12) & 0x7;
            let result = match funct3 {
                0 => { if a.is_nan() { b } else if b.is_nan() { a } else if a < b { a } else if b < a { b } else if a.to_bits() & 0x80000000 != 0 { a } else { b } }
                1 => { if a.is_nan() { b } else if b.is_nan() { a } else if a > b { a } else if b > a { b } else if a.to_bits() & 0x80000000 == 0 { a } else { b } }
                _ => a,
            };
            f[rd] = nanbox_f32(result);
        }
        0x60 => {
            let a = unbox_f32(f[rs1]) as f64;
            if rd != 0 {
                x[rd] = match rs2 {
                    0 => (a as i32) as i64 as u64,
                    1 => (a as u32) as i32 as i64 as u64,
                    2 => (a as i64) as u64,
                    3 => a as u64,
                    _ => 0,
                };
            }
        }
        0x68 => {
            let result = match rs2 {
                0 => x[rs1] as i32 as f32,
                1 => x[rs1] as u32 as f32,
                2 => x[rs1] as i64 as f32,
                3 => x[rs1] as f32,
                _ => 0.0,
            };
            f[rd] = nanbox_f32(result);
        }
        0x70 => {
            let funct3 = (insn >> 12) & 0x7;
            if funct3 == 0 {
                if rd != 0 { x[rd] = (f[rs1] as u32) as i32 as i64 as u64; }
            } else if funct3 == 1 {
                if rd != 0 { x[rd] = fclass_f32(unbox_f32(f[rs1])) as u64; }
            }
        }
        0x78 => { f[rd] = nanbox_f32(f32::from_bits(x[rs1] as u32)); }
        0x50 => {
            let a = unbox_f32(f[rs1]); let b = unbox_f32(f[rs2]);
            let funct3 = (insn >> 12) & 0x7;
            if rd != 0 {
                x[rd] = match funct3 {
                    2 => if a == b { 1 } else { 0 },
                    1 => if a < b { 1 } else { 0 },
                    0 => if a <= b { 1 } else { 0 },
                    _ => 0,
                };
            }
        }
        // Double precision
        0x01 => { let a = f64::from_bits(f[rs1]); let b = f64::from_bits(f[rs2]); f[rd] = (a + b).to_bits(); }
        0x05 => { let a = f64::from_bits(f[rs1]); let b = f64::from_bits(f[rs2]); f[rd] = (a - b).to_bits(); }
        0x09 => { let a = f64::from_bits(f[rs1]); let b = f64::from_bits(f[rs2]); f[rd] = (a * b).to_bits(); }
        0x0D => { let a = f64::from_bits(f[rs1]); let b = f64::from_bits(f[rs2]); f[rd] = (a / b).to_bits(); }
        0x2D => { let a = f64::from_bits(f[rs1]); f[rd] = unsafe { sqrt(a) }.to_bits(); }
        0x11 => {
            let a = f[rs1]; let b = f[rs2];
            let funct3 = (insn >> 12) & 0x7;
            f[rd] = match funct3 {
                0 => (a & 0x7FFFFFFFFFFFFFFF) | (b & 0x8000000000000000),
                1 => (a & 0x7FFFFFFFFFFFFFFF) | ((b ^ 0x8000000000000000) & 0x8000000000000000),
                2 => (a & 0x7FFFFFFFFFFFFFFF) | ((a ^ b) & 0x8000000000000000),
                _ => a,
            };
        }
        0x15 => {
            let a = f64::from_bits(f[rs1]); let b = f64::from_bits(f[rs2]);
            let funct3 = (insn >> 12) & 0x7;
            let result = match funct3 {
                0 => { if a.is_nan() { b } else if b.is_nan() { a } else if a < b { a } else if b < a { b } else if f[rs1] & 0x8000000000000000 != 0 { a } else { b } }
                1 => { if a.is_nan() { b } else if b.is_nan() { a } else if a > b { a } else if b > a { b } else if f[rs1] & 0x8000000000000000 == 0 { a } else { b } }
                _ => a,
            };
            f[rd] = result.to_bits();
        }
        0x20 => { let a = f64::from_bits(f[rs1]); f[rd] = nanbox_f32(a as f32); }
        0x21 => { let a = unbox_f32(f[rs1]); f[rd] = (a as f64).to_bits(); }
        0x51 => {
            let a = f64::from_bits(f[rs1]); let b = f64::from_bits(f[rs2]);
            let funct3 = (insn >> 12) & 0x7;
            if rd != 0 {
                x[rd] = match funct3 {
                    2 => if a == b { 1 } else { 0 },
                    1 => if a < b { 1 } else { 0 },
                    0 => if a <= b { 1 } else { 0 },
                    _ => 0,
                };
            }
        }
        0x61 => {
            let a = f64::from_bits(f[rs1]);
            if rd != 0 {
                x[rd] = match rs2 {
                    0 => (a as i32) as i64 as u64,
                    1 => (a as u32) as i32 as i64 as u64,
                    2 => (a as i64) as u64,
                    3 => a as u64,
                    _ => 0,
                };
            }
        }
        0x69 => {
            let result: f64 = match rs2 {
                0 => x[rs1] as i32 as f64,
                1 => x[rs1] as u32 as f64,
                2 => x[rs1] as i64 as f64,
                3 => x[rs1] as f64,
                _ => 0.0,
            };
            f[rd] = result.to_bits();
        }
        0x71 => {
            let funct3 = (insn >> 12) & 0x7;
            if funct3 == 0 {
                if rd != 0 { x[rd] = f[rs1]; }
            } else if funct3 == 1 {
                if rd != 0 { x[rd] = fclass_f64(f64::from_bits(f[rs1])) as u64; }
            }
        }
        0x79 => { f[rd] = x[rs1]; }
        _ => {}
    }
}

#[inline(always)]
fn fclass_f32(val: f32) -> u32 {
    let bits = val.to_bits();
    let sign = bits >> 31;
    let exp = (bits >> 23) & 0xFF;
    let frac = bits & 0x7FFFFF;

    if exp == 0xFF {
        if frac == 0 {
            if sign != 0 { 1 << 0 } else { 1 << 7 }
        } else if frac & 0x400000 != 0 {
            1 << 9
        } else {
            1 << 8
        }
    } else if exp == 0 {
        if frac == 0 {
            if sign != 0 { 1 << 3 } else { 1 << 4 }
        } else {
            if sign != 0 { 1 << 2 } else { 1 << 5 }
        }
    } else {
        if sign != 0 { 1 << 1 } else { 1 << 6 }
    }
}

#[inline(always)]
fn fclass_f64(val: f64) -> u32 {
    let bits = val.to_bits();
    let sign = bits >> 63;
    let exp = (bits >> 52) & 0x7FF;
    let frac = bits & 0xFFFFFFFFFFFFF;

    if exp == 0x7FF {
        if frac == 0 {
            if sign != 0 { 1 << 0 } else { 1 << 7 }
        } else if frac & 0x8000000000000 != 0 {
            1 << 9
        } else {
            1 << 8
        }
    } else if exp == 0 {
        if frac == 0 {
            if sign != 0 { 1 << 3 } else { 1 << 4 }
        } else {
            if sign != 0 { 1 << 2 } else { 1 << 5 }
        }
    } else {
        if sign != 0 { 1 << 1 } else { 1 << 6 }
    }
}
