// Lazy EFLAGS materializer and condition code evaluator.
// Exact Bellard strategy: 3 stores per ALU op, compute flags on demand.

use crate::types::*;

// Parity lookup table: parity_table[i] == 1 if i has even number of set bits
static PARITY_TABLE: [u8; 256] = {
    let mut table = [0u8; 256];
    let mut i = 0u32;
    while i < 256 {
        let mut bits = 0u32;
        let mut v = i;
        while v != 0 {
            bits += v & 1;
            v >>= 1;
        }
        table[i as usize] = if bits & 1 == 0 { 1 } else { 0 };
        i += 1;
    }
    table
};

/// Set lazy flags after an ALU operation.
/// This is the hot path: 3 stores, no computation.
#[inline(always)]
pub fn set_lazy(cpu: &mut Cpu, op: FlagOp, src: u64, res: u64) {
    cpu.lazy.op = op;
    cpu.lazy.src = src;
    cpu.lazy.res = res;
}

/// Materialize all arithmetic RFLAGS from lazy state.
/// Called only when flags are actually needed (Jcc, PUSHF, LAHF, etc.)
pub fn materialize_flags(cpu: &mut Cpu) -> u64 {
    let op = cpu.lazy.op;
    let src = cpu.lazy.src;
    let res = cpu.lazy.res;

    // If flags were set externally, just return rflags
    if matches!(op, FlagOp::External) {
        return cpu.rflags;
    }

    // Clear arithmetic flags, preserve system flags (IF, DF, IOPL, etc.)
    let mut f = cpu.rflags & !(CF | PF | AF | ZF | SF | OF);

    match op {
        // ========== ADD operations ==========
        FlagOp::AddB => {
            let r = res as u8;
            let s = src as u8;
            if r == 0 { f |= ZF; }
            if r & 0x80 != 0 { f |= SF; }
            if (r as u16) < (s as u16) { f |= CF; }  // carry = result < src
            if ((s ^ r) & !(src as u8 ^ (res.wrapping_sub(src as u64)) as u8)) & 0x80 != 0 { }
            // Overflow: both operands same sign, result different sign
            let dst = res.wrapping_sub(src) as u8;
            if ((src as u8 ^ r) & (dst ^ r) & 0x80) != 0 { f |= OF; }
            // Nope, simpler: for ADD, OF = (s ^ res) & (d ^ res) where d = res - s
            // Actually: src is the first operand. res = src + other.
            // other = res - src. OF = ((src ^ res) & ((res-src) ^ res)) >> 7 & 1
            // But TinyEMU stores: src=first operand, res=result
            // So other = res - src
            let other = res.wrapping_sub(src) as u8;
            f &= !OF; // clear, recompute
            if ((s ^ other) & 0x80) == 0 && ((s ^ r) & 0x80) != 0 { f |= OF; }
            if ((s ^ other ^ r) & 0x10) != 0 { f |= AF; }
            if PARITY_TABLE[r as usize] != 0 { f |= PF; }
        }
        FlagOp::AddW => {
            let r = res as u16;
            let s = src as u16;
            let other = res.wrapping_sub(src) as u16;
            if r == 0 { f |= ZF; }
            if r & 0x8000 != 0 { f |= SF; }
            if (res as u32 & 0xFFFF) < (src as u32 & 0xFFFF) { f |= CF; }
            if ((s ^ other) & 0x8000) == 0 && ((s ^ r) & 0x8000) != 0 { f |= OF; }
            if ((s ^ other ^ r) & 0x10) != 0 { f |= AF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }
        FlagOp::AddL => {
            let r = res as u32;
            let s = src as u32;
            let other = res.wrapping_sub(src) as u32;
            if r == 0 { f |= ZF; }
            if r & 0x80000000 != 0 { f |= SF; }
            if (res & 0xFFFFFFFF) < (src & 0xFFFFFFFF) { f |= CF; }
            if ((s ^ other) & 0x80000000) == 0 && ((s ^ r) & 0x80000000) != 0 { f |= OF; }
            if ((s ^ other ^ r) & 0x10) != 0 { f |= AF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }
        FlagOp::AddQ => {
            let r = res;
            let s = src;
            let other = res.wrapping_sub(src);
            if r == 0 { f |= ZF; }
            if r & 0x8000000000000000 != 0 { f |= SF; }
            if r < s { f |= CF; }
            if ((s ^ other) & 0x8000000000000000) == 0 && ((s ^ r) & 0x8000000000000000) != 0 { f |= OF; }
            if ((s ^ other ^ r) & 0x10) != 0 { f |= AF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }

        // ========== SUB/CMP operations ==========
        // For SUB: src = first operand (lhs), res = result. other = src - res.
        FlagOp::SubB => {
            let r = res as u8;
            let s = src as u8;
            let other = src.wrapping_sub(res) as u8; // the subtrahend
            if r == 0 { f |= ZF; }
            if r & 0x80 != 0 { f |= SF; }
            if (s as u16) < (other as u16) { f |= CF; }  // borrow
            if ((s ^ other) & (s ^ r) & 0x80) != 0 { f |= OF; }
            if ((s ^ other ^ r) & 0x10) != 0 { f |= AF; }
            if PARITY_TABLE[r as usize] != 0 { f |= PF; }
        }
        FlagOp::SubW => {
            let r = res as u16;
            let s = src as u16;
            let other = src.wrapping_sub(res) as u16;
            if r == 0 { f |= ZF; }
            if r & 0x8000 != 0 { f |= SF; }
            if (s as u32 & 0xFFFF) < (other as u32 & 0xFFFF) { f |= CF; }
            if ((s ^ other) & (s ^ r) & 0x8000) != 0 { f |= OF; }
            if ((s ^ other ^ r) & 0x10) != 0 { f |= AF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }
        FlagOp::SubL => {
            let r = res as u32;
            let s = src as u32;
            let other = src.wrapping_sub(res) as u32;
            if r == 0 { f |= ZF; }
            if r & 0x80000000 != 0 { f |= SF; }
            if s < other { f |= CF; }
            if ((s ^ other) & (s ^ r) & 0x80000000) != 0 { f |= OF; }
            if ((s ^ other ^ r) & 0x10) != 0 { f |= AF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }
        FlagOp::SubQ => {
            let r = res;
            let s = src;
            let other = src.wrapping_sub(res);
            if r == 0 { f |= ZF; }
            if r & 0x8000000000000000 != 0 { f |= SF; }
            if s < other { f |= CF; }
            if ((s ^ other) & (s ^ r) & 0x8000000000000000) != 0 { f |= OF; }
            if ((s ^ other ^ r) & 0x10) != 0 { f |= AF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }

        // ========== AND/OR/XOR (logical) — CF=0, OF=0, AF undefined ==========
        FlagOp::AndB | FlagOp::OrB | FlagOp::XorB => {
            let r = res as u8;
            if r == 0 { f |= ZF; }
            if r & 0x80 != 0 { f |= SF; }
            if PARITY_TABLE[r as usize] != 0 { f |= PF; }
            // CF=0, OF=0 (already cleared)
        }
        FlagOp::AndW | FlagOp::OrW | FlagOp::XorW => {
            let r = res as u16;
            if r == 0 { f |= ZF; }
            if r & 0x8000 != 0 { f |= SF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }
        FlagOp::AndL | FlagOp::OrL | FlagOp::XorL => {
            let r = res as u32;
            if r == 0 { f |= ZF; }
            if r & 0x80000000 != 0 { f |= SF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }
        FlagOp::AndQ | FlagOp::OrQ | FlagOp::XorQ => {
            if res == 0 { f |= ZF; }
            if res & 0x8000000000000000 != 0 { f |= SF; }
            if PARITY_TABLE[(res & 0xFF) as usize] != 0 { f |= PF; }
        }

        // ========== ADC (add with carry) ==========
        FlagOp::AdcB => {
            let r = res as u8;
            if r == 0 { f |= ZF; }
            if r & 0x80 != 0 { f |= SF; }
            // src holds the carry-in + original src value
            // CF = result < src (with carry consideration)
            if (res & 0xFF) <= (src & 0xFF) {
                if (res & 0xFF) < (src & 0xFF) || (src >> 8) & 1 != 0 {
                    f |= CF;
                }
            }
            if PARITY_TABLE[r as usize] != 0 { f |= PF; }
        }
        FlagOp::AdcW | FlagOp::AdcL | FlagOp::AdcQ => {
            // Simplified: treat like ADD for now
            let mask = match op {
                FlagOp::AdcW => 0xFFFFu64,
                FlagOp::AdcL => 0xFFFFFFFFu64,
                _ => !0u64,
            };
            let sign_bit = match op {
                FlagOp::AdcW => 0x8000u64,
                FlagOp::AdcL => 0x80000000u64,
                _ => 0x8000000000000000u64,
            };
            let r = res & mask;
            if r == 0 { f |= ZF; }
            if r & sign_bit != 0 { f |= SF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }

        // ========== SBB (subtract with borrow) ==========
        FlagOp::SbbB | FlagOp::SbbW | FlagOp::SbbL | FlagOp::SbbQ => {
            let mask = match op {
                FlagOp::SbbB => 0xFFu64,
                FlagOp::SbbW => 0xFFFFu64,
                FlagOp::SbbL => 0xFFFFFFFFu64,
                _ => !0u64,
            };
            let sign_bit = match op {
                FlagOp::SbbB => 0x80u64,
                FlagOp::SbbW => 0x8000u64,
                FlagOp::SbbL => 0x80000000u64,
                _ => 0x8000000000000000u64,
            };
            let r = res & mask;
            if r == 0 { f |= ZF; }
            if r & sign_bit != 0 { f |= SF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }

        // ========== SHL (shift left) — CF = last bit shifted out ==========
        FlagOp::ShlB | FlagOp::ShlW | FlagOp::ShlL | FlagOp::ShlQ => {
            let mask = match op {
                FlagOp::ShlB => 0xFFu64,
                FlagOp::ShlW => 0xFFFFu64,
                FlagOp::ShlL => 0xFFFFFFFFu64,
                _ => !0u64,
            };
            let sign_bit = match op {
                FlagOp::ShlB => 0x80u64,
                FlagOp::ShlW => 0x8000u64,
                FlagOp::ShlL => 0x80000000u64,
                _ => 0x8000000000000000u64,
            };
            let r = res & mask;
            if r == 0 { f |= ZF; }
            if r & sign_bit != 0 { f |= SF; }
            // CF = src contains the last shifted-out bit
            if src & 1 != 0 { f |= CF; }
            // OF = CF ^ MSB of result (for shift count of 1)
            if ((src ^ res) & sign_bit) != 0 { f |= OF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }

        // ========== SAR (shift arithmetic right) ==========
        FlagOp::SarB | FlagOp::SarW | FlagOp::SarL | FlagOp::SarQ => {
            let mask = match op {
                FlagOp::SarB => 0xFFu64,
                FlagOp::SarW => 0xFFFFu64,
                FlagOp::SarL => 0xFFFFFFFFu64,
                _ => !0u64,
            };
            let sign_bit = match op {
                FlagOp::SarB => 0x80u64,
                FlagOp::SarW => 0x8000u64,
                FlagOp::SarL => 0x80000000u64,
                _ => 0x8000000000000000u64,
            };
            let r = res & mask;
            if r == 0 { f |= ZF; }
            if r & sign_bit != 0 { f |= SF; }
            if src & 1 != 0 { f |= CF; }
            // OF = 0 for SAR
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }

        // ========== INC (like ADD but preserve CF) ==========
        FlagOp::IncB | FlagOp::IncW | FlagOp::IncL | FlagOp::IncQ => {
            let mask = match op {
                FlagOp::IncB => 0xFFu64,
                FlagOp::IncW => 0xFFFFu64,
                FlagOp::IncL => 0xFFFFFFFFu64,
                _ => !0u64,
            };
            let sign_bit = match op {
                FlagOp::IncB => 0x80u64,
                FlagOp::IncW => 0x8000u64,
                FlagOp::IncL => 0x80000000u64,
                _ => 0x8000000000000000u64,
            };
            let r = res & mask;
            // Preserve CF from before
            f |= cpu.rflags & CF;
            if r == 0 { f |= ZF; }
            if r & sign_bit != 0 { f |= SF; }
            // OF: 0x7F -> 0x80 (signed overflow)
            if res & mask == sign_bit { f |= OF; }
            if (res ^ src ^ 1) & 0x10 != 0 { f |= AF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }

        // ========== DEC (like SUB but preserve CF) ==========
        FlagOp::DecB | FlagOp::DecW | FlagOp::DecL | FlagOp::DecQ => {
            let mask = match op {
                FlagOp::DecB => 0xFFu64,
                FlagOp::DecW => 0xFFFFu64,
                FlagOp::DecL => 0xFFFFFFFFu64,
                _ => !0u64,
            };
            let sign_bit = match op {
                FlagOp::DecB => 0x80u64,
                FlagOp::DecW => 0x8000u64,
                FlagOp::DecL => 0x80000000u64,
                _ => 0x8000000000000000u64,
            };
            let r = res & mask;
            f |= cpu.rflags & CF; // preserve CF
            if r == 0 { f |= ZF; }
            if r & sign_bit != 0 { f |= SF; }
            // OF: 0x80 -> 0x7F (signed underflow)
            if src & mask == sign_bit { f |= OF; }
            if (res ^ src ^ 1) & 0x10 != 0 { f |= AF; }
            if PARITY_TABLE[(r & 0xFF) as usize] != 0 { f |= PF; }
        }

        // ========== Bit test ==========
        FlagOp::BtL | FlagOp::BtQ => {
            // src = bit value (0 or 1), stored as CF
            if src & 1 != 0 { f |= CF; }
        }

        FlagOp::External => { /* already handled above */ }
    }

    cpu.rflags = f;
    f
}

/// Evaluate a condition code (0-15) per x86 Jcc encoding.
/// Returns true if condition is met.
#[inline(always)]
pub fn eval_cc(cpu: &mut Cpu, cc: u8) -> bool {
    let f = materialize_flags(cpu);
    match cc & 0xF {
        0x0 => f & OF != 0,                          // O (overflow)
        0x1 => f & OF == 0,                          // NO
        0x2 => f & CF != 0,                          // B/NAE/C (below)
        0x3 => f & CF == 0,                          // NB/AE/NC (not below)
        0x4 => f & ZF != 0,                          // Z/E (zero)
        0x5 => f & ZF == 0,                          // NZ/NE (not zero)
        0x6 => (f & CF != 0) || (f & ZF != 0),      // BE/NA (below or equal)
        0x7 => (f & CF == 0) && (f & ZF == 0),      // NBE/A (above)
        0x8 => f & SF != 0,                          // S (sign)
        0x9 => f & SF == 0,                          // NS (not sign)
        0xA => f & PF != 0,                          // P/PE (parity)
        0xB => f & PF == 0,                          // NP/PO (not parity)
        0xC => (f & SF != 0) != (f & OF != 0),      // L/NGE (less)
        0xD => (f & SF != 0) == (f & OF != 0),      // NL/GE (not less)
        0xE => (f & ZF != 0) || ((f & SF != 0) != (f & OF != 0)),  // LE/NG
        0xF => (f & ZF == 0) && ((f & SF != 0) == (f & OF != 0)),  // NLE/G
        _ => false,
    }
}

/// Get the current CF value (without full materialization when possible).
#[inline(always)]
pub fn get_cf(cpu: &mut Cpu) -> bool {
    materialize_flags(cpu) & CF != 0
}
