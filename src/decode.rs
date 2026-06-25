// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/// Expand a 16-bit RV64C compressed instruction into a 32-bit RV64I equivalent.
/// Returns 0 for illegal/unknown compressed instructions.
#[inline(always)]
pub fn expand_compressed(inst: u16) -> u32 {
    let op = inst & 0x3;
    let funct3 = (inst >> 13) & 0x7;

    match op {
        0 => expand_q0(inst, funct3),
        1 => expand_q1(inst, funct3),
        2 => expand_q2(inst, funct3),
        _ => 0, // bits[1:0]==3 means 32-bit, should not reach here
    }
}

/// Quadrant 0: loads/stores relative to sp or regs, ADDI4SPN
#[inline(always)]
fn expand_q0(inst: u16, funct3: u16) -> u32 {
    match funct3 {
        // C.ADDI4SPN -> addi rd', x2, nzuimm
        0 => {
            let nzuimm = c_addi4spn_imm(inst);
            if nzuimm == 0 {
                return 0; // illegal
            }
            let rd = creg(inst, 2);
            // addi rd, x2, nzuimm
            encode_i(0b0010011, rd, 0b000, 2, nzuimm as i32)
        }
        // C.FLD -> fld rd', offset(rs1')  [RV64]
        1 => {
            let rd = creg(inst, 2);
            let rs1 = creg(inst, 7);
            let off = c_ld_offset(inst);
            encode_i(0b0000111, rd, 0b011, rs1, off as i32)
        }
        // C.LW -> lw rd', offset(rs1')
        2 => {
            let rd = creg(inst, 2);
            let rs1 = creg(inst, 7);
            let off = c_lw_offset(inst);
            encode_i(0b0000011, rd, 0b010, rs1, off as i32)
        }
        // C.LD -> ld rd', offset(rs1')  [RV64]
        3 => {
            let rd = creg(inst, 2);
            let rs1 = creg(inst, 7);
            let off = c_ld_offset(inst);
            encode_i(0b0000011, rd, 0b011, rs1, off as i32)
        }
        // Reserved
        4 => 0,
        // C.FSD -> fsd rs2', offset(rs1')  [RV64]
        5 => {
            let rs2 = creg(inst, 2);
            let rs1 = creg(inst, 7);
            let off = c_ld_offset(inst);
            encode_s(0b0100111, 0b011, rs1, rs2, off as i32)
        }
        // C.SW -> sw rs2', offset(rs1')
        6 => {
            let rs2 = creg(inst, 2);
            let rs1 = creg(inst, 7);
            let off = c_lw_offset(inst);
            encode_s(0b0100011, 0b010, rs1, rs2, off as i32)
        }
        // C.SD -> sd rs2', offset(rs1')  [RV64]
        7 => {
            let rs2 = creg(inst, 2);
            let rs1 = creg(inst, 7);
            let off = c_ld_offset(inst);
            encode_s(0b0100011, 0b011, rs1, rs2, off as i32)
        }
        _ => 0,
    }
}

/// Quadrant 1: arithmetic, branches, jumps
#[inline(always)]
fn expand_q1(inst: u16, funct3: u16) -> u32 {
    match funct3 {
        // C.NOP / C.ADDI -> addi rd, rd, nzimm
        0 => {
            let rd = ((inst >> 7) & 0x1f) as u32;
            let imm = c_imm6_signed(inst);
            if rd == 0 {
                // C.NOP -> addi x0, x0, 0
                encode_i(0b0010011, 0, 0b000, 0, 0)
            } else {
                encode_i(0b0010011, rd, 0b000, rd, imm)
            }
        }
        // C.ADDIW -> addiw rd, rd, imm  [RV64]
        1 => {
            let rd = ((inst >> 7) & 0x1f) as u32;
            if rd == 0 {
                return 0; // illegal
            }
            let imm = c_imm6_signed(inst);
            encode_i(0b0011011, rd, 0b000, rd, imm)
        }
        // C.LI -> addi rd, x0, imm
        2 => {
            let rd = ((inst >> 7) & 0x1f) as u32;
            let imm = c_imm6_signed(inst);
            encode_i(0b0010011, rd, 0b000, 0, imm)
        }
        // C.ADDI16SP / C.LUI
        3 => {
            let rd = ((inst >> 7) & 0x1f) as u32;
            if rd == 2 {
                // C.ADDI16SP -> addi x2, x2, nzimm
                let imm = c_addi16sp_imm(inst);
                if imm == 0 {
                    return 0;
                }
                encode_i(0b0010011, 2, 0b000, 2, imm)
            } else if rd != 0 {
                // C.LUI -> lui rd, nzimm
                let imm = c_lui_imm(inst);
                if imm == 0 {
                    return 0;
                }
                encode_u(0b0110111, rd, imm)
            } else {
                0
            }
        }
        // C.SRLI, C.SRAI, C.ANDI, C.SUB, C.XOR, C.OR, C.AND, C.SUBW, C.ADDW
        4 => expand_q1_alu(inst),
        // C.J -> jal x0, offset
        5 => {
            let off = c_j_offset(inst);
            encode_j(0b1101111, 0, off)
        }
        // C.BEQZ -> beq rs1', x0, offset
        6 => {
            let rs1 = creg(inst, 7);
            let off = c_branch_offset(inst);
            encode_b(0b1100011, 0b000, rs1, 0, off)
        }
        // C.BNEZ -> bne rs1', x0, offset
        7 => {
            let rs1 = creg(inst, 7);
            let off = c_branch_offset(inst);
            encode_b(0b1100011, 0b001, rs1, 0, off)
        }
        _ => 0,
    }
}

/// Quadrant 1, funct3=4: ALU operations on compressed registers
#[inline(always)]
fn expand_q1_alu(inst: u16) -> u32 {
    let rd = creg(inst, 7);
    let funct2 = (inst >> 10) & 0x3;
    match funct2 {
        // C.SRLI -> srli rd', rd', shamt
        0 => {
            let shamt = c_shamt(inst);
            encode_i(0b0010011, rd, 0b101, rd, shamt as i32) // funct7=0 for SRLI
        }
        // C.SRAI -> srai rd', rd', shamt
        1 => {
            let shamt = c_shamt(inst);
            encode_i(0b0010011, rd, 0b101, rd, (shamt | 0x400) as i32) // funct7=0x20 for SRAI
        }
        // C.ANDI -> andi rd', rd', imm
        2 => {
            let imm = c_imm6_signed(inst);
            encode_i(0b0010011, rd, 0b111, rd, imm)
        }
        // Sub-encoded: C.SUB, C.XOR, C.OR, C.AND, C.SUBW, C.ADDW
        3 => {
            let rs2 = creg(inst, 2);
            let funct1 = (inst >> 12) & 1;
            let funct2b = (inst >> 5) & 0x3;
            match (funct1, funct2b) {
                // C.SUB -> sub rd', rd', rs2'
                (0, 0) => encode_r(0b0110011, rd, 0b000, rd, rs2, 0b0100000),
                // C.XOR -> xor rd', rd', rs2'
                (0, 1) => encode_r(0b0110011, rd, 0b100, rd, rs2, 0b0000000),
                // C.OR -> or rd', rd', rs2'
                (0, 2) => encode_r(0b0110011, rd, 0b110, rd, rs2, 0b0000000),
                // C.AND -> and rd', rd', rs2'
                (0, 3) => encode_r(0b0110011, rd, 0b111, rd, rs2, 0b0000000),
                // C.SUBW -> subw rd', rd', rs2'  [RV64]
                (1, 0) => encode_r(0b0111011, rd, 0b000, rd, rs2, 0b0100000),
                // C.ADDW -> addw rd', rd', rs2'  [RV64]
                (1, 1) => encode_r(0b0111011, rd, 0b000, rd, rs2, 0b0000000),
                _ => 0, // reserved
            }
        }
        _ => 0,
    }
}

/// Quadrant 2: stack-pointer relative loads/stores, jumps, MV, ADD
#[inline(always)]
fn expand_q2(inst: u16, funct3: u16) -> u32 {
    match funct3 {
        // C.SLLI -> slli rd, rd, shamt
        0 => {
            let rd = ((inst >> 7) & 0x1f) as u32;
            if rd == 0 {
                return 0;
            }
            let shamt = c_shamt(inst);
            encode_i(0b0010011, rd, 0b001, rd, shamt as i32)
        }
        // C.FLDSP -> fld rd, offset(x2)
        1 => {
            let rd = ((inst >> 7) & 0x1f) as u32;
            let off = c_ldsp_offset(inst);
            encode_i(0b0000111, rd, 0b011, 2, off as i32)
        }
        // C.LWSP -> lw rd, offset(x2)
        2 => {
            let rd = ((inst >> 7) & 0x1f) as u32;
            if rd == 0 {
                return 0;
            }
            let off = c_lwsp_offset(inst);
            encode_i(0b0000011, rd, 0b010, 2, off as i32)
        }
        // C.LDSP -> ld rd, offset(x2)  [RV64]
        3 => {
            let rd = ((inst >> 7) & 0x1f) as u32;
            if rd == 0 {
                return 0;
            }
            let off = c_ldsp_offset(inst);
            encode_i(0b0000011, rd, 0b011, 2, off as i32)
        }
        // C.JR, C.MV, C.JALR, C.ADD, C.EBREAK
        4 => {
            let rd = ((inst >> 7) & 0x1f) as u32;
            let rs2 = ((inst >> 2) & 0x1f) as u32;
            let bit12 = (inst >> 12) & 1;
            if bit12 == 0 {
                if rs2 == 0 {
                    // C.JR -> jalr x0, 0(rs1)
                    if rd == 0 {
                        return 0;
                    }
                    encode_i(0b1100111, 0, 0b000, rd, 0)
                } else {
                    // C.MV -> add rd, x0, rs2
                    encode_r(0b0110011, rd, 0b000, 0, rs2, 0b0000000)
                }
            } else {
                if rs2 == 0 && rd == 0 {
                    // C.EBREAK -> ebreak
                    0b00000000000100000000000001110011
                } else if rs2 == 0 {
                    // C.JALR -> jalr x1, 0(rs1)
                    encode_i(0b1100111, 1, 0b000, rd, 0)
                } else {
                    // C.ADD -> add rd, rd, rs2
                    encode_r(0b0110011, rd, 0b000, rd, rs2, 0b0000000)
                }
            }
        }
        // C.FSDSP -> fsd rs2, offset(x2)
        5 => {
            let rs2 = ((inst >> 2) & 0x1f) as u32;
            let off = c_sdsp_offset(inst);
            encode_s(0b0100111, 0b011, 2, rs2, off as i32)
        }
        // C.SWSP -> sw rs2, offset(x2)
        6 => {
            let rs2 = ((inst >> 2) & 0x1f) as u32;
            let off = c_swsp_offset(inst);
            encode_s(0b0100011, 0b010, 2, rs2, off as i32)
        }
        // C.SDSP -> sd rs2, offset(x2)  [RV64]
        7 => {
            let rs2 = ((inst >> 2) & 0x1f) as u32;
            let off = c_sdsp_offset(inst);
            encode_s(0b0100011, 0b011, 2, rs2, off as i32)
        }
        _ => 0,
    }
}

// --- Immediate extraction helpers ---

/// Compressed register: bits[offset+2:offset] + 8
#[inline(always)]
fn creg(inst: u16, offset: u16) -> u32 {
    (((inst >> offset) & 0x7) + 8) as u32
}

/// C.ADDI4SPN nzuimm: inst[5]=3, inst[12:7]=nzuimm[5:4|9:6|2|3]
#[inline(always)]
fn c_addi4spn_imm(inst: u16) -> u32 {
    let i = inst as u32;
    let b3 = (i >> 5) & 1;
    let b2 = (i >> 6) & 1;
    let b96 = (i >> 7) & 0xf;
    let b54 = (i >> 11) & 0x3;
    (b3 << 3) | (b2 << 2) | (b96 << 6) | (b54 << 4)
}

/// C.LW offset: inst[5]=6, inst[12:10]=off[5:3], inst[6]=off[2]
#[inline(always)]
fn c_lw_offset(inst: u16) -> u32 {
    let i = inst as u32;
    let b6 = (i >> 5) & 1;
    let b2 = (i >> 6) & 1;
    let b53 = (i >> 10) & 0x7;
    (b53 << 3) | (b6 << 6) | (b2 << 2)
}

/// C.LD/C.FLD/C.SD/C.FSD offset: inst[6:5]=off[7:6], inst[12:10]=off[5:3]
#[inline(always)]
fn c_ld_offset(inst: u16) -> u32 {
    let i = inst as u32;
    let b76 = (i >> 5) & 0x3;
    let b53 = (i >> 10) & 0x7;
    (b53 << 3) | (b76 << 6)
}

/// 6-bit signed immediate: inst[12]=imm[5], inst[6:2]=imm[4:0]
#[inline(always)]
fn c_imm6_signed(inst: u16) -> i32 {
    let lo = ((inst >> 2) & 0x1f) as u32;
    let hi = ((inst >> 12) & 1) as u32;
    let val = lo | (hi << 5);
    // sign extend from bit 5
    if hi != 0 {
        (val | 0xFFFFFFC0) as i32
    } else {
        val as i32
    }
}

/// Shift amount (6-bit unsigned): inst[12]=shamt[5], inst[6:2]=shamt[4:0]
#[inline(always)]
fn c_shamt(inst: u16) -> u32 {
    let lo = ((inst >> 2) & 0x1f) as u32;
    let hi = ((inst >> 12) & 1) as u32;
    lo | (hi << 5)
}

/// C.ADDI16SP nzimm: signed, scaled by 16
#[inline(always)]
fn c_addi16sp_imm(inst: u16) -> i32 {
    let i = inst as u32;
    let b5 = (i >> 2) & 1;
    let b87 = (i >> 3) & 0x3;
    let b6 = (i >> 5) & 1;
    let b4 = (i >> 6) & 1;
    let b9 = (i >> 12) & 1;
    let val = (b5 << 5) | (b87 << 7) | (b6 << 6) | (b4 << 4) | (b9 << 9);
    if b9 != 0 {
        (val | 0xFFFFFC00) as i32
    } else {
        val as i32
    }
}

/// C.LUI nzimm: signed, bits [17:12]
#[inline(always)]
fn c_lui_imm(inst: u16) -> i32 {
    let lo = ((inst >> 2) & 0x1f) as u32;
    let hi = ((inst >> 12) & 1) as u32;
    let val = (lo | (hi << 5)) << 12;
    if hi != 0 {
        (val | 0xFFFC0000) as i32
    } else {
        val as i32
    }
}

/// C.J offset (signed, 12-bit)
#[inline(always)]
fn c_j_offset(inst: u16) -> i32 {
    let i = inst as u32;
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
    if b11 != 0 {
        (val | 0xFFFFF000) as i32
    } else {
        val as i32
    }
}

/// C.BEQZ / C.BNEZ offset (signed, 9-bit)
#[inline(always)]
fn c_branch_offset(inst: u16) -> i32 {
    let i = inst as u32;
    let b5 = (i >> 2) & 1;
    let b21 = (i >> 3) & 0x3;
    let b76 = (i >> 5) & 0x3;
    let b43 = (i >> 10) & 0x3;
    let b8 = (i >> 12) & 1;
    let val = (b21 << 1) | (b43 << 3) | (b5 << 5) | (b76 << 6) | (b8 << 8);
    if b8 != 0 {
        (val | 0xFFFFFE00) as i32
    } else {
        val as i32
    }
}

/// C.LWSP offset (unsigned, scaled by 4)
#[inline(always)]
fn c_lwsp_offset(inst: u16) -> u32 {
    let i = inst as u32;
    let b5 = (i >> 12) & 1;
    let b42 = (i >> 4) & 0x7;
    let b76 = (i >> 2) & 0x3;
    (b42 << 2) | (b5 << 5) | (b76 << 6)
}

/// C.LDSP offset (unsigned, scaled by 8)
#[inline(always)]
fn c_ldsp_offset(inst: u16) -> u32 {
    let i = inst as u32;
    let b5 = (i >> 12) & 1;
    let b43 = (i >> 5) & 0x3;
    let b86 = (i >> 2) & 0x7;
    (b43 << 3) | (b5 << 5) | (b86 << 6)
}

/// C.SWSP offset (unsigned, scaled by 4)
#[inline(always)]
fn c_swsp_offset(inst: u16) -> u32 {
    let i = inst as u32;
    let b52 = (i >> 9) & 0xf;
    let b76 = (i >> 7) & 0x3;
    (b52 << 2) | (b76 << 6)
}

/// C.SDSP offset (unsigned, scaled by 8)
#[inline(always)]
fn c_sdsp_offset(inst: u16) -> u32 {
    let i = inst as u32;
    let b53 = (i >> 10) & 0x7;
    let b86 = (i >> 7) & 0x7;
    (b53 << 3) | (b86 << 6)
}

// --- Instruction encoding helpers ---

#[inline(always)]
fn encode_r(opcode: u32, rd: u32, funct3: u32, rs1: u32, rs2: u32, funct7: u32) -> u32 {
    opcode | (rd << 7) | (funct3 << 12) | (rs1 << 15) | (rs2 << 20) | (funct7 << 25)
}

#[inline(always)]
fn encode_i(opcode: u32, rd: u32, funct3: u32, rs1: u32, imm: i32) -> u32 {
    opcode | (rd << 7) | (funct3 << 12) | (rs1 << 15) | ((imm as u32) << 20)
}

#[inline(always)]
fn encode_s(opcode: u32, funct3: u32, rs1: u32, rs2: u32, imm: i32) -> u32 {
    let imm = imm as u32;
    opcode | ((imm & 0x1f) << 7) | (funct3 << 12) | (rs1 << 15) | (rs2 << 20)
        | (((imm >> 5) & 0x7f) << 25)
}

#[inline(always)]
fn encode_b(opcode: u32, funct3: u32, rs1: u32, rs2: u32, imm: i32) -> u32 {
    let imm = imm as u32;
    let b11 = (imm >> 11) & 1;
    let b4_1 = (imm >> 1) & 0xf;
    let b10_5 = (imm >> 5) & 0x3f;
    let b12 = (imm >> 12) & 1;
    opcode | (b11 << 7) | (b4_1 << 8) | (funct3 << 12) | (rs1 << 15) | (rs2 << 20)
        | (b10_5 << 25) | (b12 << 31)
}

#[inline(always)]
fn encode_u(opcode: u32, rd: u32, imm: i32) -> u32 {
    opcode | (rd << 7) | (imm as u32 & 0xFFFFF000)
}

#[inline(always)]
fn encode_j(opcode: u32, rd: u32, imm: i32) -> u32 {
    let imm = imm as u32;
    let b20 = (imm >> 20) & 1;
    let b10_1 = (imm >> 1) & 0x3ff;
    let b11 = (imm >> 11) & 1;
    let b19_12 = (imm >> 12) & 0xff;
    opcode | (rd << 7) | (b19_12 << 12) | (b11 << 20) | (b10_1 << 21) | (b20 << 31)
}
