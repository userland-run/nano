// THE monolithic CPU interpreter — single function, dense match → br_table.
// This is the performance-critical core of the emulator.

use crate::types::*;
use crate::mem;
use crate::flags;
use crate::flags::{set_lazy, eval_cc, materialize_flags};

/// Operand size lanes for the 769-entry dispatch table.
const LANE16: u32 = 0;
const LANE32: u32 = 256;
const LANE64: u32 = 512;

/// Try-or-fault: unwrap a Result, or handle the memory fault and continue the main loop.
macro_rules! try_or_fault {
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
                continue;
            }
        }
    };
}

/// The monolithic CPU execution loop.
/// Executes instructions until budget is exhausted or an exception/halt occurs.
/// Returns remaining budget.
pub unsafe fn exec(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, mut budget: i32) -> i32 {
    loop {
        if budget <= 0 {
            return budget;
        }

        // Check for pending hardware interrupts (from PIC)
        if !cpu.inhibit_irq && (cpu.rflags & IF != 0) {
            if let Some(vector) = crate::pic::get_pending_irq(cpu) {
                crate::pic::ack_irq(cpu, vector);
                cpu.irq_pending = false;
                deliver_interrupt(cpu, ram, ram_size, vector as u32, false, 0);
            }
        }

        if cpu.halted {
            return 0; // Stay halted until interrupt
        }

        cpu.inhibit_irq = false;
        budget -= 1;

        // Save instruction start for fault recovery
        cpu.instr_start_rip = cpu.rip;

        // === Prefix decoding loop ===
        cpu.prefix = PrefixState::new();
        let mut rip = cpu.rip;

        // Decode prefixes
        loop {
            let b = match mem::fetch_u8(cpu, ram, ram_size, rip) {
                Ok(v) => v,
                Err(_) => { raise_exception(cpu, EXC_PF, 0); break; }
            };
            rip += 1;

            match b {
                // REX prefixes (0x40-0x4F) — only in 64-bit mode
                0x40..=0x4F if cpu.long_mode => {
                    cpu.prefix.rex = b;
                    continue;
                }
                // Segment overrides
                0x26 => { cpu.prefix.seg_override = SEG_ES as i8; continue; }
                0x2E => { cpu.prefix.seg_override = SEG_CS as i8; continue; }
                0x36 => { cpu.prefix.seg_override = SEG_SS as i8; continue; }
                0x3E => { cpu.prefix.seg_override = SEG_DS as i8; continue; }
                0x64 => { cpu.prefix.seg_override = SEG_FS as i8; continue; }
                0x65 => { cpu.prefix.seg_override = SEG_GS as i8; continue; }
                // Operand size override
                0x66 => { cpu.prefix.op_size = true; continue; }
                // Address size override
                0x67 => { cpu.prefix.addr_size = true; continue; }
                // LOCK
                0xF0 => { cpu.prefix.lock = true; continue; }
                // REPNE/REPNZ
                0xF2 => { cpu.prefix.rep = 0xF2; continue; }
                // REP/REPE/REPZ
                0xF3 => { cpu.prefix.rep = 0xF3; continue; }
                _ => {
                    // Not a prefix — this is the opcode
                    rip -= 1; // back up, we'll re-read below
                    break;
                }
            }
        }

        // Fetch the opcode byte
        let opcode = match mem::fetch_u8(cpu, ram, ram_size, rip) {
            Ok(v) => v,
            Err(_) => { raise_exception(cpu, EXC_PF, 0); continue; }
        };
        rip += 1;
        cpu.rip = rip;

        // Determine operand size lane
        let rex_w = cpu.prefix.rex & 0x08 != 0;
        let lane = if cpu.long_mode {
            if rex_w { LANE64 }
            else if cpu.prefix.op_size { LANE16 }
            else { LANE32 }
        } else {
            if cpu.prefix.op_size { LANE16 }
            else { LANE32 }
        };

        let idx = opcode as u32 + lane;

        // === Main dispatch ===
        match idx {
            // ============================================================
            // NOP (0x90)
            // ============================================================
            0x90 | 0x190 | 0x290 => {
                // NOP — do nothing (also XCHG EAX,EAX in 32-bit which is NOP)
            }

            // ============================================================
            // MOV r8, imm8 (0xB0-0xB7)
            // ============================================================
            0xB0 | 0x1B0 | 0x2B0 | 0xB1 | 0x1B1 | 0x2B1 | 0xB2 | 0x1B2 | 0x2B2 | 0xB3 | 0x1B3 | 0x2B3 | 0xB4 | 0x1B4 | 0x2B4 | 0xB5 | 0x1B5 | 0x2B5 | 0xB6 | 0x1B6 | 0x2B6 | 0xB7 | 0x1B7 | 0x2B7 => {
                let reg = ((opcode - 0xB0) & 7) as usize;
                let reg = if cpu.prefix.rex != 0 {
                    reg | ((cpu.prefix.rex as usize & 1) << 3)
                } else { reg };
                let imm = match mem::fetch_u8(cpu, ram, ram_size, cpu.rip) {
                    Ok(v) => v,
                    Err(_) => { raise_exception(cpu, EXC_PF, 0); continue; }
                };
                cpu.rip += 1;
                write_reg8(cpu, reg, imm);
            }

            // ============================================================
            // MOV r16/32/64, imm (0xB8-0xBF)
            // ============================================================
            0xB8 | 0x1B8 | 0x2B8 | 0xB9 | 0x1B9 | 0x2B9 | 0xBA | 0x1BA | 0x2BA | 0xBB | 0x1BB | 0x2BB | 0xBC | 0x1BC | 0x2BC | 0xBD | 0x1BD | 0x2BD | 0xBE | 0x1BE | 0x2BE | 0xBF | 0x1BF | 0x2BF => {
                let reg = ((opcode - 0xB8) & 7) as usize;
                let reg = reg | ((cpu.prefix.rex as usize & 1) << 3);
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size));
                        write_reg16(cpu, reg, imm);
                    }
                    LANE32 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size));
                        cpu.regs[reg] = imm as u64; // zero-extended
                    }
                    LANE64 => {
                        // MOV r64, imm64 — full 64-bit immediate
                        let imm = try_or_fault!(cpu, fetch_imm64(cpu, ram, ram_size));
                        cpu.regs[reg] = imm;
                    }
                    _ => {}
                }
            }

            // ============================================================
            // ADD AL, imm8 (0x04)
            // ============================================================
            0x04 | 0x104 | 0x204 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let lhs = cpu.regs[RAX] as u8;
                let res = lhs.wrapping_add(imm);
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::AddB, lhs as u64, res as u64);
            }

            // ============================================================
            // ADD rAX, imm16/32 (0x05)
            // ============================================================
            0x05 | 0x105 | 0x205 => {
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size));
                        let lhs = cpu.regs[RAX] as u16;
                        let res = lhs.wrapping_add(imm);
                        write_reg16(cpu, RAX, res);
                        set_lazy(cpu, FlagOp::AddW, lhs as u64, res as u64);
                    }
                    LANE32 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size));
                        let lhs = cpu.regs[RAX] as u32;
                        let res = lhs.wrapping_add(imm);
                        cpu.regs[RAX] = res as u64;
                        set_lazy(cpu, FlagOp::AddL, lhs as u64, res as u64);
                    }
                    LANE64 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as u64;
                        let lhs = cpu.regs[RAX];
                        let res = lhs.wrapping_add(imm);
                        cpu.regs[RAX] = res;
                        set_lazy(cpu, FlagOp::AddQ, lhs, res);
                    }
                    _ => {}
                }
            }

            // ============================================================
            // SUB AL, imm8 (0x2C)
            // ============================================================
            0x2C | 0x12C | 0x22C => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let lhs = cpu.regs[RAX] as u8;
                let res = lhs.wrapping_sub(imm);
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::SubB, lhs as u64, res as u64);
            }

            // ============================================================
            // SUB rAX, imm (0x2D)
            // ============================================================
            0x2D | 0x12D | 0x22D => {
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size));
                        let lhs = cpu.regs[RAX] as u16;
                        let res = lhs.wrapping_sub(imm);
                        write_reg16(cpu, RAX, res);
                        set_lazy(cpu, FlagOp::SubW, lhs as u64, res as u64);
                    }
                    LANE32 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size));
                        let lhs = cpu.regs[RAX] as u32;
                        let res = lhs.wrapping_sub(imm);
                        cpu.regs[RAX] = res as u64;
                        set_lazy(cpu, FlagOp::SubL, lhs as u64, res as u64);
                    }
                    LANE64 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as u64;
                        let lhs = cpu.regs[RAX];
                        let res = lhs.wrapping_sub(imm);
                        cpu.regs[RAX] = res;
                        set_lazy(cpu, FlagOp::SubQ, lhs, res);
                    }
                    _ => {}
                }
            }

            // ============================================================
            // CMP AL, imm8 (0x3C)
            // ============================================================
            0x3C | 0x13C | 0x23C => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let lhs = cpu.regs[RAX] as u8;
                let res = lhs.wrapping_sub(imm);
                set_lazy(cpu, FlagOp::SubB, lhs as u64, res as u64);
            }

            // ============================================================
            // CMP rAX, imm (0x3D)
            // ============================================================
            0x3D | 0x13D | 0x23D => {
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size));
                        let lhs = cpu.regs[RAX] as u16;
                        let res = lhs.wrapping_sub(imm);
                        set_lazy(cpu, FlagOp::SubW, lhs as u64, res as u64);
                    }
                    LANE32 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size));
                        let lhs = cpu.regs[RAX] as u32;
                        let res = lhs.wrapping_sub(imm);
                        set_lazy(cpu, FlagOp::SubL, lhs as u64, res as u64);
                    }
                    LANE64 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as u64;
                        let lhs = cpu.regs[RAX];
                        let res = lhs.wrapping_sub(imm);
                        set_lazy(cpu, FlagOp::SubQ, lhs, res);
                    }
                    _ => {}
                }
            }

            // ============================================================
            // AND AL, imm8 (0x24)
            // ============================================================
            0x24 | 0x124 | 0x224 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let res = (cpu.regs[RAX] as u8) & imm;
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::AndB, 0, res as u64);
            }

            // ============================================================
            // OR AL, imm8 (0x0C)
            // ============================================================
            0x0C | 0x10C | 0x20C => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let res = (cpu.regs[RAX] as u8) | imm;
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::OrB, 0, res as u64);
            }

            // ============================================================
            // XOR AL, imm8 (0x34)
            // ============================================================
            0x34 | 0x134 | 0x234 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let res = (cpu.regs[RAX] as u8) ^ imm;
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::XorB, 0, res as u64);
            }

            // ============================================================
            // TEST AL, imm8 (0xA8)
            // ============================================================
            0xA8 | 0x1A8 | 0x2A8 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let res = (cpu.regs[RAX] as u8) & imm;
                set_lazy(cpu, FlagOp::AndB, 0, res as u64);
            }

            // ============================================================
            // PUSH r16/32/64 (0x50-0x57)
            // ============================================================
            0x50 | 0x150 | 0x250 | 0x51 | 0x151 | 0x251 | 0x52 | 0x152 | 0x252 | 0x53 | 0x153 | 0x253 | 0x54 | 0x154 | 0x254 | 0x55 | 0x155 | 0x255 | 0x56 | 0x156 | 0x256 | 0x57 | 0x157 | 0x257 => {
                let reg = ((opcode - 0x50) & 7) as usize
                    | ((cpu.prefix.rex as usize & 1) << 3);
                let val = cpu.regs[reg];
                if cpu.long_mode {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                    try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], val));
                } else {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                    try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], val as u32));
                }
            }

            // ============================================================
            // POP r16/32/64 (0x58-0x5F)
            // ============================================================
            0x58 | 0x158 | 0x258 | 0x59 | 0x159 | 0x259 | 0x5A | 0x15A | 0x25A | 0x5B | 0x15B | 0x25B | 0x5C | 0x15C | 0x25C | 0x5D | 0x15D | 0x25D | 0x5E | 0x15E | 0x25E | 0x5F | 0x15F | 0x25F => {
                let reg = ((opcode - 0x58) & 7) as usize
                    | ((cpu.prefix.rex as usize & 1) << 3);
                if cpu.long_mode {
                    let val = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(8);
                    cpu.regs[reg] = val;
                } else {
                    let val = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(4);
                    cpu.regs[reg] = val as u64;
                }
            }

            // ============================================================
            // CALL rel32 (0xE8)
            // ============================================================
            0xE8 | 0x1E8 | 0x2E8 => {
                let rel = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32;
                let ret_addr = cpu.rip;
                if cpu.long_mode {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                    try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], ret_addr));
                    cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                } else {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                    try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], ret_addr as u32));
                    cpu.rip = (cpu.rip.wrapping_add(rel as i64 as u64)) & 0xFFFFFFFF;
                }
            }

            // ============================================================
            // RET near (0xC3)
            // ============================================================
            0xC3 | 0x1C3 | 0x2C3 => {
                if cpu.long_mode {
                    let addr = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(8);
                    cpu.rip = addr;
                } else {
                    let addr = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(4);
                    cpu.rip = addr as u64;
                }
            }

            // ============================================================
            // JMP rel8 (0xEB)
            // ============================================================
            0xEB | 0x1EB | 0x2EB => {
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
            }

            // ============================================================
            // JMP rel32 (0xE9)
            // ============================================================
            0xE9 | 0x1E9 | 0x2E9 => {
                let rel = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32;
                cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                if !cpu.long_mode {
                    cpu.rip &= 0xFFFFFFFF;
                }
            }

            // ============================================================
            // Jcc rel8 (0x70-0x7F)
            // ============================================================
            0x70 | 0x170 | 0x270 | 0x71 | 0x171 | 0x271 | 0x72 | 0x172 | 0x272 | 0x73 | 0x173 | 0x273 | 0x74 | 0x174 | 0x274 | 0x75 | 0x175 | 0x275 | 0x76 | 0x176 | 0x276 | 0x77 | 0x177 | 0x277 | 0x78 | 0x178 | 0x278 | 0x79 | 0x179 | 0x279 | 0x7A | 0x17A | 0x27A | 0x7B | 0x17B | 0x27B | 0x7C | 0x17C | 0x27C | 0x7D | 0x17D | 0x27D | 0x7E | 0x17E | 0x27E | 0x7F | 0x17F | 0x27F => {
                let cc = (opcode & 0x0F) as u8;
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                if eval_cc(cpu, cc) {
                    cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                }
            }

            // ============================================================
            // LEA r, m (0x8D) — load effective address
            // ============================================================
            0x8D | 0x18D | 0x28D => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let reg = ((modrm >> 3) & 7) as usize
                    | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                match lane {
                    LANE16 => write_reg16(cpu, reg, addr as u16),
                    LANE32 => cpu.regs[reg] = addr as u32 as u64,
                    LANE64 => cpu.regs[reg] = addr,
                    _ => {}
                }
            }

            // ============================================================
            // MOV r/m8, r8 (0x88)
            // ============================================================
            0x88 | 0x188 | 0x288 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let src_reg = ((modrm >> 3) & 7) as usize
                    | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let val = read_reg8(cpu, src_reg);
                if modrm & 0xC0 == 0xC0 {
                    let dst_reg = (modrm & 7) as usize
                        | ((cpu.prefix.rex as usize & 1) << 3);
                    write_reg8(cpu, dst_reg, val);
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, val));
                }
            }

            // ============================================================
            // MOV r/m16/32/64, r (0x89)
            // ============================================================
            0x89 | 0x189 | 0x289 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let src_reg = ((modrm >> 3) & 7) as usize
                    | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let val = cpu.regs[src_reg];
                if modrm & 0xC0 == 0xC0 {
                    let dst_reg = (modrm & 7) as usize
                        | ((cpu.prefix.rex as usize & 1) << 3);
                    match lane {
                        LANE16 => write_reg16(cpu, dst_reg, val as u16),
                        LANE32 => cpu.regs[dst_reg] = val as u32 as u64,
                        LANE64 => cpu.regs[dst_reg] = val,
                        _ => {}
                    }
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    match lane {
                        LANE16 => try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, val as u16)),
                        LANE32 => try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, val as u32)),
                        LANE64 => try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, val)),
                        _ => {}
                    }
                }
            }

            // ============================================================
            // MOV r8, r/m8 (0x8A)
            // ============================================================
            0x8A | 0x18A | 0x28A => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let dst_reg = ((modrm >> 3) & 7) as usize
                    | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let val = if modrm & 0xC0 == 0xC0 {
                    let src_reg = (modrm & 7) as usize
                        | ((cpu.prefix.rex as usize & 1) << 3);
                    read_reg8(cpu, src_reg)
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr))
                };
                write_reg8(cpu, dst_reg, val);
            }

            // ============================================================
            // MOV r16/32/64, r/m (0x8B)
            // ============================================================
            0x8B | 0x18B | 0x28B => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let dst_reg = ((modrm >> 3) & 7) as usize
                    | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                if modrm & 0xC0 == 0xC0 {
                    let src_reg = (modrm & 7) as usize
                        | ((cpu.prefix.rex as usize & 1) << 3);
                    match lane {
                        LANE16 => write_reg16(cpu, dst_reg, cpu.regs[src_reg] as u16),
                        LANE32 => cpu.regs[dst_reg] = cpu.regs[src_reg] as u32 as u64,
                        LANE64 => cpu.regs[dst_reg] = cpu.regs[src_reg],
                        _ => {}
                    }
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    match lane {
                        LANE16 => {
                            let v = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr));
                            write_reg16(cpu, dst_reg, v);
                        }
                        LANE32 => {
                            let v = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr));
                            cpu.regs[dst_reg] = v as u64;
                        }
                        LANE64 => {
                            let v = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                            cpu.regs[dst_reg] = v;
                        }
                        _ => {}
                    }
                }
            }

            // ============================================================
            // MOV r/m, imm8 (0xC6) — GRP11
            // ============================================================
            0xC6 | 0x1C6 | 0x2C6 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                // reg field must be 0 for MOV
                if modrm & 0xC0 == 0xC0 {
                    let dst_reg = (modrm & 7) as usize
                        | ((cpu.prefix.rex as usize & 1) << 3);
                    let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                    write_reg8(cpu, dst_reg, imm);
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                    try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, imm));
                }
            }

            // ============================================================
            // MOV r/m, imm16/32/64 (0xC7) — GRP11
            // ============================================================
            0xC7 | 0x1C7 | 0x2C7 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                if modrm & 0xC0 == 0xC0 {
                    let dst_reg = (modrm & 7) as usize
                        | ((cpu.prefix.rex as usize & 1) << 3);
                    match lane {
                        LANE16 => {
                            let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size));
                            write_reg16(cpu, dst_reg, imm);
                        }
                        LANE32 => {
                            let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size));
                            cpu.regs[dst_reg] = imm as u64;
                        }
                        LANE64 => {
                            let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as u64;
                            cpu.regs[dst_reg] = imm;
                        }
                        _ => {}
                    }
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    match lane {
                        LANE16 => {
                            let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size));
                            try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, imm));
                        }
                        LANE32 => {
                            let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size));
                            try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, imm));
                        }
                        LANE64 => {
                            let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as u32;
                            try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, imm as i32 as u64));
                        }
                        _ => {}
                    }
                }
            }

            // ============================================================
            // XCHG rAX, r (0x91-0x97 — 0x90 is NOP)
            // ============================================================
            0x91 | 0x191 | 0x291 | 0x92 | 0x192 | 0x292 | 0x93 | 0x193 | 0x293 | 0x94 | 0x194 | 0x294 | 0x95 | 0x195 | 0x295 | 0x96 | 0x196 | 0x296 | 0x97 | 0x197 | 0x297 => {
                let reg = ((opcode - 0x90) & 7) as usize
                    | ((cpu.prefix.rex as usize & 1) << 3);
                let tmp = cpu.regs[RAX];
                match lane {
                    LANE16 => {
                        write_reg16(cpu, RAX, cpu.regs[reg] as u16);
                        write_reg16(cpu, reg, tmp as u16);
                    }
                    LANE32 => {
                        cpu.regs[RAX] = cpu.regs[reg] as u32 as u64;
                        cpu.regs[reg] = tmp as u32 as u64;
                    }
                    LANE64 => {
                        cpu.regs[RAX] = cpu.regs[reg];
                        cpu.regs[reg] = tmp;
                    }
                    _ => {}
                }
            }

            // ============================================================
            // CLC (0xF8), STC (0xF9), CMC (0xF5)
            // ============================================================
            0xF8 | 0x1F8 | 0x2F8 => {
                materialize_flags(cpu);
                cpu.rflags &= !CF;
                cpu.lazy.op = FlagOp::External;
            }
            0xF9 | 0x1F9 | 0x2F9 => {
                materialize_flags(cpu);
                cpu.rflags |= CF;
                cpu.lazy.op = FlagOp::External;
            }
            0xF5 | 0x1F5 | 0x2F5 => {
                materialize_flags(cpu);
                cpu.rflags ^= CF;
                cpu.lazy.op = FlagOp::External;
            }

            // ============================================================
            // CLD (0xFC), STD (0xFD)
            // ============================================================
            0xFC | 0x1FC | 0x2FC => { cpu.rflags &= !DF; }
            0xFD | 0x1FD | 0x2FD => { cpu.rflags |= DF; }

            // ============================================================
            // CLI (0xFA), STI (0xFB)
            // ============================================================
            0xFA | 0x1FA | 0x2FA => { cpu.rflags &= !IF; }
            0xFB | 0x1FB | 0x2FB => {
                cpu.rflags |= IF;
                cpu.inhibit_irq = true; // delay interrupt by one instruction
            }

            // ============================================================
            // HLT (0xF4)
            // ============================================================
            0xF4 | 0x1F4 | 0x2F4 => {
                if cpu.cpl != 0 {
                    raise_exception(cpu, EXC_GP, 0);
                } else {
                    cpu.halted = true;
                    return budget;
                }
            }

            // ============================================================
            // CPUID (0x0F 0xA2) — handle via two-byte opcode
            // Two-byte opcodes start with 0x0F
            // ============================================================
            0x0F | 0x10F | 0x20F => {
                let op2 = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                match op2 {
                    // Jcc rel32 (0x0F 0x80-0x8F)
                    0x80..=0x8F => {
                        let cc = (op2 & 0x0F) as u8;
                        let rel = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32;
                        if eval_cc(cpu, cc) {
                            cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                            if !cpu.long_mode {
                                cpu.rip &= 0xFFFFFFFF;
                            }
                        }
                    }
                    // SETcc r/m8 (0x0F 0x90-0x9F)
                    0x90..=0x9F => {
                        let cc = (op2 & 0x0F) as u8;
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let val = if eval_cc(cpu, cc) { 1u8 } else { 0u8 };
                        if modrm & 0xC0 == 0xC0 {
                            let reg = (modrm & 7) as usize
                                | ((cpu.prefix.rex as usize & 1) << 3);
                            write_reg8(cpu, reg, val);
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, val));
                        }
                    }
                    // CMOVcc (0x0F 0x40-0x4F)
                    0x40..=0x4F => {
                        let cc = (op2 & 0x0F) as u8;
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize
                            | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src_val = if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize
                                | ((cpu.prefix.rex as usize & 1) << 3);
                            cpu.regs[r]
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            match lane {
                                LANE16 => try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr)) as u64,
                                LANE32 => try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr)) as u64,
                                _ => try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr)),
                            }
                        };
                        if eval_cc(cpu, cc) {
                            match lane {
                                LANE16 => write_reg16(cpu, dst_reg, src_val as u16),
                                LANE32 => cpu.regs[dst_reg] = src_val as u32 as u64,
                                LANE64 => cpu.regs[dst_reg] = src_val,
                                _ => {}
                            }
                        }
                    }
                    // MOVZX r, r/m8 (0x0F 0xB6)
                    0xB6 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize
                            | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let val = if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize
                                | ((cpu.prefix.rex as usize & 1) << 3);
                            read_reg8(cpu, r)
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr))
                        };
                        match lane {
                            LANE16 => write_reg16(cpu, dst_reg, val as u16),
                            _ => cpu.regs[dst_reg] = val as u64,
                        }
                    }
                    // MOVZX r, r/m16 (0x0F 0xB7)
                    0xB7 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize
                            | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let val = if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize
                                | ((cpu.prefix.rex as usize & 1) << 3);
                            cpu.regs[r] as u16
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr))
                        };
                        match lane {
                            LANE16 => write_reg16(cpu, dst_reg, val),
                            _ => cpu.regs[dst_reg] = val as u64,
                        }
                    }
                    // MOVSX r, r/m8 (0x0F 0xBE)
                    0xBE => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize
                            | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let val = if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize
                                | ((cpu.prefix.rex as usize & 1) << 3);
                            read_reg8(cpu, r)
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr))
                        };
                        match lane {
                            LANE16 => write_reg16(cpu, dst_reg, val as i8 as u16),
                            LANE32 => cpu.regs[dst_reg] = val as i8 as i32 as u32 as u64,
                            LANE64 => cpu.regs[dst_reg] = val as i8 as i64 as u64,
                            _ => {}
                        }
                    }
                    // MOVSX r, r/m16 (0x0F 0xBF)
                    0xBF => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize
                            | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let val = if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize
                                | ((cpu.prefix.rex as usize & 1) << 3);
                            cpu.regs[r] as u16
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr))
                        };
                        match lane {
                            LANE16 => write_reg16(cpu, dst_reg, val),
                            LANE32 => cpu.regs[dst_reg] = val as i16 as i32 as u32 as u64,
                            LANE64 => cpu.regs[dst_reg] = val as i16 as i64 as u64,
                            _ => {}
                        }
                    }
                    // CPUID (0x0F 0xA2)
                    0xA2 => {
                        handle_cpuid(cpu);
                    }
                    // RDTSC (0x0F 0x31)
                    0x31 => {
                        let tsc = cpu.tsc;
                        cpu.regs[RAX] = tsc & 0xFFFFFFFF;
                        cpu.regs[RDX] = (tsc >> 32) & 0xFFFFFFFF;
                        cpu.tsc += 100; // approximate increment
                    }
                    // WRMSR (0x0F 0x30)
                    0x30 => {
                        if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                        let ecx = cpu.regs[RCX] as u32;
                        let val = (cpu.regs[RDX] << 32) | (cpu.regs[RAX] & 0xFFFFFFFF);
                        handle_wrmsr(cpu, ecx, val);
                    }
                    // RDMSR (0x0F 0x32)
                    0x32 => {
                        if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                        let ecx = cpu.regs[RCX] as u32;
                        let val = handle_rdmsr(cpu, ecx);
                        cpu.regs[RAX] = val & 0xFFFFFFFF;
                        cpu.regs[RDX] = (val >> 32) & 0xFFFFFFFF;
                    }
                    // SLDT/STR/LLDT/LTR (0x0F 0x00 /0-3)
                    0x00 => {
                        if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let reg_field = (modrm >> 3) & 7;
                        match reg_field {
                            0 => {
                                // SLDT — store LDT selector
                                let val = cpu.ldt.selector;
                                if modrm & 0xC0 == 0xC0 {
                                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                    cpu.regs[r] = val as u64;
                                } else {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, val));
                                }
                            }
                            1 => {
                                // STR — store task register selector
                                let val = cpu.tr.selector;
                                if modrm & 0xC0 == 0xC0 {
                                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                    cpu.regs[r] = val as u64;
                                } else {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, val));
                                }
                            }
                            2 => {
                                // LLDT — load LDT from selector
                                let sel = if modrm & 0xC0 == 0xC0 {
                                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                    cpu.regs[r] as u16
                                } else {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr))
                                };
                                cpu.ldt.selector = sel;
                                // Load LDT descriptor from GDT (simplified: just set base/limit from GDT entry)
                                if sel != 0 {
                                    let desc_addr = cpu.gdt.base + (sel as u64 & 0xFFF8);
                                    let lo = read_phys_u32(ram, ram_size, desc_addr);
                                    let hi = read_phys_u32(ram, ram_size, desc_addr + 4);
                                    let base = ((lo >> 16) as u64 & 0xFFFF) | (((hi & 0xFF) as u64) << 16) | (((hi >> 24) as u64) << 24);
                                    let limit = (lo & 0xFFFF) as u32 | ((hi & 0xF0000) as u32);
                                    if cpu.long_mode {
                                        let base_hi = read_phys_u32(ram, ram_size, desc_addr + 8);
                                        cpu.ldt.base = base | ((base_hi as u64) << 32);
                                    } else {
                                        cpu.ldt.base = base;
                                    }
                                    cpu.ldt.limit = limit;
                                }
                            }
                            3 => {
                                // LTR — load task register from selector
                                let sel = if modrm & 0xC0 == 0xC0 {
                                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                    cpu.regs[r] as u16
                                } else {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr))
                                };
                                cpu.tr.selector = sel;
                                // Load TSS descriptor from GDT
                                let desc_addr = cpu.gdt.base + (sel as u64 & 0xFFF8);
                                let lo = read_phys_u32(ram, ram_size, desc_addr);
                                let hi = read_phys_u32(ram, ram_size, desc_addr + 4);
                                let base = ((lo >> 16) as u64 & 0xFFFF) | (((hi & 0xFF) as u64) << 16) | (((hi >> 24) as u64) << 24);
                                let limit = (lo & 0xFFFF) as u32 | ((hi & 0xF0000) as u32);
                                cpu.tr.flags = hi & 0x00F0FF00;
                                if cpu.long_mode {
                                    // 64-bit TSS descriptor is 16 bytes
                                    let base_hi = read_phys_u32(ram, ram_size, desc_addr + 8);
                                    cpu.tr.base = base | ((base_hi as u64) << 32);
                                } else {
                                    cpu.tr.base = base;
                                }
                                cpu.tr.limit = limit;
                                // Mark TSS as busy (set bit 1 of type field in GDT)
                                let busy = hi | 0x200;
                                write_phys_u32(ram, ram_size, desc_addr + 4, busy);
                            }
                            _ => {}
                        }
                    }
                    // System instructions (0x0F 0x01)
                    0x01 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let reg_field = (modrm >> 3) & 7;
                        match reg_field {
                            0 => {
                                // SGDT
                                if modrm & 0xC0 != 0xC0 {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, cpu.gdt.limit));
                                    if cpu.long_mode {
                                        try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr + 2, cpu.gdt.base));
                                    } else {
                                        try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr + 2, cpu.gdt.base as u32));
                                    }
                                }
                            }
                            1 => {
                                // SIDT
                                if modrm & 0xC0 != 0xC0 {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, cpu.idt.limit));
                                    if cpu.long_mode {
                                        try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr + 2, cpu.idt.base));
                                    } else {
                                        try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr + 2, cpu.idt.base as u32));
                                    }
                                }
                            }
                            2 => {
                                // LGDT
                                if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                                if modrm & 0xC0 != 0xC0 {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    let limit = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr));
                                    let base = if cpu.long_mode {
                                        try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr + 2))
                                    } else {
                                        try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr + 2)) as u64
                                    };
                                    cpu.gdt.limit = limit;
                                    cpu.gdt.base = base;
                                }
                            }
                            3 => {
                                // LIDT
                                if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                                if modrm & 0xC0 != 0xC0 {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    let limit = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr));
                                    let base = if cpu.long_mode {
                                        try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr + 2))
                                    } else {
                                        try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr + 2)) as u64
                                    };
                                    cpu.idt.limit = limit;
                                    cpu.idt.base = base;
                                }
                            }
                            4 => {
                                // SMSW — store machine status word (CR0 low 16 bits)
                                let val = cpu.cr0 as u16;
                                if modrm & 0xC0 == 0xC0 {
                                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                    cpu.regs[r] = val as u64;
                                } else {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, val));
                                }
                            }
                            6 => {
                                // LMSW — load machine status word (set low bits of CR0)
                                if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                                let val = if modrm & 0xC0 == 0xC0 {
                                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                    cpu.regs[r] as u16
                                } else {
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr))
                                };
                                // LMSW can set PE but cannot clear it
                                cpu.cr0 = (cpu.cr0 & !0xF) | (val as u64 & 0xF) | (cpu.cr0 & CR0_PE);
                            }
                            7 => {
                                if modrm == 0xF8 {
                                    // SWAPGS (0x0F 0x01 0xF8)
                                    if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                                    let tmp = cpu.segs[SEG_GS].base;
                                    cpu.segs[SEG_GS].base = cpu.kernel_gs_base;
                                    cpu.kernel_gs_base = tmp;
                                } else if modrm & 0xC0 != 0xC0 {
                                    // INVLPG m
                                    if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                    cpu.tlb.flush_page(addr);
                                }
                            }
                            _ => {}
                        }
                    }
                    // SYSCALL (0x0F 0x05)
                    0x05 => {
                        if cpu.cpl != 3 { raise_exception(cpu, EXC_UD, 0); continue; }
                        // Save user RIP and RFLAGS
                        cpu.regs[RCX] = cpu.rip;
                        cpu.regs[R11] = cpu.rflags;
                        // Load kernel entry point
                        cpu.rip = cpu.lstar;
                        // Mask flags
                        cpu.rflags &= !cpu.fmask;
                        cpu.rflags &= !(IF | TF | RF); // always clear these
                        cpu.lazy.op = FlagOp::External;
                        // Switch to kernel mode
                        cpu.cpl = 0;
                        // Set CS/SS from STAR
                        cpu.segs[SEG_CS].selector = ((cpu.star >> 32) & 0xFFFF) as u16;
                        cpu.segs[SEG_CS].base = 0;
                        cpu.segs[SEG_CS].limit = 0xFFFFFFFF;
                        cpu.segs[SEG_CS].flags = 0x00AF9B00; // 64-bit code
                        cpu.segs[SEG_SS].selector = (((cpu.star >> 32) + 8) & 0xFFFF) as u16;
                        cpu.segs[SEG_SS].base = 0;
                        cpu.segs[SEG_SS].limit = 0xFFFFFFFF;
                        cpu.segs[SEG_SS].flags = 0x00CF9300; // data
                    }
                    // SYSRET (0x0F 0x07)
                    0x07 => {
                        if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                        cpu.rip = cpu.regs[RCX];
                        cpu.rflags = cpu.regs[R11] | 0x2; // restore RFLAGS, ensure bit 1
                        cpu.lazy.op = FlagOp::External;
                        cpu.cpl = 3;
                        // Set CS/SS from STAR for user mode
                        cpu.segs[SEG_CS].selector = (((cpu.star >> 48) + 16) & 0xFFFF) as u16;
                        cpu.segs[SEG_CS].base = 0;
                        cpu.segs[SEG_CS].limit = 0xFFFFFFFF;
                        cpu.segs[SEG_CS].flags = 0x00AFFB00; // 64-bit code, DPL 3
                        cpu.segs[SEG_SS].selector = (((cpu.star >> 48) + 8) & 0xFFFF) as u16;
                        cpu.segs[SEG_SS].base = 0;
                        cpu.segs[SEG_SS].limit = 0xFFFFFFFF;
                        cpu.segs[SEG_SS].flags = 0x00CFF300; // data, DPL 3
                    }
                    // WBINVD (0x0F 0x09)
                    0x09 => { /* no-op cache flush */ }
                    // UD2 (0x0F 0x0B)
                    0x0B => {
                        raise_exception(cpu, EXC_UD, 0);
                    }
                    // MOV r, CRn (0x0F 0x20)
                    0x20 => {
                        if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let cr = ((modrm >> 3) & 7) as usize;
                        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        cpu.regs[r] = match cr {
                            0 => cpu.cr0,
                            2 => cpu.cr2,
                            3 => cpu.cr3,
                            4 => cpu.cr4,
                            8 => cpu.cr8,
                            _ => 0,
                        };
                    }
                    // MOV CRn, r (0x0F 0x22)
                    0x22 => {
                        if cpu.cpl != 0 { raise_exception(cpu, EXC_GP, 0); continue; }
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let cr = ((modrm >> 3) & 7) as usize;
                        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        let val = cpu.regs[r];
                        match cr {
                            0 => {
                                cpu.cr0 = val;
                                // Update long_mode based on EFER.LMA
                                cpu.long_mode = (cpu.efer & EFER_LME != 0) && (val & CR0_PG != 0);
                                if cpu.long_mode { cpu.efer |= EFER_LMA; } else { cpu.efer &= !EFER_LMA; }
                                cpu.tlb.flush_all();
                            }
                            2 => cpu.cr2 = val,
                            3 => {
                                cpu.cr3 = val;
                                cpu.tlb.flush_all();
                            }
                            4 => {
                                cpu.cr4 = val;
                                cpu.tlb.flush_all();
                            }
                            8 => cpu.cr8 = val,
                            _ => {}
                        }
                    }
                    // IMUL r, r/m (0x0F 0xAF)
                    0xAF => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = load_rm(cpu, ram, ram_size, modrm, lane);
                        match lane {
                            LANE16 => {
                                let res = (cpu.regs[dst_reg] as u16 as i16 as i32).wrapping_mul(src as i16 as i32);
                                write_reg16(cpu, dst_reg, res as u16);
                                materialize_flags(cpu);
                                if res as i16 as i32 != res { cpu.rflags |= CF | OF; }
                                else { cpu.rflags &= !(CF | OF); }
                                cpu.lazy.op = FlagOp::External;
                            }
                            LANE32 => {
                                let res = (cpu.regs[dst_reg] as u32 as i32 as i64).wrapping_mul(src as i32 as i64);
                                cpu.regs[dst_reg] = res as u32 as u64;
                                materialize_flags(cpu);
                                if res as i32 as i64 != res { cpu.rflags |= CF | OF; }
                                else { cpu.rflags &= !(CF | OF); }
                                cpu.lazy.op = FlagOp::External;
                            }
                            LANE64 => {
                                let res = (cpu.regs[dst_reg] as i64 as i128).wrapping_mul(src as i64 as i128);
                                cpu.regs[dst_reg] = res as u64;
                                materialize_flags(cpu);
                                if res as i64 as i128 != res { cpu.rflags |= CF | OF; }
                                else { cpu.rflags &= !(CF | OF); }
                                cpu.lazy.op = FlagOp::External;
                            }
                            _ => {}
                        }
                    }
                    // BSF (0x0F 0xBC) / BSR (0x0F 0xBD)
                    0xBC => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = load_rm(cpu, ram, ram_size, modrm, lane);
                        materialize_flags(cpu);
                        match lane {
                            LANE16 => {
                                let v = src as u16;
                                if v == 0 { cpu.rflags |= ZF; }
                                else { cpu.rflags &= !ZF; write_reg16(cpu, dst_reg, v.trailing_zeros() as u16); }
                            }
                            LANE32 => {
                                let v = src as u32;
                                if v == 0 { cpu.rflags |= ZF; }
                                else { cpu.rflags &= !ZF; cpu.regs[dst_reg] = v.trailing_zeros() as u64; }
                            }
                            _ => {
                                if src == 0 { cpu.rflags |= ZF; }
                                else { cpu.rflags &= !ZF; cpu.regs[dst_reg] = src.trailing_zeros() as u64; }
                            }
                        }
                        cpu.lazy.op = FlagOp::External;
                    }
                    0xBD => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = load_rm(cpu, ram, ram_size, modrm, lane);
                        materialize_flags(cpu);
                        match lane {
                            LANE16 => {
                                let v = src as u16;
                                if v == 0 { cpu.rflags |= ZF; }
                                else { cpu.rflags &= !ZF; write_reg16(cpu, dst_reg, (15 - v.leading_zeros()) as u16); }
                            }
                            LANE32 => {
                                let v = src as u32;
                                if v == 0 { cpu.rflags |= ZF; }
                                else { cpu.rflags &= !ZF; cpu.regs[dst_reg] = (31 - v.leading_zeros()) as u64; }
                            }
                            _ => {
                                if src == 0 { cpu.rflags |= ZF; }
                                else { cpu.rflags &= !ZF; cpu.regs[dst_reg] = (63 - src.leading_zeros()) as u64; }
                            }
                        }
                        cpu.lazy.op = FlagOp::External;
                    }
                    // BSWAP (0x0F 0xC8-0xCF)
                    0xC8..=0xCF => {
                        let r = (op2 & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        match lane {
                            LANE32 => cpu.regs[r] = (cpu.regs[r] as u32).swap_bytes() as u64,
                            _ => cpu.regs[r] = cpu.regs[r].swap_bytes(),
                        }
                    }
                    // CMPXCHG r/m8, r8 (0x0F 0xB0) / r/m, r (0x0F 0xB1)
                    0xB0 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = read_reg8(cpu, src_reg);
                        let dst = if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            read_reg8(cpu, r)
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr))
                        };
                        let al = cpu.regs[RAX] as u8;
                        let res = al.wrapping_sub(dst);
                        set_lazy(cpu, FlagOp::SubB, al as u64, res as u64);
                        if al == dst {
                            if modrm & 0xC0 == 0xC0 {
                                let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                write_reg8(cpu, r, src);
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, src));
                            }
                        } else {
                            write_reg8_al(cpu, dst);
                        }
                    }
                    0xB1 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = cpu.regs[src_reg];
                        let dst = load_rm(cpu, ram, ram_size, modrm, lane);
                        match lane {
                            LANE32 => {
                                let a = cpu.regs[RAX] as u32;
                                let d = dst as u32;
                                let res = a.wrapping_sub(d);
                                set_lazy(cpu, FlagOp::SubL, a as u64, res as u64);
                                if a == d {
                                    store_rm(cpu, ram, ram_size, modrm, lane, src);
                                } else {
                                    cpu.regs[RAX] = d as u64;
                                }
                            }
                            LANE64 => {
                                let a = cpu.regs[RAX];
                                let res = a.wrapping_sub(dst);
                                set_lazy(cpu, FlagOp::SubQ, a, res);
                                if a == dst {
                                    store_rm(cpu, ram, ram_size, modrm, lane, src);
                                } else {
                                    cpu.regs[RAX] = dst;
                                }
                            }
                            _ => {}
                        }
                    }
                    // XADD r/m, r (0x0F 0xC0/0xC1)
                    0xC0 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = read_reg8(cpu, src_reg);
                        let dst = if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            read_reg8(cpu, r)
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr))
                        };
                        let res = dst.wrapping_add(src);
                        write_reg8(cpu, src_reg, dst); // src reg gets old dst
                        if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            write_reg8(cpu, r, res);
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, res));
                        }
                        set_lazy(cpu, FlagOp::AddB, dst as u64, res as u64);
                    }
                    0xC1 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = cpu.regs[src_reg];
                        let dst = load_rm(cpu, ram, ram_size, modrm, lane);
                        match lane {
                            LANE32 => {
                                let res = (dst as u32).wrapping_add(src as u32);
                                cpu.regs[src_reg] = dst as u32 as u64;
                                store_rm(cpu, ram, ram_size, modrm, lane, res as u64);
                                set_lazy(cpu, FlagOp::AddL, dst, res as u64);
                            }
                            LANE64 => {
                                let res = dst.wrapping_add(src);
                                cpu.regs[src_reg] = dst;
                                store_rm(cpu, ram, ram_size, modrm, lane, res);
                                set_lazy(cpu, FlagOp::AddQ, dst, res);
                            }
                            _ => {}
                        }
                    }
                    // NOP (0x0F 0x1F /0) — multi-byte NOP
                    0x1F => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 != 0xC0 {
                            let _ = decode_modrm_addr(cpu, ram, ram_size, modrm); // consume but ignore
                        }
                    }
                    // NOP hints (0x0F 0x18-0x1E) — prefetch/hint NOPs
                    0x18 | 0x19 | 0x1A | 0x1B | 0x1C | 0x1D | 0x1E => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 != 0xC0 {
                            let _ = decode_modrm_addr(cpu, ram, ram_size, modrm);
                        }
                    }

                    // PUSH FS (0x0F 0xA0), PUSH GS (0x0F 0xA8)
                    0xA0 => {
                        let val = cpu.segs[SEG_FS].selector as u64;
                        if cpu.long_mode {
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                            try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], val));
                        } else {
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                            try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], val as u32));
                        }
                    }
                    0xA8 => {
                        let val = cpu.segs[SEG_GS].selector as u64;
                        if cpu.long_mode {
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                            try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], val));
                        } else {
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                            try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], val as u32));
                        }
                    }
                    // POP FS (0x0F 0xA1), POP GS (0x0F 0xA9)
                    0xA1 => {
                        let val = if cpu.long_mode {
                            let v = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, cpu.regs[RSP]));
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(8);
                            v as u16
                        } else {
                            let v = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, cpu.regs[RSP]));
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(4);
                            v as u16
                        };
                        cpu.segs[SEG_FS].selector = val;
                    }
                    0xA9 => {
                        let val = if cpu.long_mode {
                            let v = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, cpu.regs[RSP]));
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(8);
                            v as u16
                        } else {
                            let v = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, cpu.regs[RSP]));
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(4);
                            v as u16
                        };
                        cpu.segs[SEG_GS].selector = val;
                    }

                    // BT r/m, r (0x0F 0xA3)
                    0xA3 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let bit_pos = cpu.regs[src_reg];
                        let val = if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            match lane {
                                LANE16 => cpu.regs[r] as u16 as u64,
                                LANE32 => cpu.regs[r] as u32 as u64,
                                _ => cpu.regs[r],
                            }
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            let (op_bits, op_bytes) = match lane { LANE16 => (16u64, 2i64), LANE32 => (32, 4), _ => (64, 8) };
                            let byte_offset = ((bit_pos as i64) >> if op_bits == 16 { 4 } else if op_bits == 32 { 5 } else { 6 }) * op_bytes;
                            let eff_addr = addr.wrapping_add(byte_offset as u64);
                            match lane {
                                LANE16 => try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, eff_addr)) as u64,
                                LANE32 => try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, eff_addr)) as u64,
                                _ => try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, eff_addr)),
                            }
                        };
                        let mask = match lane { LANE16 => 15, LANE32 => 31, _ => 63 };
                        let bit = (val >> (bit_pos & mask)) & 1;
                        materialize_flags(cpu);
                        cpu.rflags = (cpu.rflags & !CF) | (bit * CF);
                        cpu.lazy.op = FlagOp::External;
                    }
                    // BTS r/m, r (0x0F 0xAB)
                    0xAB => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let bit_pos = cpu.regs[src_reg];
                        let mask = match lane { LANE16 => 15u64, LANE32 => 31, _ => 63 };
                        if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            let val = cpu.regs[r];
                            let bit = (val >> (bit_pos & mask)) & 1;
                            cpu.regs[r] = val | (1u64 << (bit_pos & mask));
                            if lane == LANE32 { cpu.regs[r] = cpu.regs[r] as u32 as u64; }
                            materialize_flags(cpu);
                            cpu.rflags = (cpu.rflags & !CF) | (bit * CF);
                            cpu.lazy.op = FlagOp::External;
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            let (op_bits, op_bytes) = match lane { LANE16 => (16u64, 2i64), LANE32 => (32, 4), _ => (64, 8) };
                            let byte_offset = ((bit_pos as i64) >> if op_bits == 16 { 4 } else if op_bits == 32 { 5 } else { 6 }) * op_bytes;
                            let eff_addr = addr.wrapping_add(byte_offset as u64);
                            let val = match lane {
                                LANE16 => try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, eff_addr)) as u64,
                                LANE32 => try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, eff_addr)) as u64,
                                _ => try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, eff_addr)),
                            };
                            let bit = (val >> (bit_pos & mask)) & 1;
                            let new_val = val | (1u64 << (bit_pos & mask));
                            match lane {
                                LANE16 => { try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, eff_addr, new_val as u16)); }
                                LANE32 => { try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, eff_addr, new_val as u32)); }
                                _ => { try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, eff_addr, new_val)); }
                            }
                            materialize_flags(cpu);
                            cpu.rflags = (cpu.rflags & !CF) | (bit * CF);
                            cpu.lazy.op = FlagOp::External;
                        }
                    }
                    // BTR r/m, r (0x0F 0xB3)
                    0xB3 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let bit_pos = cpu.regs[src_reg];
                        let mask = match lane { LANE16 => 15u64, LANE32 => 31, _ => 63 };
                        if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            let val = cpu.regs[r];
                            let bit = (val >> (bit_pos & mask)) & 1;
                            cpu.regs[r] = val & !(1u64 << (bit_pos & mask));
                            if lane == LANE32 { cpu.regs[r] = cpu.regs[r] as u32 as u64; }
                            materialize_flags(cpu);
                            cpu.rflags = (cpu.rflags & !CF) | (bit * CF);
                            cpu.lazy.op = FlagOp::External;
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            let (op_bits, op_bytes) = match lane { LANE16 => (16u64, 2i64), LANE32 => (32, 4), _ => (64, 8) };
                            let byte_offset = ((bit_pos as i64) >> if op_bits == 16 { 4 } else if op_bits == 32 { 5 } else { 6 }) * op_bytes;
                            let eff_addr = addr.wrapping_add(byte_offset as u64);
                            let val = match lane {
                                LANE16 => try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, eff_addr)) as u64,
                                LANE32 => try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, eff_addr)) as u64,
                                _ => try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, eff_addr)),
                            };
                            let bit = (val >> (bit_pos & mask)) & 1;
                            let new_val = val & !(1u64 << (bit_pos & mask));
                            match lane {
                                LANE16 => { try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, eff_addr, new_val as u16)); }
                                LANE32 => { try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, eff_addr, new_val as u32)); }
                                _ => { try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, eff_addr, new_val)); }
                            }
                            materialize_flags(cpu);
                            cpu.rflags = (cpu.rflags & !CF) | (bit * CF);
                            cpu.lazy.op = FlagOp::External;
                        }
                    }
                    // BTC r/m, r (0x0F 0xBB)
                    0xBB => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let bit_pos = cpu.regs[src_reg];
                        let mask = match lane { LANE16 => 15u64, LANE32 => 31, _ => 63 };
                        if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            let val = cpu.regs[r];
                            let bit = (val >> (bit_pos & mask)) & 1;
                            cpu.regs[r] = val ^ (1u64 << (bit_pos & mask));
                            if lane == LANE32 { cpu.regs[r] = cpu.regs[r] as u32 as u64; }
                            materialize_flags(cpu);
                            cpu.rflags = (cpu.rflags & !CF) | (bit * CF);
                            cpu.lazy.op = FlagOp::External;
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            let (op_bits, op_bytes) = match lane { LANE16 => (16u64, 2i64), LANE32 => (32, 4), _ => (64, 8) };
                            let byte_offset = ((bit_pos as i64) >> if op_bits == 16 { 4 } else if op_bits == 32 { 5 } else { 6 }) * op_bytes;
                            let eff_addr = addr.wrapping_add(byte_offset as u64);
                            let val = match lane {
                                LANE16 => try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, eff_addr)) as u64,
                                LANE32 => try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, eff_addr)) as u64,
                                _ => try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, eff_addr)),
                            };
                            let bit = (val >> (bit_pos & mask)) & 1;
                            let new_val = val ^ (1u64 << (bit_pos & mask));
                            match lane {
                                LANE16 => { try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, eff_addr, new_val as u16)); }
                                LANE32 => { try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, eff_addr, new_val as u32)); }
                                _ => { try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, eff_addr, new_val)); }
                            }
                            materialize_flags(cpu);
                            cpu.rflags = (cpu.rflags & !CF) | (bit * CF);
                            cpu.lazy.op = FlagOp::External;
                        }
                    }

                    // BT group 8: BT/BTS/BTR/BTC r/m, imm8 (0x0F 0xBA /4-7)
                    0xBA => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let reg_field = (modrm >> 3) & 7;
                        let val = load_rm(cpu, ram, ram_size, modrm, lane);
                        let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let mask = match lane { LANE16 => 15u8, LANE32 => 31, _ => 63 };
                        let bit_idx = imm & mask;
                        let bit = (val >> bit_idx) & 1;
                        match reg_field {
                            4 => { // BT — read only
                            }
                            5 => { // BTS — set bit
                                let new_val = val | (1u64 << bit_idx);
                                store_rm(cpu, ram, ram_size, modrm, lane, new_val);
                            }
                            6 => { // BTR — clear bit
                                let new_val = val & !(1u64 << bit_idx);
                                store_rm(cpu, ram, ram_size, modrm, lane, new_val);
                            }
                            7 => { // BTC — complement bit
                                let new_val = val ^ (1u64 << bit_idx);
                                store_rm(cpu, ram, ram_size, modrm, lane, new_val);
                            }
                            _ => { raise_exception(cpu, EXC_UD, 0); continue; }
                        }
                        materialize_flags(cpu);
                        cpu.rflags = (cpu.rflags & !CF) | (bit * CF);
                        cpu.lazy.op = FlagOp::External;
                    }

                    // SHLD r/m, r, imm8 (0x0F 0xA4)
                    0xA4 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let fill = cpu.regs[src_reg];
                        let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = load_rm(cpu, ram, ram_size, modrm, lane);
                        let res = exec_shld(dst, fill, imm as u64, lane);
                        if res != u64::MAX {
                            store_rm(cpu, ram, ram_size, modrm, lane, res);
                        }
                    }
                    // SHLD r/m, r, CL (0x0F 0xA5)
                    0xA5 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let fill = cpu.regs[src_reg];
                        let count = cpu.regs[RCX] as u8;
                        let dst = load_rm(cpu, ram, ram_size, modrm, lane);
                        let res = exec_shld(dst, fill, count as u64, lane);
                        if res != u64::MAX {
                            store_rm(cpu, ram, ram_size, modrm, lane, res);
                        }
                    }
                    // SHRD r/m, r, imm8 (0x0F 0xAC)
                    0xAC => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let fill = cpu.regs[src_reg];
                        let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = load_rm(cpu, ram, ram_size, modrm, lane);
                        let res = exec_shrd(dst, fill, imm as u64, lane);
                        if res != u64::MAX {
                            store_rm(cpu, ram, ram_size, modrm, lane, res);
                        }
                    }
                    // SHRD r/m, r, CL (0x0F 0xAD)
                    0xAD => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let fill = cpu.regs[src_reg];
                        let count = cpu.regs[RCX] as u8;
                        let dst = load_rm(cpu, ram, ram_size, modrm, lane);
                        let res = exec_shrd(dst, fill, count as u64, lane);
                        if res != u64::MAX {
                            store_rm(cpu, ram, ram_size, modrm, lane, res);
                        }
                    }

                    // CMPXCHG8B/16B (0x0F 0xC7 /1)
                    0xC7 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let reg_field = (modrm >> 3) & 7;
                        if reg_field != 1 || modrm & 0xC0 == 0xC0 {
                            raise_exception(cpu, EXC_UD, 0); continue;
                        }
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        if lane == LANE64 {
                            // CMPXCHG16B: compare RDX:RAX with m128
                            let lo = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                            let hi = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr.wrapping_add(8)));
                            if cpu.regs[RAX] == lo && cpu.regs[RDX] == hi {
                                try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.regs[RBX]));
                                try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr.wrapping_add(8), cpu.regs[RCX]));
                                materialize_flags(cpu);
                                cpu.rflags |= ZF;
                                cpu.lazy.op = FlagOp::External;
                            } else {
                                cpu.regs[RAX] = lo;
                                cpu.regs[RDX] = hi;
                                materialize_flags(cpu);
                                cpu.rflags &= !ZF;
                                cpu.lazy.op = FlagOp::External;
                            }
                        } else {
                            // CMPXCHG8B: compare EDX:EAX with m64
                            let lo = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr)) as u64;
                            let hi = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr.wrapping_add(4))) as u64;
                            let cmp_val = (hi << 32) | lo;
                            let eax_edx = ((cpu.regs[RDX] as u32 as u64) << 32) | (cpu.regs[RAX] as u32 as u64);
                            if eax_edx == cmp_val {
                                try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, cpu.regs[RBX] as u32));
                                try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr.wrapping_add(4), cpu.regs[RCX] as u32));
                                materialize_flags(cpu);
                                cpu.rflags |= ZF;
                                cpu.lazy.op = FlagOp::External;
                            } else {
                                cpu.regs[RAX] = lo;
                                cpu.regs[RDX] = hi;
                                materialize_flags(cpu);
                                cpu.rflags &= !ZF;
                                cpu.lazy.op = FlagOp::External;
                            }
                        }
                    }

                    // MOVNTI m32/64, r (0x0F 0xC3) — non-temporal store → regular store
                    0xC3 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 == 0xC0 { raise_exception(cpu, EXC_UD, 0); continue; }
                        let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        match lane {
                            LANE32 => { try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, cpu.regs[src_reg] as u32)); }
                            LANE64 => { try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.regs[src_reg])); }
                            _ => { try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, cpu.regs[src_reg] as u32)); }
                        }
                    }

                    // LSS r, m16:16/32/64 (0x0F 0xB2)
                    0xB2 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 == 0xC0 { raise_exception(cpu, EXC_UD, 0); continue; }
                        let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        match lane {
                            LANE16 => {
                                let val = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr));
                                let sel = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(2)));
                                write_reg16(cpu, dst_reg, val);
                                cpu.segs[SEG_SS].selector = sel;
                            }
                            LANE32 => {
                                let val = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr));
                                let sel = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(4)));
                                cpu.regs[dst_reg] = val as u64;
                                cpu.segs[SEG_SS].selector = sel;
                            }
                            _ => {
                                let val = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                                let sel = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(8)));
                                cpu.regs[dst_reg] = val;
                                cpu.segs[SEG_SS].selector = sel;
                            }
                        }
                    }
                    // LFS r, m16:16/32/64 (0x0F 0xB4)
                    0xB4 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 == 0xC0 { raise_exception(cpu, EXC_UD, 0); continue; }
                        let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        match lane {
                            LANE16 => {
                                let val = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr));
                                let sel = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(2)));
                                write_reg16(cpu, dst_reg, val);
                                cpu.segs[SEG_FS].selector = sel;
                            }
                            LANE32 => {
                                let val = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr));
                                let sel = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(4)));
                                cpu.regs[dst_reg] = val as u64;
                                cpu.segs[SEG_FS].selector = sel;
                            }
                            _ => {
                                let val = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                                let sel = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(8)));
                                cpu.regs[dst_reg] = val;
                                cpu.segs[SEG_FS].selector = sel;
                            }
                        }
                    }
                    // LGS r, m16:16/32/64 (0x0F 0xB5)
                    0xB5 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 == 0xC0 { raise_exception(cpu, EXC_UD, 0); continue; }
                        let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        match lane {
                            LANE16 => {
                                let val = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr));
                                let sel = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(2)));
                                write_reg16(cpu, dst_reg, val);
                                cpu.segs[SEG_GS].selector = sel;
                            }
                            LANE32 => {
                                let val = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr));
                                let sel = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(4)));
                                cpu.regs[dst_reg] = val as u64;
                                cpu.segs[SEG_GS].selector = sel;
                            }
                            _ => {
                                let val = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                                let sel = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(8)));
                                cpu.regs[dst_reg] = val;
                                cpu.segs[SEG_GS].selector = sel;
                            }
                        }
                    }

                    // 0x0F 0xAE — fences + LDMXCSR/STMXCSR
                    0xAE => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let reg_field = (modrm >> 3) & 7;
                        if modrm & 0xC0 == 0xC0 {
                            // mod=11: LFENCE(5), MFENCE(6), SFENCE(7) → no-op
                            match reg_field {
                                5 | 6 | 7 => {} // fence no-ops
                                _ => { raise_exception(cpu, EXC_UD, 0); continue; }
                            }
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            match reg_field {
                                2 => { // LDMXCSR
                                    cpu.sse.mxcsr = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr));
                                }
                                3 => { // STMXCSR
                                    try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, cpu.sse.mxcsr));
                                }
                                5 | 6 | 7 => {} // fence no-ops (memory forms)
                                _ => { raise_exception(cpu, EXC_UD, 0); continue; }
                            }
                        }
                    }

                    // BSF (0x0F 0xBC), BSR (0x0F 0xBD)
                    0xBC => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let val = load_rm(cpu, ram, ram_size, modrm, lane);
                        let masked = match lane {
                            LANE16 => val & 0xFFFF,
                            LANE32 => val & 0xFFFFFFFF,
                            _ => val,
                        };
                        materialize_flags(cpu);
                        if masked == 0 {
                            cpu.rflags |= ZF;
                        } else {
                            cpu.rflags &= !ZF;
                            let bit = masked.trailing_zeros() as u64;
                            match lane {
                                LANE16 => write_reg16(cpu, dst_reg, bit as u16),
                                LANE32 => cpu.regs[dst_reg] = bit,
                                _ => cpu.regs[dst_reg] = bit,
                            }
                        }
                        cpu.lazy.op = FlagOp::External;
                    }
                    0xBD => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let val = load_rm(cpu, ram, ram_size, modrm, lane);
                        let masked = match lane {
                            LANE16 => val & 0xFFFF,
                            LANE32 => val & 0xFFFFFFFF,
                            _ => val,
                        };
                        materialize_flags(cpu);
                        if masked == 0 {
                            cpu.rflags |= ZF;
                        } else {
                            cpu.rflags &= !ZF;
                            let bits = match lane { LANE16 => 16u32, LANE32 => 32, _ => 64 };
                            let bit = (bits - 1 - masked.leading_zeros()) as u64;
                            match lane {
                                LANE16 => write_reg16(cpu, dst_reg, bit as u16),
                                LANE32 => cpu.regs[dst_reg] = bit,
                                _ => cpu.regs[dst_reg] = bit,
                            }
                        }
                        cpu.lazy.op = FlagOp::External;
                    }

                    // BSWAP (0x0F 0xC8-0xCF)
                    0xC8 | 0xC9 | 0xCA | 0xCB | 0xCC | 0xCD | 0xCE | 0xCF => {
                        let r = (op2 & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        match lane {
                            LANE32 => cpu.regs[r] = (cpu.regs[r] as u32).swap_bytes() as u64,
                            LANE64 => cpu.regs[r] = cpu.regs[r].swap_bytes(),
                            _ => cpu.regs[r] = (cpu.regs[r] as u16).swap_bytes() as u64,
                        }
                    }

                    // MOVSX r32/64, r/m8 (0x0F 0xBE) — already handled above
                    // MOVSX r32/64, r/m16 (0x0F 0xBF) — already handled above
                    // MOVZX r, r/m8 (0x0F 0xB6) — already handled above
                    // MOVZX r, r/m16 (0x0F 0xB7) — already handled above

                    // ==========================================================
                    // SSE/SSE2 — Data Movement
                    // ==========================================================

                    // MOVUPS/MOVAPS (0x10/0x11/0x28/0x29) — no prefix
                    // MOVUPD/MOVAPD (0x10/0x11/0x28/0x29) — 0x66 prefix
                    // MOVSS (0x10/0x11) — 0xF3 prefix
                    // MOVSD (0x10/0x11) — 0xF2 prefix
                    0x10 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        if cpu.prefix.rep == 0xF3 {
                            // MOVSS xmm, xmm/m32
                            if modrm & 0xC0 == 0xC0 {
                                let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                // reg-reg: merge low 32 bits only
                                let src_lo = cpu.sse.xmm[src][0];
                                cpu.sse.xmm[dst][0] = (cpu.sse.xmm[dst][0] & 0xFFFFFFFF00000000) | (src_lo & 0xFFFFFFFF);
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                let val = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr));
                                cpu.sse.xmm[dst][0] = val as u64;
                                cpu.sse.xmm[dst][1] = 0;
                            }
                        } else if cpu.prefix.rep == 0xF2 {
                            // MOVSD xmm, xmm/m64
                            if modrm & 0xC0 == 0xC0 {
                                let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                cpu.sse.xmm[dst][0] = cpu.sse.xmm[src][0];
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                cpu.sse.xmm[dst][0] = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                                cpu.sse.xmm[dst][1] = 0;
                            }
                        } else {
                            // MOVUPS/MOVUPD: load 128-bit
                            let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                            cpu.sse.xmm[dst][0] = lo;
                            cpu.sse.xmm[dst][1] = hi;
                        }
                    }
                    0x11 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        if cpu.prefix.rep == 0xF3 {
                            // MOVSS xmm/m32, xmm
                            if modrm & 0xC0 == 0xC0 {
                                let dst_r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                cpu.sse.xmm[dst_r][0] = (cpu.sse.xmm[dst_r][0] & 0xFFFFFFFF00000000) | (cpu.sse.xmm[src][0] & 0xFFFFFFFF);
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, cpu.sse.xmm[src][0] as u32));
                            }
                        } else if cpu.prefix.rep == 0xF2 {
                            // MOVSD xmm/m64, xmm
                            if modrm & 0xC0 == 0xC0 {
                                let dst_r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                cpu.sse.xmm[dst_r][0] = cpu.sse.xmm[src][0];
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.sse.xmm[src][0]));
                            }
                        } else {
                            // MOVUPS/MOVUPD: store 128-bit
                            store_xmm_rm(cpu, ram, ram_size, modrm, cpu.sse.xmm[src][0], cpu.sse.xmm[src][1]);
                        }
                    }
                    // MOVLPS/MOVHLPS (0x12), MOVLPD (0x12 + 66)
                    0x12 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        if modrm & 0xC0 == 0xC0 {
                            // MOVHLPS: dst.lo = src.hi
                            let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            cpu.sse.xmm[dst][0] = cpu.sse.xmm[src][1];
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            cpu.sse.xmm[dst][0] = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                        }
                    }
                    0x13 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 == 0xC0 { raise_exception(cpu, EXC_UD, 0); continue; }
                        let src = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.sse.xmm[src][0]));
                    }
                    // MOVHPS/MOVLHPS (0x16), MOVHPD (0x16 + 66)
                    0x16 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        if modrm & 0xC0 == 0xC0 {
                            // MOVLHPS: dst.hi = src.lo
                            let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            cpu.sse.xmm[dst][1] = cpu.sse.xmm[src][0];
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            cpu.sse.xmm[dst][1] = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                        }
                    }
                    0x17 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 == 0xC0 { raise_exception(cpu, EXC_UD, 0); continue; }
                        let src = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.sse.xmm[src][1]));
                    }
                    // MOVAPS/MOVAPD (0x28/0x29)
                    0x28 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        cpu.sse.xmm[dst][0] = lo;
                        cpu.sse.xmm[dst][1] = hi;
                    }
                    0x29 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        store_xmm_rm(cpu, ram, ram_size, modrm, cpu.sse.xmm[src][0], cpu.sse.xmm[src][1]);
                    }
                    // MOVNTPS/MOVNTPD (0x2B) — non-temporal store → regular store
                    0x2B => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 == 0xC0 { raise_exception(cpu, EXC_UD, 0); continue; }
                        let src = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.sse.xmm[src][0]));
                        try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr.wrapping_add(8), cpu.sse.xmm[src][1]));
                    }

                    // MOVD/MOVQ GP↔XMM (0x6E, 0x7E)
                    0x6E => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        if lane == LANE64 {
                            // MOVQ xmm, r/m64
                            let val = load_rm(cpu, ram, ram_size, modrm, LANE64);
                            cpu.sse.xmm[dst][0] = val;
                            cpu.sse.xmm[dst][1] = 0;
                        } else {
                            // MOVD xmm, r/m32
                            let val = load_rm(cpu, ram, ram_size, modrm, LANE32);
                            cpu.sse.xmm[dst][0] = val as u32 as u64;
                            cpu.sse.xmm[dst][1] = 0;
                        }
                    }
                    0x7E => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if cpu.prefix.rep == 0xF3 {
                            // MOVQ xmm, xmm/m64
                            let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                            if modrm & 0xC0 == 0xC0 {
                                let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                cpu.sse.xmm[dst][0] = cpu.sse.xmm[src][0];
                                cpu.sse.xmm[dst][1] = 0;
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                cpu.sse.xmm[dst][0] = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                                cpu.sse.xmm[dst][1] = 0;
                            }
                        } else {
                            // MOVD r/m32, xmm or MOVQ r/m64, xmm
                            let src = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                            let val = cpu.sse.xmm[src][0];
                            if lane == LANE64 {
                                store_rm(cpu, ram, ram_size, modrm, LANE64, val);
                            } else {
                                store_rm(cpu, ram, ram_size, modrm, LANE32, val as u32 as u64);
                            }
                        }
                    }
                    // MOVDQA/MOVDQU (0x6F/0x7F)
                    0x6F => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        cpu.sse.xmm[dst][0] = lo;
                        cpu.sse.xmm[dst][1] = hi;
                    }
                    0x7F => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        store_xmm_rm(cpu, ram, ram_size, modrm, cpu.sse.xmm[src][0], cpu.sse.xmm[src][1]);
                    }
                    // MOVQ xmm/m64, xmm (0xD6 + 66 prefix)
                    0xD6 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let src = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        if modrm & 0xC0 == 0xC0 {
                            let dst_r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            cpu.sse.xmm[dst_r][0] = cpu.sse.xmm[src][0];
                            cpu.sse.xmm[dst_r][1] = 0;
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.sse.xmm[src][0]));
                        }
                    }
                    // MOVNTDQ (0xE7 + 66) — non-temporal 128-bit store
                    0xE7 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if modrm & 0xC0 == 0xC0 { raise_exception(cpu, EXC_UD, 0); continue; }
                        let src = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.sse.xmm[src][0]));
                        try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr.wrapping_add(8), cpu.sse.xmm[src][1]));
                    }

                    // ==========================================================
                    // SSE/SSE2 — Logical
                    // ==========================================================
                    // ANDPS/ANDPD (0x54), ANDNPS/ANDNPD (0x55), ORPS/ORPD (0x56), XORPS/XORPD (0x57)
                    0x54 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        cpu.sse.xmm[dst][0] &= lo;
                        cpu.sse.xmm[dst][1] &= hi;
                    }
                    0x55 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        cpu.sse.xmm[dst][0] = (!cpu.sse.xmm[dst][0]) & lo;
                        cpu.sse.xmm[dst][1] = (!cpu.sse.xmm[dst][1]) & hi;
                    }
                    0x56 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        cpu.sse.xmm[dst][0] |= lo;
                        cpu.sse.xmm[dst][1] |= hi;
                    }
                    0x57 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        cpu.sse.xmm[dst][0] ^= lo;
                        cpu.sse.xmm[dst][1] ^= hi;
                    }

                    // ==========================================================
                    // SSE/SSE2 — Compare
                    // ==========================================================
                    // UCOMISS/UCOMISD (0x2E), COMISS/COMISD (0x2F)
                    0x2E | 0x2F => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let is_sd = cpu.prefix.op_size; // 0x66 prefix = double
                        let a: f64;
                        let b: f64;
                        if is_sd {
                            a = f64::from_bits(cpu.sse.xmm[dst][0]);
                            if modrm & 0xC0 == 0xC0 {
                                let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                b = f64::from_bits(cpu.sse.xmm[src][0]);
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                b = f64::from_bits(try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr)));
                            }
                        } else {
                            a = f32::from_bits(cpu.sse.xmm[dst][0] as u32) as f64;
                            if modrm & 0xC0 == 0xC0 {
                                let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                b = f32::from_bits(cpu.sse.xmm[src][0] as u32) as f64;
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                b = f32::from_bits(try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr))) as f64;
                            }
                        }
                        materialize_flags(cpu);
                        cpu.rflags &= !(CF | ZF | PF | OF | SF | AF);
                        if a.is_nan() || b.is_nan() {
                            cpu.rflags |= CF | ZF | PF;
                        } else if a > b {
                            // all clear
                        } else if a < b {
                            cpu.rflags |= CF;
                        } else {
                            cpu.rflags |= ZF;
                        }
                        cpu.lazy.op = FlagOp::External;
                    }

                    // CMPPS/CMPPD/CMPSS/CMPSD (0xC2)
                    0xC2 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let pred = imm & 7;
                        if cpu.prefix.rep == 0xF3 {
                            // CMPSS — scalar single
                            let a = f32::from_bits(cpu.sse.xmm[dst][0] as u32);
                            let b = f32::from_bits(lo as u32);
                            let r = sse_cmp_f32(a, b, pred);
                            cpu.sse.xmm[dst][0] = (cpu.sse.xmm[dst][0] & 0xFFFFFFFF00000000) | r as u64;
                        } else if cpu.prefix.rep == 0xF2 {
                            // CMPSD — scalar double
                            let a = f64::from_bits(cpu.sse.xmm[dst][0]);
                            let b = f64::from_bits(lo);
                            let r = sse_cmp_f64(a, b, pred);
                            cpu.sse.xmm[dst][0] = r;
                        } else if cpu.prefix.op_size {
                            // CMPPD — packed double
                            let a0 = f64::from_bits(cpu.sse.xmm[dst][0]);
                            let a1 = f64::from_bits(cpu.sse.xmm[dst][1]);
                            let b0 = f64::from_bits(lo);
                            let b1 = f64::from_bits(hi);
                            cpu.sse.xmm[dst][0] = sse_cmp_f64(a0, b0, pred);
                            cpu.sse.xmm[dst][1] = sse_cmp_f64(a1, b1, pred);
                        } else {
                            // CMPPS — packed single
                            sse_cmpps(cpu, dst, lo, hi, pred);
                        }
                    }

                    // ==========================================================
                    // SSE — Extract/Mask
                    // ==========================================================
                    // MOVMSKPS/MOVMSKPD (0x50)
                    0x50 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        if cpu.prefix.op_size {
                            // MOVMSKPD — extract sign bits of 2 doubles
                            let bit0 = (cpu.sse.xmm[src][0] >> 63) & 1;
                            let bit1 = (cpu.sse.xmm[src][1] >> 63) & 1;
                            cpu.regs[dst] = bit0 | (bit1 << 1);
                        } else {
                            // MOVMSKPS — extract sign bits of 4 floats
                            let lo = cpu.sse.xmm[src][0];
                            let hi = cpu.sse.xmm[src][1];
                            let bit0 = (lo >> 31) & 1;
                            let bit1 = (lo >> 63) & 1;
                            let bit2 = (hi >> 31) & 1;
                            let bit3 = (hi >> 63) & 1;
                            cpu.regs[dst] = bit0 | (bit1 << 1) | (bit2 << 2) | (bit3 << 3);
                        }
                    }
                    // PMOVMSKB (0xD7 + 66 prefix)
                    0xD7 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        let lo = cpu.sse.xmm[src][0];
                        let hi = cpu.sse.xmm[src][1];
                        let mut mask = 0u64;
                        for i in 0..8 { mask |= ((lo >> (i * 8 + 7)) & 1) << i; }
                        for i in 0..8 { mask |= ((hi >> (i * 8 + 7)) & 1) << (i + 8); }
                        cpu.regs[dst] = mask;
                    }

                    // ==========================================================
                    // SSE — Shuffle
                    // ==========================================================
                    // UNPCKLPS/UNPCKLPD (0x14)
                    0x14 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, _hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        if cpu.prefix.op_size {
                            // UNPCKLPD: dst[0] = dst[0], dst[1] = src[0]
                            cpu.sse.xmm[dst][1] = lo;
                        } else {
                            // UNPCKLPS: interleave low 32-bit floats
                            let d0 = cpu.sse.xmm[dst][0] as u32 as u64;
                            let d1 = (cpu.sse.xmm[dst][0] >> 32) as u32 as u64;
                            let s0 = lo as u32 as u64;
                            let s1 = (lo >> 32) as u32 as u64;
                            cpu.sse.xmm[dst][0] = d0 | (s0 << 32);
                            cpu.sse.xmm[dst][1] = d1 | (s1 << 32);
                        }
                    }
                    // UNPCKHPS/UNPCKHPD (0x15)
                    0x15 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (_lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        if cpu.prefix.op_size {
                            // UNPCKHPD: dst[0] = dst[1], dst[1] = src[1]
                            cpu.sse.xmm[dst][0] = cpu.sse.xmm[dst][1];
                            cpu.sse.xmm[dst][1] = hi;
                        } else {
                            // UNPCKHPS: interleave high 32-bit floats
                            let d2 = cpu.sse.xmm[dst][1] as u32 as u64;
                            let d3 = (cpu.sse.xmm[dst][1] >> 32) as u32 as u64;
                            let s2 = hi as u32 as u64;
                            let s3 = (hi >> 32) as u32 as u64;
                            cpu.sse.xmm[dst][0] = d2 | (s2 << 32);
                            cpu.sse.xmm[dst][1] = d3 | (s3 << 32);
                        }
                    }
                    // PSHUFD/PSHUFLW/PSHUFHW (0x70)
                    0x70 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if cpu.prefix.op_size || cpu.prefix.rep == 0 {
                            // PSHUFD: shuffle 32-bit dwords
                            let dwords = [lo as u32, (lo >> 32) as u32, hi as u32, (hi >> 32) as u32];
                            let r0 = dwords[(imm & 3) as usize];
                            let r1 = dwords[((imm >> 2) & 3) as usize];
                            let r2 = dwords[((imm >> 4) & 3) as usize];
                            let r3 = dwords[((imm >> 6) & 3) as usize];
                            cpu.sse.xmm[dst][0] = r0 as u64 | ((r1 as u64) << 32);
                            cpu.sse.xmm[dst][1] = r2 as u64 | ((r3 as u64) << 32);
                        } else if cpu.prefix.rep == 0xF3 {
                            // PSHUFLW: shuffle low 4 words, high unchanged
                            let words = [lo as u16, (lo >> 16) as u16, (lo >> 32) as u16, (lo >> 48) as u16];
                            let r0 = words[(imm & 3) as usize] as u64;
                            let r1 = words[((imm >> 2) & 3) as usize] as u64;
                            let r2 = words[((imm >> 4) & 3) as usize] as u64;
                            let r3 = words[((imm >> 6) & 3) as usize] as u64;
                            cpu.sse.xmm[dst][0] = r0 | (r1 << 16) | (r2 << 32) | (r3 << 48);
                            cpu.sse.xmm[dst][1] = hi;
                        } else {
                            // PSHUFHW: shuffle high 4 words, low unchanged
                            let words = [hi as u16, (hi >> 16) as u16, (hi >> 32) as u16, (hi >> 48) as u16];
                            let r0 = words[(imm & 3) as usize] as u64;
                            let r1 = words[((imm >> 2) & 3) as usize] as u64;
                            let r2 = words[((imm >> 4) & 3) as usize] as u64;
                            let r3 = words[((imm >> 6) & 3) as usize] as u64;
                            cpu.sse.xmm[dst][0] = lo;
                            cpu.sse.xmm[dst][1] = r0 | (r1 << 16) | (r2 << 32) | (r3 << 48);
                        }
                    }
                    // SHUFPS/SHUFPD (0xC6)
                    0xC6 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        if cpu.prefix.op_size {
                            // SHUFPD
                            let d = [cpu.sse.xmm[dst][0], cpu.sse.xmm[dst][1]];
                            let s = [lo, hi];
                            cpu.sse.xmm[dst][0] = d[(imm & 1) as usize];
                            cpu.sse.xmm[dst][1] = s[((imm >> 1) & 1) as usize];
                        } else {
                            // SHUFPS
                            let d = [cpu.sse.xmm[dst][0] as u32, (cpu.sse.xmm[dst][0] >> 32) as u32,
                                     cpu.sse.xmm[dst][1] as u32, (cpu.sse.xmm[dst][1] >> 32) as u32];
                            let s = [lo as u32, (lo >> 32) as u32, hi as u32, (hi >> 32) as u32];
                            let r0 = d[(imm & 3) as usize] as u64;
                            let r1 = d[((imm >> 2) & 3) as usize] as u64;
                            let r2 = s[((imm >> 4) & 3) as usize] as u64;
                            let r3 = s[((imm >> 6) & 3) as usize] as u64;
                            cpu.sse.xmm[dst][0] = r0 | (r1 << 32);
                            cpu.sse.xmm[dst][1] = r2 | (r3 << 32);
                        }
                    }

                    // ==========================================================
                    // SSE/SSE2 — Float Arithmetic (0x51-0x5F)
                    // ==========================================================
                    0x51 | 0x52 | 0x53 | 0x58 | 0x59 | 0x5A | 0x5B | 0x5C | 0x5D | 0x5E | 0x5F => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        exec_sse_arith(cpu, dst, lo, hi, op2);
                    }

                    // ==========================================================
                    // SSE2 — Packed Integer Arithmetic
                    // ==========================================================
                    // PADDB/W/D/Q, PSUBB/W/D/Q, etc.
                    0x60 | 0x61 | 0x62 | 0x63 | 0x64 | 0x65 | 0x66 | 0x67 |
                    0x68 | 0x69 | 0x6A | 0x6B | 0x6C | 0x6D |
                    0x71 | 0x72 | 0x73 |
                    0x74 | 0x75 | 0x76 |
                    0xD1 | 0xD2 | 0xD3 | 0xD4 | 0xD5 |
                    0xD8 | 0xD9 | 0xDA | 0xDB | 0xDC | 0xDD | 0xDE | 0xDF |
                    0xE0 | 0xE1 | 0xE2 | 0xE3 | 0xE4 | 0xE5 |
                    0xE8 | 0xE9 | 0xEA | 0xEB | 0xEC | 0xED | 0xEE | 0xEF |
                    0xF1 | 0xF2 | 0xF3 | 0xF4 | 0xF5 | 0xF6 |
                    0xF8 | 0xF9 | 0xFA | 0xFB | 0xFC | 0xFD | 0xFE => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        // Shift-by-immediate (0x71/72/73) have imm8 after modrm, not XMM source
                        if op2 == 0x71 || op2 == 0x72 || op2 == 0x73 {
                            let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                            let reg_field = (modrm >> 3) & 7;
                            let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            exec_sse_shift_imm(cpu, r, op2, reg_field, imm);
                        } else {
                            let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                            exec_sse_int_op(cpu, dst, lo, hi, op2);
                        }
                    }

                    // ==========================================================
                    // SSE/SSE2 — Conversions
                    // ==========================================================
                    0x2A => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        if cpu.prefix.rep == 0xF3 {
                            // CVTSI2SS
                            let val = if lane == LANE64 {
                                load_rm(cpu, ram, ram_size, modrm, LANE64) as i64 as f32
                            } else {
                                load_rm(cpu, ram, ram_size, modrm, LANE32) as i32 as f32
                            };
                            cpu.sse.xmm[dst][0] = (cpu.sse.xmm[dst][0] & 0xFFFFFFFF00000000) | val.to_bits() as u64;
                        } else if cpu.prefix.rep == 0xF2 {
                            // CVTSI2SD
                            let val = if lane == LANE64 {
                                load_rm(cpu, ram, ram_size, modrm, LANE64) as i64 as f64
                            } else {
                                load_rm(cpu, ram, ram_size, modrm, LANE32) as i32 as f64
                            };
                            cpu.sse.xmm[dst][0] = val.to_bits();
                        } else {
                            // CVTPI2PS / CVTPI2PD — not commonly used, ignore
                        }
                    }
                    0x2C => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        if cpu.prefix.rep == 0xF3 {
                            // CVTTSS2SI
                            let val = if modrm & 0xC0 == 0xC0 {
                                let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                f32::from_bits(cpu.sse.xmm[src][0] as u32)
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                f32::from_bits(try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr)))
                            };
                            if lane == LANE64 {
                                cpu.regs[dst] = val as i64 as u64;
                            } else {
                                cpu.regs[dst] = val as i32 as u32 as u64;
                            }
                        } else if cpu.prefix.rep == 0xF2 {
                            // CVTTSD2SI
                            let val = if modrm & 0xC0 == 0xC0 {
                                let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                f64::from_bits(cpu.sse.xmm[src][0])
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                f64::from_bits(try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr)))
                            };
                            if lane == LANE64 {
                                cpu.regs[dst] = val as i64 as u64;
                            } else {
                                cpu.regs[dst] = val as i32 as u32 as u64;
                            }
                        }
                    }
                    0x2D => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        if cpu.prefix.rep == 0xF3 {
                            // CVTSS2SI (rounds per MXCSR)
                            let val = if modrm & 0xC0 == 0xC0 {
                                let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                f32::from_bits(cpu.sse.xmm[src][0] as u32)
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                f32::from_bits(try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr)))
                            };
                            if lane == LANE64 {
                                cpu.regs[dst] = libm::roundf(val) as i64 as u64;
                            } else {
                                cpu.regs[dst] = libm::roundf(val) as i32 as u32 as u64;
                            }
                        } else if cpu.prefix.rep == 0xF2 {
                            // CVTSD2SI
                            let val = if modrm & 0xC0 == 0xC0 {
                                let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                                f64::from_bits(cpu.sse.xmm[src][0])
                            } else {
                                let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                                f64::from_bits(try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr)))
                            };
                            if lane == LANE64 {
                                cpu.regs[dst] = libm::round(val) as i64 as u64;
                            } else {
                                cpu.regs[dst] = libm::round(val) as i32 as u32 as u64;
                            }
                        }
                    }
                    // CVTPS2PD / CVTSS2SD / CVTPD2PS / CVTSD2SS (0x5A)
                    // Already handled in SSE arith block (0x5A)

                    // CVTDQ2PS / CVTPS2DQ (0x5B) — handled in arith block
                    // CVTPD2DQ / CVTDQ2PD (0xE6) — handled below
                    0xE6 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let (lo, hi) = load_xmm_rm(cpu, ram, ram_size, modrm);
                        if cpu.prefix.op_size {
                            // CVTTPD2DQ: packed double → packed dword (truncate)
                            let d0 = f64::from_bits(lo) as i32;
                            let d1 = f64::from_bits(hi) as i32;
                            cpu.sse.xmm[dst][0] = d0 as u32 as u64 | ((d1 as u32 as u64) << 32);
                            cpu.sse.xmm[dst][1] = 0;
                        } else if cpu.prefix.rep == 0xF3 {
                            // CVTDQ2PD: packed dword → packed double
                            let d0 = lo as u32 as i32 as f64;
                            let d1 = (lo >> 32) as u32 as i32 as f64;
                            cpu.sse.xmm[dst][0] = d0.to_bits();
                            cpu.sse.xmm[dst][1] = d1.to_bits();
                        } else if cpu.prefix.rep == 0xF2 {
                            // CVTPD2DQ: packed double → packed dword (round)
                            let d0 = libm::round(f64::from_bits(lo)) as i32;
                            let d1 = libm::round(f64::from_bits(hi)) as i32;
                            cpu.sse.xmm[dst][0] = d0 as u32 as u64 | ((d1 as u32 as u64) << 32);
                            cpu.sse.xmm[dst][1] = 0;
                        }
                    }

                    // ==========================================================
                    // SSE Control
                    // ==========================================================
                    // EMMS (0x77) — empty MMX state
                    0x77 => {
                        cpu.fpu.tag = 0xFFFF;
                    }

                    // PINSRW (0xC4), PEXTRW (0xC5)
                    0xC4 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let val = if modrm & 0xC0 == 0xC0 {
                            let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                            cpu.regs[r] as u16
                        } else {
                            let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                            try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr))
                        };
                        let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let sel = (imm & 7) as usize;
                        let qword = sel >> 2;
                        let word_in_qword = sel & 3;
                        let shift = word_in_qword * 16;
                        let mask = !(0xFFFFu64 << shift);
                        cpu.sse.xmm[dst][qword] = (cpu.sse.xmm[dst][qword] & mask) | ((val as u64) << shift);
                    }
                    0xC5 => {
                        let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let dst = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                        let src = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                        let sel = (imm & 7) as usize;
                        let qword = sel >> 2;
                        let word_in_qword = sel & 3;
                        let val = (cpu.sse.xmm[src][qword] >> (word_in_qword * 16)) as u16;
                        cpu.regs[dst] = val as u64;
                    }

                    // SWAPGS (0x0F 0x01 /F8) — already handled in 0x01 above
                    // XGETBV (0x0F 0x01 /D0) — TODO
                    _ => {
                        // Unimplemented 0F opcode
                        raise_exception(cpu, EXC_UD, 0);
                    }
                }
            }

            // ============================================================
            // INT3 (0xCC) — breakpoint trap
            // ============================================================
            0xCC | 0x1CC | 0x2CC => {
                // INT3 is a trap: pushed RIP is after the instruction
                deliver_interrupt(cpu, ram, ram_size, EXC_BP, false, 0);
            }

            // ============================================================
            // INT imm8 (0xCD) — software interrupt
            // ============================================================
            0xCD | 0x1CD | 0x2CD => {
                let vector = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                // INT is a trap: pushed RIP is after the instruction (current rip)
                // Don't use raise_exception which rewinds RIP to instr_start
                deliver_interrupt(cpu, ram, ram_size, vector as u32, false, 0);
            }

            // ============================================================
            // IRET/IRETD/IRETQ (0xCF)
            // ============================================================
            0xCF | 0x1CF | 0x2CF => {
                if cpu.long_mode {
                    // 64-bit IRETQ: pop RIP, CS, RFLAGS, RSP, SS
                    let rsp = cpu.regs[RSP];
                    let new_rip = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, rsp));
                    let new_cs = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, rsp + 8));
                    let new_rflags = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, rsp + 16));
                    let new_rsp = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, rsp + 24));
                    let new_ss = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, rsp + 32));

                    let old_cpl = cpu.cpl;
                    let new_cpl = (new_cs as u16 & 3) as u8;

                    // Update RIP
                    cpu.rip = new_rip;

                    // Load CS
                    cpu.segs[SEG_CS].selector = new_cs as u16;
                    cpu.segs[SEG_CS].base = 0; // flat in long mode
                    cpu.segs[SEG_CS].limit = 0xFFFFFFFF;
                    if new_cpl == 3 {
                        cpu.segs[SEG_CS].flags = 0xA0FB; // 64-bit code, DPL 3
                    } else {
                        cpu.segs[SEG_CS].flags = 0xA09B; // 64-bit code, DPL 0
                    }

                    // Restore RFLAGS
                    // CPL 0 can restore all flags; CPL > 0 cannot change IOPL
                    if old_cpl == 0 {
                        cpu.rflags = (new_rflags & 0x3C_7FD7) | 0x2; // mask to valid bits, bit 1 always set
                    } else {
                        let keep = cpu.rflags & IOPL_MASK;
                        cpu.rflags = (new_rflags & !IOPL_MASK & 0x3C_7FD7) | keep | 0x2;
                    }
                    cpu.lazy.op = FlagOp::External;

                    // Load SS
                    cpu.segs[SEG_SS].selector = new_ss as u16;
                    cpu.segs[SEG_SS].base = 0;
                    cpu.segs[SEG_SS].limit = 0xFFFFFFFF;
                    if new_cpl == 3 {
                        cpu.segs[SEG_SS].flags = 0xC0F3; // data, DPL 3
                    } else {
                        cpu.segs[SEG_SS].flags = 0xC093; // data, DPL 0
                    }

                    // Update RSP and CPL
                    cpu.regs[RSP] = new_rsp;
                    cpu.cpl = new_cpl;

                    // Flush TLB on privilege level change
                    if old_cpl != new_cpl {
                        cpu.tlb.flush_all();
                    }

                    cpu.halted = false;
                } else {
                    // 32-bit IRETD: pop EIP, CS, EFLAGS
                    let rsp = cpu.regs[RSP];
                    let new_eip = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, rsp));
                    let new_cs = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, rsp + 4));
                    let new_eflags = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, rsp + 8));

                    cpu.rip = new_eip as u64;
                    cpu.segs[SEG_CS].selector = new_cs as u16;
                    cpu.rflags = (new_eflags as u64 & 0x3C_7FD7) | 0x2;
                    cpu.lazy.op = FlagOp::External;
                    cpu.regs[RSP] = rsp + 12;
                    cpu.halted = false;
                }
            }

            // ============================================================
            // MOVSXD r64, r/m32 (0x63 in 64-bit mode)
            // ============================================================
            0x263 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let dst_reg = ((modrm >> 3) & 7) as usize
                    | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let val = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize
                        | ((cpu.prefix.rex as usize & 1) << 3);
                    cpu.regs[r] as u32
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr))
                };
                cpu.regs[dst_reg] = val as i32 as i64 as u64;
            }

            // ============================================================
            // LEAVE (0xC9)
            // ============================================================
            0xC9 | 0x1C9 | 0x2C9 => {
                cpu.regs[RSP] = cpu.regs[RBP];
                if cpu.long_mode {
                    let val = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(8);
                    cpu.regs[RBP] = val;
                } else {
                    let val = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(4);
                    cpu.regs[RBP] = val as u64;
                }
            }

            // ============================================================
            // CDQE/CWDE/CBW (0x98)
            // ============================================================
            0x98 | 0x198 | 0x298 => {
                match lane {
                    LANE16 => {
                        // CBW: AL -> AX (sign extend)
                        let val = cpu.regs[RAX] as u8 as i8 as i16 as u16;
                        write_reg16(cpu, RAX, val);
                    }
                    LANE32 => {
                        // CWDE: AX -> EAX
                        let val = cpu.regs[RAX] as u16 as i16 as i32 as u32;
                        cpu.regs[RAX] = val as u64;
                    }
                    LANE64 => {
                        // CDQE: EAX -> RAX
                        let val = cpu.regs[RAX] as u32 as i32 as i64 as u64;
                        cpu.regs[RAX] = val;
                    }
                    _ => {}
                }
            }

            // ============================================================
            // CQO/CDQ/CWD (0x99)
            // ============================================================
            0x99 | 0x199 | 0x299 => {
                match lane {
                    LANE16 => {
                        // CWD: AX -> DX:AX
                        let val = cpu.regs[RAX] as i16;
                        write_reg16(cpu, RDX, if val < 0 { 0xFFFF } else { 0 });
                    }
                    LANE32 => {
                        // CDQ: EAX -> EDX:EAX
                        let val = cpu.regs[RAX] as i32;
                        cpu.regs[RDX] = if val < 0 { 0xFFFFFFFF } else { 0 };
                    }
                    LANE64 => {
                        // CQO: RAX -> RDX:RAX
                        let val = cpu.regs[RAX] as i64;
                        cpu.regs[RDX] = if val < 0 { !0u64 } else { 0 };
                    }
                    _ => {}
                }
            }

            // ============================================================
            // ALU Eb,Gb — byte r/m ops (0x00, 0x08, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38)
            // ADD=0x00, OR=0x08, ADC=0x10, SBB=0x18, AND=0x20, SUB=0x28, XOR=0x30, CMP=0x38
            // ============================================================
            0x00 | 0x100 | 0x200 | 0x08 | 0x108 | 0x208 | 0x10 | 0x110 | 0x210 | 0x18 | 0x118 | 0x218 | 0x20 | 0x120 | 0x220 | 0x28 | 0x128 | 0x228 | 0x30 | 0x130 | 0x230 | 0x38 | 0x138 | 0x238 => {
                let alu_op = ((opcode >> 3) & 7) as usize;
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let src = read_reg8(cpu, src_reg);
                if modrm & 0xC0 == 0xC0 {
                    let dst_reg = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    let dst = read_reg8(cpu, dst_reg);
                    let (res, flag_op) = alu_op_b(cpu, alu_op, dst, src);
                    if alu_op != 7 { write_reg8(cpu, dst_reg, res); } // CMP doesn't write
                    set_lazy(cpu, flag_op, dst as u64, res as u64);
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    let dst = try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr));
                    let (res, flag_op) = alu_op_b(cpu, alu_op, dst, src);
                    if alu_op != 7 { try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, res)); }
                    set_lazy(cpu, flag_op, dst as u64, res as u64);
                }
            }

            // ============================================================
            // ALU Ev,Gv — word/dword/qword r/m ops (0x01, 0x09, 0x11, 0x19, 0x21, 0x29, 0x31, 0x39)
            // ============================================================
            0x01 | 0x101 | 0x201 | 0x09 | 0x109 | 0x209 | 0x11 | 0x111 | 0x211 | 0x19 | 0x119 | 0x219 | 0x21 | 0x121 | 0x221 | 0x29 | 0x129 | 0x229 | 0x31 | 0x131 | 0x231 | 0x39 | 0x139 | 0x239 => {
                let alu_op = ((opcode >> 3) & 7) as usize;
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                if modrm & 0xC0 == 0xC0 {
                    let dst_reg = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    alu_ev_gv_reg(cpu, alu_op, dst_reg, src_reg, lane);
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    alu_ev_gv_mem(cpu, ram, ram_size, alu_op, addr, src_reg, lane);
                }
            }

            // ============================================================
            // ALU Gb,Eb — byte r/m ops (0x02, 0x0A, 0x12, 0x1A, 0x22, 0x2A, 0x32, 0x3A)
            // ============================================================
            0x02 | 0x102 | 0x202 | 0x0A | 0x10A | 0x20A | 0x12 | 0x112 | 0x212 | 0x1A | 0x11A | 0x21A | 0x22 | 0x122 | 0x222 | 0x2A | 0x12A | 0x22A | 0x32 | 0x132 | 0x232 | 0x3A | 0x13A | 0x23A => {
                let alu_op = ((opcode >> 3) & 7) as usize;
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let src = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    read_reg8(cpu, r)
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr))
                };
                let dst = read_reg8(cpu, dst_reg);
                let (res, flag_op) = alu_op_b(cpu, alu_op, dst, src);
                if alu_op != 7 { write_reg8(cpu, dst_reg, res); }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }

            // ============================================================
            // ALU Gv,Ev — word/dword/qword (0x03, 0x0B, 0x13, 0x1B, 0x23, 0x2B, 0x33, 0x3B)
            // ============================================================
            0x03 | 0x103 | 0x203 | 0x0B | 0x10B | 0x20B | 0x13 | 0x113 | 0x213 | 0x1B | 0x11B | 0x21B | 0x23 | 0x123 | 0x223 | 0x2B | 0x12B | 0x22B | 0x33 | 0x133 | 0x233 | 0x3B | 0x13B | 0x23B => {
                let alu_op = ((opcode >> 3) & 7) as usize;
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let src = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    cpu.regs[r]
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    match lane {
                        LANE16 => try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr)) as u64,
                        LANE32 => try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr)) as u64,
                        _ => try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr)),
                    }
                };
                alu_gv_ev(cpu, alu_op, dst_reg, src, lane);
            }

            // ============================================================
            // ALU AL, imm8 (0x04, 0x0C, 0x14, 0x1C, 0x24, 0x34 already handled above)
            // ADC AL (0x14), SBB AL (0x1C)
            // ============================================================
            0x14 | 0x114 | 0x214 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let lhs = cpu.regs[RAX] as u8;
                let cf = flags::get_cf(cpu) as u8;
                let res = lhs.wrapping_add(imm).wrapping_add(cf);
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::AdcB, lhs as u64, res as u64);
            }
            0x1C | 0x11C | 0x21C => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let lhs = cpu.regs[RAX] as u8;
                let cf = flags::get_cf(cpu) as u8;
                let res = lhs.wrapping_sub(imm).wrapping_sub(cf);
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::SbbB, lhs as u64, res as u64);
            }

            // ============================================================
            // ALU rAX, imm16/32 for remaining ops (AND=0x25, OR=0x0D, XOR=0x35 already handled)
            // ADC rAX (0x15), SBB rAX (0x1D)
            // ============================================================
            0x15 | 0x115 | 0x215 => {
                let cf = flags::get_cf(cpu) as u64;
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size)) as u64;
                        let lhs = cpu.regs[RAX] & 0xFFFF;
                        let res = (lhs.wrapping_add(imm).wrapping_add(cf)) & 0xFFFF;
                        write_reg16(cpu, RAX, res as u16);
                        set_lazy(cpu, FlagOp::AdcW, lhs, res);
                    }
                    LANE32 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as u64;
                        let lhs = cpu.regs[RAX] & 0xFFFFFFFF;
                        let res = (lhs.wrapping_add(imm).wrapping_add(cf)) & 0xFFFFFFFF;
                        cpu.regs[RAX] = res;
                        set_lazy(cpu, FlagOp::AdcL, lhs, res);
                    }
                    LANE64 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as u64;
                        let lhs = cpu.regs[RAX];
                        let res = lhs.wrapping_add(imm).wrapping_add(cf);
                        cpu.regs[RAX] = res;
                        set_lazy(cpu, FlagOp::AdcQ, lhs, res);
                    }
                    _ => {}
                }
            }
            0x1D | 0x11D | 0x21D => {
                let cf = flags::get_cf(cpu) as u64;
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size)) as u64;
                        let lhs = cpu.regs[RAX] & 0xFFFF;
                        let res = (lhs.wrapping_sub(imm).wrapping_sub(cf)) & 0xFFFF;
                        write_reg16(cpu, RAX, res as u16);
                        set_lazy(cpu, FlagOp::SbbW, lhs, res);
                    }
                    LANE32 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as u64;
                        let lhs = cpu.regs[RAX] & 0xFFFFFFFF;
                        let res = (lhs.wrapping_sub(imm).wrapping_sub(cf)) & 0xFFFFFFFF;
                        cpu.regs[RAX] = res;
                        set_lazy(cpu, FlagOp::SbbL, lhs, res);
                    }
                    LANE64 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as u64;
                        let lhs = cpu.regs[RAX];
                        let res = lhs.wrapping_sub(imm).wrapping_sub(cf);
                        cpu.regs[RAX] = res;
                        set_lazy(cpu, FlagOp::SbbQ, lhs, res);
                    }
                    _ => {}
                }
            }

            // AND rAX, imm (0x25), OR rAX, imm (0x0D), XOR rAX, imm (0x35)
            0x25 | 0x125 | 0x225 | 0x0D | 0x10D | 0x20D | 0x35 | 0x135 | 0x235 => {
                let op_byte = opcode;
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size));
                        let lhs = cpu.regs[RAX] as u16;
                        let (res, fop) = match op_byte {
                            0x25 => (lhs & imm, FlagOp::AndW),
                            0x0D => (lhs | imm, FlagOp::OrW),
                            _ => (lhs ^ imm, FlagOp::XorW),
                        };
                        write_reg16(cpu, RAX, res);
                        set_lazy(cpu, fop, 0, res as u64);
                    }
                    LANE32 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size));
                        let lhs = cpu.regs[RAX] as u32;
                        let (res, fop) = match op_byte {
                            0x25 => (lhs & imm, FlagOp::AndL),
                            0x0D => (lhs | imm, FlagOp::OrL),
                            _ => (lhs ^ imm, FlagOp::XorL),
                        };
                        cpu.regs[RAX] = res as u64;
                        set_lazy(cpu, fop, 0, res as u64);
                    }
                    LANE64 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as u64;
                        let lhs = cpu.regs[RAX];
                        let (res, fop) = match op_byte {
                            0x25 => (lhs & imm, FlagOp::AndQ),
                            0x0D => (lhs | imm, FlagOp::OrQ),
                            _ => (lhs ^ imm, FlagOp::XorQ),
                        };
                        cpu.regs[RAX] = res;
                        set_lazy(cpu, fop, 0, res);
                    }
                    _ => {}
                }
            }

            // TEST rAX, imm (0xA9)
            0xA9 | 0x1A9 | 0x2A9 => {
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size));
                        let res = cpu.regs[RAX] as u16 & imm;
                        set_lazy(cpu, FlagOp::AndW, 0, res as u64);
                    }
                    LANE32 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size));
                        let res = cpu.regs[RAX] as u32 & imm;
                        set_lazy(cpu, FlagOp::AndL, 0, res as u64);
                    }
                    LANE64 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as u64;
                        let res = cpu.regs[RAX] & imm;
                        set_lazy(cpu, FlagOp::AndQ, 0, res);
                    }
                    _ => {}
                }
            }

            // ============================================================
            // TEST r/m, r (0x84 byte, 0x85 word/dword/qword)
            // ============================================================
            0x84 | 0x184 | 0x284 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let src = read_reg8(cpu, ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3);
                let dst = if modrm & 0xC0 == 0xC0 {
                    read_reg8(cpu, (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3))
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr))
                };
                set_lazy(cpu, FlagOp::AndB, 0, (dst & src) as u64);
            }
            0x85 | 0x185 | 0x285 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let src_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let (dst, res_fop) = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    (cpu.regs[r], 0u8)
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    let v = match lane {
                        LANE16 => try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr)) as u64,
                        LANE32 => try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr)) as u64,
                        _ => try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr)),
                    };
                    (v, 0u8)
                };
                let _ = res_fop;
                let src = cpu.regs[src_reg];
                match lane {
                    LANE16 => set_lazy(cpu, FlagOp::AndW, 0, (dst as u16 & src as u16) as u64),
                    LANE32 => set_lazy(cpu, FlagOp::AndL, 0, (dst as u32 & src as u32) as u64),
                    _ => set_lazy(cpu, FlagOp::AndQ, 0, dst & src),
                }
            }

            // ============================================================
            // XCHG r/m, r (0x86 byte, 0x87 word/dword/qword)
            // ============================================================
            0x86 | 0x186 | 0x286 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                if modrm & 0xC0 == 0xC0 {
                    let rm = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    let a = read_reg8(cpu, reg);
                    let b = read_reg8(cpu, rm);
                    write_reg8(cpu, reg, b);
                    write_reg8(cpu, rm, a);
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    let mem_val = try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr));
                    let reg_val = read_reg8(cpu, reg);
                    write_reg8(cpu, reg, mem_val);
                    try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, reg_val));
                }
            }
            0x87 | 0x187 | 0x287 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                if modrm & 0xC0 == 0xC0 {
                    let rm = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    let a = cpu.regs[reg];
                    let b = cpu.regs[rm];
                    match lane {
                        LANE16 => { write_reg16(cpu, reg, b as u16); write_reg16(cpu, rm, a as u16); }
                        LANE32 => { cpu.regs[reg] = b as u32 as u64; cpu.regs[rm] = a as u32 as u64; }
                        _ => { cpu.regs[reg] = b; cpu.regs[rm] = a; }
                    }
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    match lane {
                        LANE16 => {
                            let v = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr));
                            try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, cpu.regs[reg] as u16));
                            write_reg16(cpu, reg, v);
                        }
                        LANE32 => {
                            let v = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr));
                            try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, cpu.regs[reg] as u32));
                            cpu.regs[reg] = v as u64;
                        }
                        _ => {
                            let v = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                            try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.regs[reg]));
                            cpu.regs[reg] = v;
                        }
                    }
                }
            }

            // ============================================================
            // GRP1 Eb, imm8 (0x80)
            // ============================================================
            0x80 | 0x180 | 0x280 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let alu_op = ((modrm >> 3) & 7) as usize;
                let (dst, addr) = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    (read_reg8(cpu, r), 0u64)
                } else {
                    let a = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    (try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, a)), a)
                };
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let (res, flag_op) = alu_op_b(cpu, alu_op, dst, imm);
                if alu_op != 7 { // not CMP
                    if modrm & 0xC0 == 0xC0 {
                        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        write_reg8(cpu, r, res);
                    } else {
                        try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, res));
                    }
                }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }

            // ============================================================
            // GRP1 Ev, imm16/32 (0x81)
            // ============================================================
            0x81 | 0x181 | 0x281 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let alu_op = ((modrm >> 3) & 7) as usize;
                grp1_ev_imm(cpu, ram, ram_size, modrm, alu_op, lane, false);
            }

            // ============================================================
            // GRP1 Eb, imm8 (0x82 — alias of 0x80 in 32-bit mode)
            // ============================================================
            0x82 | 0x182 | 0x282 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let alu_op = ((modrm >> 3) & 7) as usize;
                let (dst, addr) = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    (read_reg8(cpu, r), 0u64)
                } else {
                    let a = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    (try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, a)), a)
                };
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let (res, flag_op) = alu_op_b(cpu, alu_op, dst, imm);
                if alu_op != 7 {
                    if modrm & 0xC0 == 0xC0 {
                        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        write_reg8(cpu, r, res);
                    } else {
                        try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, res));
                    }
                }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }

            // ============================================================
            // GRP1 Ev, imm8 sign-extended (0x83)
            // ============================================================
            0x83 | 0x183 | 0x283 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let alu_op = ((modrm >> 3) & 7) as usize;
                grp1_ev_imm(cpu, ram, ram_size, modrm, alu_op, lane, true);
            }

            // ============================================================
            // GRP2 — shifts and rotates
            // 0xC0: Eb, imm8 | 0xC1: Ev, imm8
            // 0xD0: Eb, 1    | 0xD1: Ev, 1
            // 0xD2: Eb, CL   | 0xD3: Ev, CL
            // ============================================================
            0xC0 | 0x1C0 | 0x2C0 | 0xD0 | 0x1D0 | 0x2D0 | 0xD2 | 0x1D2 | 0x2D2 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let shift_op = ((modrm >> 3) & 7) as usize;
                let (dst, addr) = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    (read_reg8(cpu, r), 0u64)
                } else {
                    let a = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    (try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, a)), a)
                };
                let count = match opcode {
                    0xC0 => try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) & 0x1F,
                    0xD0 => 1,
                    _ => cpu.regs[RCX] as u8 & 0x1F,
                };
                if count != 0 {
                    let res = shift_op_b(cpu, shift_op, dst, count);
                    if modrm & 0xC0 == 0xC0 {
                        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        write_reg8(cpu, r, res);
                    } else {
                        try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, res));
                    }
                }
            }
            0xC1 | 0x1C1 | 0x2C1 | 0xD1 | 0x1D1 | 0x2D1 | 0xD3 | 0x1D3 | 0x2D3 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let shift_op = ((modrm >> 3) & 7) as usize;
                let count_raw = match opcode {
                    0xC1 => try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)),
                    0xD1 => 1,
                    _ => cpu.regs[RCX] as u8,
                };
                grp2_ev(cpu, ram, ram_size, modrm, shift_op, count_raw, lane);
            }

            // ============================================================
            // GRP3 — TEST/NOT/NEG/MUL/IMUL/DIV/IDIV
            // 0xF6: Eb  | 0xF7: Ev
            // ============================================================
            0xF6 | 0x1F6 | 0x2F6 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                grp3_eb(cpu, ram, ram_size, modrm);
            }
            0xF7 | 0x1F7 | 0x2F7 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                grp3_ev(cpu, ram, ram_size, modrm, lane);
            }

            // ============================================================
            // INC/DEC r (0x40-0x47/0x48-0x4F) — 32-bit mode only (REX in 64-bit)
            // In 64-bit mode these are REX prefixes, handled in prefix loop
            // ============================================================

            // ============================================================
            // GRP4 — INC/DEC Eb (0xFE)
            // ============================================================
            0xFE | 0x1FE | 0x2FE => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let op = (modrm >> 3) & 7;
                let (dst, addr) = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    (read_reg8(cpu, r), 0u64)
                } else {
                    let a = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    (try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, a)), a)
                };
                let (res, fop) = if op == 0 {
                    (dst.wrapping_add(1), FlagOp::IncB)
                } else {
                    (dst.wrapping_sub(1), FlagOp::DecB)
                };
                if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    write_reg8(cpu, r, res);
                } else {
                    try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, res));
                }
                set_lazy(cpu, fop, dst as u64, res as u64);
            }

            // ============================================================
            // GRP5 — INC/DEC/CALL/JMP/PUSH Ev (0xFF)
            // ============================================================
            0xFF | 0x1FF | 0x2FF => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                grp5(cpu, ram, ram_size, modrm, lane);
            }

            // ============================================================
            // PUSHF (0x9C), POPF (0x9D)
            // ============================================================
            0x9C | 0x19C | 0x29C => {
                materialize_flags(cpu);
                let flags = cpu.rflags & 0x00000000003F7FD5; // mask off reserved bits
                if cpu.long_mode {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                    try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], flags));
                } else {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                    try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], flags as u32));
                }
            }
            0x9D | 0x19D | 0x29D => {
                let flags = if cpu.long_mode {
                    let v = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(8);
                    v
                } else {
                    let v = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(4);
                    v as u64
                };
                let mask = CF | PF | AF | ZF | SF | TF | IF | DF | OF | AC;
                cpu.rflags = (cpu.rflags & !mask) | (flags & mask) | 0x02;
                cpu.lazy.op = FlagOp::External;
            }

            // ============================================================
            // SAHF (0x9E) — Store AH into flags
            // LAHF (0x9F) — Load flags into AH
            // ============================================================
            0x9E | 0x19E | 0x29E => {
                // SAHF: AH → lower 8 bits of EFLAGS
                let ah = (cpu.regs[RAX] >> 8) as u8;
                cpu.rflags = (cpu.rflags & !0xFF) | (ah as u64 & (CF | PF | AF | ZF | SF)) | 0x02;
                cpu.lazy.op = FlagOp::External;
            }
            0x9F | 0x19F | 0x29F => {
                // LAHF: lower 8 bits of EFLAGS → AH
                materialize_flags(cpu);
                let ah = (cpu.rflags & 0xFF) as u8;
                cpu.regs[RAX] = (cpu.regs[RAX] & !0xFF00) | ((ah as u64) << 8);
            }

            // ============================================================
            // I/O instructions — IN/OUT
            // IN AL, imm8 (0xE4) | IN AL, DX (0xEC)
            // IN eAX, imm8 (0xE5) | IN eAX, DX (0xED)
            // OUT imm8, AL (0xE6) | OUT DX, AL (0xEE)
            // OUT imm8, eAX (0xE7) | OUT DX, eAX (0xEF)
            // ============================================================
            0xE4 | 0x1E4 | 0x2E4 => {
                let port = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as u16;
                let val = crate::pic::io_read(cpu, ram, ram_size, port, 1);
                write_reg8_al(cpu, val as u8);
            }
            0xEC | 0x1EC | 0x2EC => {
                let port = cpu.regs[RDX] as u16;
                let val = crate::pic::io_read(cpu, ram, ram_size, port, 1);
                write_reg8_al(cpu, val as u8);
            }
            0xE5 | 0x1E5 | 0x2E5 => {
                let port = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as u16;
                let size = if lane == LANE16 { 2u8 } else { 4u8 };
                let val = crate::pic::io_read(cpu, ram, ram_size, port, size);
                match lane {
                    LANE16 => write_reg16(cpu, RAX, val as u16),
                    _ => cpu.regs[RAX] = val as u64,
                }
            }
            0xED | 0x1ED | 0x2ED => {
                let port = cpu.regs[RDX] as u16;
                let size = if lane == LANE16 { 2u8 } else { 4u8 };
                let val = crate::pic::io_read(cpu, ram, ram_size, port, size);
                match lane {
                    LANE16 => write_reg16(cpu, RAX, val as u16),
                    _ => cpu.regs[RAX] = val as u64,
                }
            }
            0xE6 | 0x1E6 | 0x2E6 => {
                let port = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as u16;
                crate::pic::io_write(cpu, ram, ram_size, port, cpu.regs[RAX] as u32 & 0xFF, 1);
            }
            0xEE | 0x1EE | 0x2EE => {
                let port = cpu.regs[RDX] as u16;
                crate::pic::io_write(cpu, ram, ram_size, port, cpu.regs[RAX] as u32 & 0xFF, 1);
            }
            0xE7 | 0x1E7 | 0x2E7 => {
                let port = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as u16;
                let size = if lane == LANE16 { 2u8 } else { 4u8 };
                crate::pic::io_write(cpu, ram, ram_size, port, cpu.regs[RAX] as u32, size);
            }
            0xEF | 0x1EF | 0x2EF => {
                let port = cpu.regs[RDX] as u16;
                let size = if lane == LANE16 { 2u8 } else { 4u8 };
                crate::pic::io_write(cpu, ram, ram_size, port, cpu.regs[RAX] as u32, size);
            }

            // ============================================================
            // MOV moffs — MOV AL,moffs8 (0xA0), MOV rAX,moffs (0xA1)
            //              MOV moffs8,AL (0xA2), MOV moffs,rAX (0xA3)
            // ============================================================
            0xA0 | 0x1A0 | 0x2A0 => {
                let addr = if cpu.long_mode && !cpu.prefix.addr_size {
                    try_or_fault!(cpu, fetch_imm64(cpu, ram, ram_size))
                } else {
                    try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as u64
                };
                let val = try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr));
                write_reg8_al(cpu, val);
            }
            0xA1 | 0x1A1 | 0x2A1 => {
                let addr = if cpu.long_mode && !cpu.prefix.addr_size {
                    try_or_fault!(cpu, fetch_imm64(cpu, ram, ram_size))
                } else {
                    try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as u64
                };
                match lane {
                    LANE16 => {
                        let v = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr));
                        write_reg16(cpu, RAX, v);
                    }
                    LANE32 => {
                        let v = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr));
                        cpu.regs[RAX] = v as u64;
                    }
                    _ => {
                        let v = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr));
                        cpu.regs[RAX] = v;
                    }
                }
            }
            0xA2 | 0x1A2 | 0x2A2 => {
                let addr = if cpu.long_mode && !cpu.prefix.addr_size {
                    try_or_fault!(cpu, fetch_imm64(cpu, ram, ram_size))
                } else {
                    try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as u64
                };
                try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, cpu.regs[RAX] as u8));
            }
            0xA3 | 0x1A3 | 0x2A3 => {
                let addr = if cpu.long_mode && !cpu.prefix.addr_size {
                    try_or_fault!(cpu, fetch_imm64(cpu, ram, ram_size))
                } else {
                    try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as u64
                };
                match lane {
                    LANE16 => try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, cpu.regs[RAX] as u16)),
                    LANE32 => try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, cpu.regs[RAX] as u32)),
                    _ => try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, cpu.regs[RAX])),
                }
            }

            // ============================================================
            // String operations (0xA4-0xA7, 0xAA-0xAF)
            // ============================================================
            0xA4 | 0x1A4 | 0x2A4 => { string_movsb(cpu, ram, ram_size); }
            0xA5 | 0x1A5 | 0x2A5 => { string_movs(cpu, ram, ram_size, lane); }
            0xA6 | 0x1A6 | 0x2A6 => { string_cmpsb(cpu, ram, ram_size); }
            0xA7 | 0x1A7 | 0x2A7 => { string_cmps(cpu, ram, ram_size, lane); }
            0xAA | 0x1AA | 0x2AA => { string_stosb(cpu, ram, ram_size); }
            0xAB | 0x1AB | 0x2AB => { string_stos(cpu, ram, ram_size, lane); }
            0xAC | 0x1AC | 0x2AC => { string_lodsb(cpu, ram, ram_size); }
            0xAD | 0x1AD | 0x2AD => { string_lods(cpu, ram, ram_size, lane); }
            0xAE | 0x1AE | 0x2AE => { string_scasb(cpu, ram, ram_size); }
            0xAF | 0x1AF | 0x2AF => { string_scas(cpu, ram, ram_size, lane); }

            // ============================================================
            // RET imm16 (0xC2)
            // ============================================================
            0xC2 | 0x1C2 | 0x2C2 => {
                let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size)) as u64;
                if cpu.long_mode {
                    let addr = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(8).wrapping_add(imm);
                    cpu.rip = addr;
                } else {
                    let addr = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(4).wrapping_add(imm);
                    cpu.rip = addr as u64;
                }
            }

            // ============================================================
            // CALL rel16 (0xE8 with 0x66 prefix) — rare but possible
            // Already handled above for rel32

            // IMUL r, r/m (0x0F 0xAF) and IMUL r, r/m, imm (0x69/0x6B)
            // ============================================================
            0x69 | 0x169 | 0x269 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let src = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    cpu.regs[r]
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    match lane {
                        LANE16 => try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr)) as u64,
                        LANE32 => try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr)) as u64,
                        _ => try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr)),
                    }
                };
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size)) as i16 as i32;
                        let res = (src as i16 as i32).wrapping_mul(imm);
                        write_reg16(cpu, dst_reg, res as u16);
                        let overflow = res != res as i16 as i32;
                        if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                        cpu.lazy.op = FlagOp::External;
                    }
                    LANE32 => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as i64;
                        let res = (src as i32 as i64).wrapping_mul(imm);
                        cpu.regs[dst_reg] = res as u32 as u64;
                        let overflow = res != res as i32 as i64;
                        if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                        cpu.lazy.op = FlagOp::External;
                    }
                    _ => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as i64;
                        let res = (src as i64 as i128).wrapping_mul(imm as i128);
                        cpu.regs[dst_reg] = res as u64;
                        let overflow = res != res as i64 as i128;
                        if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                        cpu.lazy.op = FlagOp::External;
                    }
                }
            }
            0x6B | 0x16B | 0x26B => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let dst_reg = ((modrm >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 2) & 1) << 3;
                let src = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    cpu.regs[r]
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    match lane {
                        LANE16 => try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr)) as u64,
                        LANE32 => try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, addr)) as u64,
                        _ => try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, addr)),
                    }
                };
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                match lane {
                    LANE16 => {
                        let res = (src as i16 as i32).wrapping_mul(imm as i32);
                        write_reg16(cpu, dst_reg, res as u16);
                        let overflow = res != res as i16 as i32;
                        if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    }
                    LANE32 => {
                        let res = (src as i32 as i64).wrapping_mul(imm as i64);
                        cpu.regs[dst_reg] = res as u32 as u64;
                        let overflow = res != res as i32 as i64;
                        if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    }
                    _ => {
                        let res = (src as i64 as i128).wrapping_mul(imm as i128);
                        cpu.regs[dst_reg] = res as u64;
                        let overflow = res != res as i64 as i128;
                        if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    }
                }
                cpu.lazy.op = FlagOp::External;
            }

            // ============================================================
            // ENTER (0xC8)
            // ============================================================
            0xC8 | 0x1C8 | 0x2C8 => {
                let alloc_size = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size)) as u64;
                let _nesting = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                // Simplified: nesting level 0 only
                if cpu.long_mode {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                    try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], cpu.regs[RBP]));
                    cpu.regs[RBP] = cpu.regs[RSP];
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(alloc_size);
                } else {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                    try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], cpu.regs[RBP] as u32));
                    cpu.regs[RBP] = cpu.regs[RSP] & 0xFFFFFFFF;
                    cpu.regs[RSP] = (cpu.regs[RSP].wrapping_sub(alloc_size)) & 0xFFFFFFFF;
                }
            }

            // ============================================================
            // PUSH imm8/imm16/imm32 (0x6A, 0x68)
            // ============================================================
            0x6A | 0x16A | 0x26A => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8 as i64 as u64;
                if cpu.long_mode {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                    try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], imm));
                } else {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                    try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], imm as u32));
                }
            }
            0x68 | 0x168 | 0x268 => {
                match lane {
                    LANE16 => {
                        let imm = try_or_fault!(cpu, fetch_imm16(cpu, ram, ram_size)) as u64;
                        cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(2);
                        try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, cpu.regs[RSP], imm as u16));
                    }
                    _ => {
                        let imm = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32 as i64 as u64;
                        if cpu.long_mode {
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                            try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], imm));
                        } else {
                            cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                            try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], imm as u32));
                        }
                    }
                }
            }

            // ============================================================
            // LOOP/LOOPcc (0xE0-0xE2)
            // ============================================================
            0xE2 | 0x1E2 | 0x2E2 => {
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
                if cpu.regs[RCX] != 0 {
                    cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                }
            }
            0xE0 | 0x1E0 | 0x2E0 => {
                // LOOPNZ
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
                if cpu.regs[RCX] != 0 && !eval_cc(cpu, 4) { // ZF==0
                    cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                }
            }
            0xE1 | 0x1E1 | 0x2E1 => {
                // LOOPZ
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
                if cpu.regs[RCX] != 0 && eval_cc(cpu, 4) { // ZF==1
                    cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                }
            }

            // ============================================================
            // CALL rel16 (0xE8 with 0x66 prefix — already handled)
            // JMP short (0xEB — already handled)
            // Jcc rel8 (0x70-0x7F — already handled)
            // ============================================================

            // ============================================================
            // MOV segment (0x8C, 0x8E)
            // ============================================================
            0x8C | 0x18C | 0x28C => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let seg = ((modrm >> 3) & 7) as usize;
                let val = if seg < 6 { cpu.segs[seg].selector } else { 0 };
                if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    write_reg16(cpu, r, val);
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, addr, val));
                }
            }
            0x8E | 0x18E | 0x28E => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let seg = ((modrm >> 3) & 7) as usize;
                let val = if modrm & 0xC0 == 0xC0 {
                    let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                    cpu.regs[r] as u16
                } else {
                    let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                    try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, addr))
                };
                if seg < 6 {
                    cpu.segs[seg].selector = val;
                    // In long mode, only FS/GS base matters; others are effectively flat
                }
            }

            // ============================================================
            // POP r/m (0x8F /0)
            // ============================================================
            0x8F | 0x18F | 0x28F => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let reg_field = (modrm >> 3) & 7;
                if reg_field != 0 { raise_exception(cpu, EXC_UD, 0); continue; }
                if cpu.long_mode {
                    let val = try_or_fault!(cpu, mem::load_u64(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(8);
                    if modrm & 0xC0 == 0xC0 {
                        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        cpu.regs[r] = val;
                    } else {
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, addr, val));
                    }
                } else {
                    let val = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, cpu.regs[RSP]));
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_add(4);
                    if modrm & 0xC0 == 0xC0 {
                        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
                        cpu.regs[r] = val as u64;
                    } else {
                        let addr = try_or_fault!(cpu, decode_modrm_addr(cpu, ram, ram_size, modrm));
                        try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, addr, val));
                    }
                }
            }

            // ============================================================
            // XLAT/XLATB (0xD7) — AL = [RBX + unsigned(AL)]
            // ============================================================
            0xD7 | 0x1D7 | 0x2D7 => {
                let addr = cpu.regs[RBX].wrapping_add(cpu.regs[RAX] & 0xFF);
                let val = try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr));
                write_reg8_al(cpu, val);
            }

            // ============================================================
            // JCXZ/JECXZ/JRCXZ (0xE3) — Jump if counter is zero
            // ============================================================
            0xE3 | 0x1E3 | 0x2E3 => {
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                let counter = if cpu.prefix.addr_size {
                    cpu.regs[RCX] as u32 as u64
                } else {
                    cpu.regs[RCX]
                };
                if counter == 0 {
                    cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                    if !cpu.long_mode { cpu.rip &= 0xFFFFFFFF; }
                }
            }

            // ============================================================
            // String I/O: INSB (0x6C), INSW/D (0x6D), OUTSB (0x6E), OUTSW/D (0x6F)
            // ============================================================
            0x6C | 0x16C | 0x26C => {
                // INSB: read byte from port DX, store to [RDI]
                let port = cpu.regs[RDX] as u16;
                let val = crate::pic::io_read(cpu, ram, ram_size, port, 1) as u8;
                try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, cpu.regs[RDI], val));
                let df = (cpu.rflags & DF) != 0;
                if df { cpu.regs[RDI] = cpu.regs[RDI].wrapping_sub(1); }
                else { cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(1); }
            }
            0x6D | 0x16D | 0x26D => {
                // INSW/D: read word/dword from port DX, store to [RDI]
                let port = cpu.regs[RDX] as u16;
                let size = if lane == LANE16 { 2u8 } else { 4u8 };
                let val = crate::pic::io_read(cpu, ram, ram_size, port, size);
                if lane == LANE16 {
                    try_or_fault!(cpu, mem::store_u16(cpu, ram, ram_size, cpu.regs[RDI], val as u16));
                    let df = (cpu.rflags & DF) != 0;
                    if df { cpu.regs[RDI] = cpu.regs[RDI].wrapping_sub(2); }
                    else { cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(2); }
                } else {
                    try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RDI], val));
                    let df = (cpu.rflags & DF) != 0;
                    if df { cpu.regs[RDI] = cpu.regs[RDI].wrapping_sub(4); }
                    else { cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(4); }
                }
            }
            0x6E | 0x16E | 0x26E => {
                // OUTSB: read byte from [RSI], write to port DX
                let port = cpu.regs[RDX] as u16;
                let val = try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, cpu.regs[RSI]));
                crate::pic::io_write(cpu, ram, ram_size, port, val as u32, 1);
                let df = (cpu.rflags & DF) != 0;
                if df { cpu.regs[RSI] = cpu.regs[RSI].wrapping_sub(1); }
                else { cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(1); }
            }
            0x6F | 0x16F | 0x26F => {
                // OUTSW/D: read word/dword from [RSI], write to port DX
                let port = cpu.regs[RDX] as u16;
                if lane == LANE16 {
                    let val = try_or_fault!(cpu, mem::load_u16(cpu, ram, ram_size, cpu.regs[RSI]));
                    crate::pic::io_write(cpu, ram, ram_size, port, val as u32, 2);
                    let df = (cpu.rflags & DF) != 0;
                    if df { cpu.regs[RSI] = cpu.regs[RSI].wrapping_sub(2); }
                    else { cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(2); }
                } else {
                    let val = try_or_fault!(cpu, mem::load_u32(cpu, ram, ram_size, cpu.regs[RSI]));
                    crate::pic::io_write(cpu, ram, ram_size, port, val, 4);
                    let df = (cpu.rflags & DF) != 0;
                    if df { cpu.regs[RSI] = cpu.regs[RSI].wrapping_sub(4); }
                    else { cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(4); }
                }
            }

            // ============================================================
            // FWAIT (0x9B) — no-op (single-threaded, no pending FPU exceptions)
            // ============================================================
            0x9B | 0x19B | 0x29B => {}

            // ============================================================
            // x87 FPU opcodes D8-DF
            // ============================================================
            0xD8 | 0x1D8 | 0x2D8 | 0xD9 | 0x1D9 | 0x2D9 |
            0xDA | 0x1DA | 0x2DA | 0xDB | 0x1DB | 0x2DB |
            0xDC | 0x1DC | 0x2DC | 0xDD | 0x1DD | 0x2DD |
            0xDE | 0x1DE | 0x2DE | 0xDF | 0x1DF | 0x2DF => {
                let fpu_op = (opcode & 7) as u8; // 0-7 maps to D8-DF
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                exec_fpu(cpu, ram, ram_size, fpu_op, modrm);
            }

            // ============================================================
            // Default: unimplemented opcode → #UD
            // ============================================================
            _ => {
                raise_exception(cpu, EXC_UD, 0);
            }
        }
    }
}

// ============================================================
// ALU operation enum for helper functions
// ============================================================
#[derive(Copy, Clone, PartialEq)]
enum AluOp { Add, Or, Adc, Sbb, And, Sub, Xor, Cmp, Test }

/// Load r/m value for the current operand size lane.
#[inline(always)]
unsafe fn load_rm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32) -> u64 {
    if modrm & 0xC0 == 0xC0 {
        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
        match lane {
            LANE16 => cpu.regs[r] & 0xFFFF,
            LANE32 => cpu.regs[r] & 0xFFFFFFFF,
            _ => cpu.regs[r],
        }
    } else {
        let addr = decode_modrm_addr(cpu, ram, ram_size, modrm).unwrap_or(0);
        match lane {
            LANE16 => mem::load_u16(cpu, ram, ram_size, addr).unwrap_or(0) as u64,
            LANE32 => mem::load_u32(cpu, ram, ram_size, addr).unwrap_or(0) as u64,
            _ => mem::load_u64(cpu, ram, ram_size, addr).unwrap_or(0),
        }
    }
}

/// ALU op: r/m ← r/m OP r (ModR/M form, destination is r/m)
#[inline(always)]
unsafe fn alu_op_rm_r(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32, op: AluOp, src: u64) {
    if modrm & 0xC0 == 0xC0 {
        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
        match lane {
            LANE16 => {
                let dst = cpu.regs[r] as u16;
                let (res, flag_op) = do_alu16(dst, src as u16, op);
                if op != AluOp::Cmp && op != AluOp::Test { write_reg16(cpu, r, res); }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }
            LANE32 => {
                let dst = cpu.regs[r] as u32;
                let (res, flag_op) = do_alu32(dst, src as u32, op);
                if op != AluOp::Cmp && op != AluOp::Test { cpu.regs[r] = res as u64; }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }
            LANE64 => {
                let dst = cpu.regs[r];
                let (res, flag_op) = do_alu64(dst, src, op);
                if op != AluOp::Cmp && op != AluOp::Test { cpu.regs[r] = res; }
                set_lazy(cpu, flag_op, dst, res);
            }
            _ => {}
        }
    } else {
        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) {
            Ok(a) => a,
            Err(_) => { raise_exception(cpu, EXC_PF, 0); return; }
        };
        match lane {
            LANE16 => {
                let dst = mem::load_u16(cpu, ram, ram_size, addr).unwrap_or(0);
                let (res, flag_op) = do_alu16(dst, src as u16, op);
                if op != AluOp::Cmp && op != AluOp::Test {
                    let _ = mem::store_u16(cpu, ram, ram_size, addr, res);
                }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }
            LANE32 => {
                let dst = mem::load_u32(cpu, ram, ram_size, addr).unwrap_or(0);
                let (res, flag_op) = do_alu32(dst, src as u32, op);
                if op != AluOp::Cmp && op != AluOp::Test {
                    let _ = mem::store_u32(cpu, ram, ram_size, addr, res);
                }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }
            LANE64 => {
                let dst = mem::load_u64(cpu, ram, ram_size, addr).unwrap_or(0);
                let (res, flag_op) = do_alu64(dst, src, op);
                if op != AluOp::Cmp && op != AluOp::Test {
                    let _ = mem::store_u64(cpu, ram, ram_size, addr, res);
                }
                set_lazy(cpu, flag_op, dst, res);
            }
            _ => {}
        }
    }
}

/// ALU op: r ← r OP r/m (ModR/M form, destination is reg)
#[inline(always)]
unsafe fn alu_op_r_rm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32, op: AluOp, dst_reg: usize) {
    let src = load_rm(cpu, ram, ram_size, modrm, lane);
    match lane {
        LANE16 => {
            let dst = cpu.regs[dst_reg] as u16;
            let (res, flag_op) = do_alu16(dst, src as u16, op);
            if op != AluOp::Cmp && op != AluOp::Test { write_reg16(cpu, dst_reg, res); }
            set_lazy(cpu, flag_op, dst as u64, res as u64);
        }
        LANE32 => {
            let dst = cpu.regs[dst_reg] as u32;
            let (res, flag_op) = do_alu32(dst, src as u32, op);
            if op != AluOp::Cmp && op != AluOp::Test { cpu.regs[dst_reg] = res as u64; }
            set_lazy(cpu, flag_op, dst as u64, res as u64);
        }
        LANE64 => {
            let dst = cpu.regs[dst_reg];
            let (res, flag_op) = do_alu64(dst, src, op);
            if op != AluOp::Cmp && op != AluOp::Test { cpu.regs[dst_reg] = res; }
            set_lazy(cpu, flag_op, dst, res);
        }
        _ => {}
    }
}

#[inline(always)]
fn do_alu16(dst: u16, src: u16, op: AluOp) -> (u16, FlagOp) {
    match op {
        AluOp::Add => (dst.wrapping_add(src), FlagOp::AddW),
        AluOp::Or  => (dst | src, FlagOp::OrW),
        AluOp::And => (dst & src, FlagOp::AndW),
        AluOp::Sub | AluOp::Cmp => (dst.wrapping_sub(src), FlagOp::SubW),
        AluOp::Xor => (dst ^ src, FlagOp::XorW),
        AluOp::Test => (dst & src, FlagOp::AndW),
        AluOp::Adc | AluOp::Sbb => (dst.wrapping_add(src), FlagOp::AddW), // simplified
    }
}

#[inline(always)]
fn do_alu32(dst: u32, src: u32, op: AluOp) -> (u32, FlagOp) {
    match op {
        AluOp::Add => (dst.wrapping_add(src), FlagOp::AddL),
        AluOp::Or  => (dst | src, FlagOp::OrL),
        AluOp::And => (dst & src, FlagOp::AndL),
        AluOp::Sub | AluOp::Cmp => (dst.wrapping_sub(src), FlagOp::SubL),
        AluOp::Xor => (dst ^ src, FlagOp::XorL),
        AluOp::Test => (dst & src, FlagOp::AndL),
        AluOp::Adc | AluOp::Sbb => (dst.wrapping_add(src), FlagOp::AddL),
    }
}

#[inline(always)]
fn do_alu64(dst: u64, src: u64, op: AluOp) -> (u64, FlagOp) {
    match op {
        AluOp::Add => (dst.wrapping_add(src), FlagOp::AddQ),
        AluOp::Or  => (dst | src, FlagOp::OrQ),
        AluOp::And => (dst & src, FlagOp::AndQ),
        AluOp::Sub | AluOp::Cmp => (dst.wrapping_sub(src), FlagOp::SubQ),
        AluOp::Xor => (dst ^ src, FlagOp::XorQ),
        AluOp::Test => (dst & src, FlagOp::AndQ),
        AluOp::Adc | AluOp::Sbb => (dst.wrapping_add(src), FlagOp::AddQ),
    }
}

/// GRP1 imm8 ALU for byte operand
#[inline(always)]
fn grp1_op8(dst: u8, src: u8, op_idx: u8) -> (u8, FlagOp) {
    match op_idx {
        0 => (dst.wrapping_add(src), FlagOp::AddB),
        1 => (dst | src, FlagOp::OrB),
        2 => (dst.wrapping_add(src), FlagOp::AdcB), // simplified
        3 => (dst.wrapping_sub(src), FlagOp::SbbB), // simplified
        4 => (dst & src, FlagOp::AndB),
        5 | 7 => (dst.wrapping_sub(src), FlagOp::SubB),
        6 => (dst ^ src, FlagOp::XorB),
        _ => (dst, FlagOp::External),
    }
}

/// GRP1 r/m16/32/64, imm (0x81/0x83)
#[inline(always)]
unsafe fn grp1_rm_imm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32, op_idx: u8, sign_ext: bool) {
    let alu_op = match op_idx {
        0 => AluOp::Add, 1 => AluOp::Or, 2 => AluOp::Adc, 3 => AluOp::Sbb,
        4 => AluOp::And, 5 => AluOp::Sub, 6 => AluOp::Xor, 7 => AluOp::Cmp,
        _ => return,
    };

    if modrm & 0xC0 == 0xC0 {
        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
        match lane {
            LANE16 => {
                let dst = cpu.regs[r] as u16;
                let imm = if sign_ext {
                    match fetch_imm8(cpu, ram, ram_size) { Ok(v) => v as i8 as u16, Err(_) => return }
                } else {
                    match fetch_imm16(cpu, ram, ram_size) { Ok(v) => v, Err(_) => return }
                };
                let (res, flag_op) = do_alu16(dst, imm, alu_op);
                if op_idx != 7 { write_reg16(cpu, r, res); }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }
            LANE32 => {
                let dst = cpu.regs[r] as u32;
                let imm = if sign_ext {
                    match fetch_imm8(cpu, ram, ram_size) { Ok(v) => v as i8 as u32, Err(_) => return }
                } else {
                    match fetch_imm32(cpu, ram, ram_size) { Ok(v) => v, Err(_) => return }
                };
                let (res, flag_op) = do_alu32(dst, imm, alu_op);
                if op_idx != 7 { cpu.regs[r] = res as u64; }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }
            LANE64 => {
                let dst = cpu.regs[r];
                let imm = if sign_ext {
                    match fetch_imm8(cpu, ram, ram_size) { Ok(v) => v as i8 as i64 as u64, Err(_) => return }
                } else {
                    match fetch_imm32(cpu, ram, ram_size) { Ok(v) => v as i32 as i64 as u64, Err(_) => return }
                };
                let (res, flag_op) = do_alu64(dst, imm, alu_op);
                if op_idx != 7 { cpu.regs[r] = res; }
                set_lazy(cpu, flag_op, dst, res);
            }
            _ => {}
        }
    } else {
        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) {
            Ok(a) => a,
            Err(_) => { raise_exception(cpu, EXC_PF, 0); return; }
        };
        match lane {
            LANE16 => {
                let dst = mem::load_u16(cpu, ram, ram_size, addr).unwrap_or(0);
                let imm = if sign_ext {
                    match fetch_imm8(cpu, ram, ram_size) { Ok(v) => v as i8 as u16, Err(_) => return }
                } else {
                    match fetch_imm16(cpu, ram, ram_size) { Ok(v) => v, Err(_) => return }
                };
                let (res, flag_op) = do_alu16(dst, imm, alu_op);
                if op_idx != 7 { let _ = mem::store_u16(cpu, ram, ram_size, addr, res); }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }
            LANE32 => {
                let dst = mem::load_u32(cpu, ram, ram_size, addr).unwrap_or(0);
                let imm = if sign_ext {
                    match fetch_imm8(cpu, ram, ram_size) { Ok(v) => v as i8 as u32, Err(_) => return }
                } else {
                    match fetch_imm32(cpu, ram, ram_size) { Ok(v) => v, Err(_) => return }
                };
                let (res, flag_op) = do_alu32(dst, imm, alu_op);
                if op_idx != 7 { let _ = mem::store_u32(cpu, ram, ram_size, addr, res); }
                set_lazy(cpu, flag_op, dst as u64, res as u64);
            }
            LANE64 => {
                let dst = mem::load_u64(cpu, ram, ram_size, addr).unwrap_or(0);
                let imm = if sign_ext {
                    match fetch_imm8(cpu, ram, ram_size) { Ok(v) => v as i8 as i64 as u64, Err(_) => return }
                } else {
                    match fetch_imm32(cpu, ram, ram_size) { Ok(v) => v as i32 as i64 as u64, Err(_) => return }
                };
                let (res, flag_op) = do_alu64(dst, imm, alu_op);
                if op_idx != 7 { let _ = mem::store_u64(cpu, ram, ram_size, addr, res); }
                set_lazy(cpu, flag_op, dst, res);
            }
            _ => {}
        }
    }
}

/// GRP2 shifts for 16/32/64-bit
#[inline(always)]
unsafe fn grp2_rm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32, op_idx: u8, count: u8) {
    let count_mask = if lane == LANE64 { 0x3F } else { 0x1F };
    let count = count & count_mask;
    if count == 0 { return; }

    if modrm & 0xC0 == 0xC0 {
        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
        match lane {
            LANE16 => {
                let val = cpu.regs[r] as u16;
                let res = shift_op16(cpu, val, count, op_idx);
                write_reg16(cpu, r, res);
            }
            LANE32 => {
                let val = cpu.regs[r] as u32;
                let res = shift_op32(cpu, val, count, op_idx);
                cpu.regs[r] = res as u64;
            }
            LANE64 => {
                let val = cpu.regs[r];
                let res = shift_op64(cpu, val, count, op_idx);
                cpu.regs[r] = res;
            }
            _ => {}
        }
    } else {
        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) {
            Ok(a) => a,
            Err(_) => { raise_exception(cpu, EXC_PF, 0); return; }
        };
        match lane {
            LANE16 => {
                let val = mem::load_u16(cpu, ram, ram_size, addr).unwrap_or(0);
                let res = shift_op16(cpu, val, count, op_idx);
                let _ = mem::store_u16(cpu, ram, ram_size, addr, res);
            }
            LANE32 => {
                let val = mem::load_u32(cpu, ram, ram_size, addr).unwrap_or(0);
                let res = shift_op32(cpu, val, count, op_idx);
                let _ = mem::store_u32(cpu, ram, ram_size, addr, res);
            }
            LANE64 => {
                let val = mem::load_u64(cpu, ram, ram_size, addr).unwrap_or(0);
                let res = shift_op64(cpu, val, count, op_idx);
                let _ = mem::store_u64(cpu, ram, ram_size, addr, res);
            }
            _ => {}
        }
    }
}

#[inline(always)]
fn shift_op8(cpu: &mut Cpu, val: u8, count: u8, op: u8) -> u8 {
    let res = match op {
        4 | 6 => { // SHL
            let cf = (val >> (8 - count)) & 1;
            set_lazy(cpu, FlagOp::ShlB, cf as u64, (val << count) as u64);
            val << count
        }
        5 => { // SHR
            let cf = (val >> (count - 1)) & 1;
            let r = val >> count;
            set_lazy(cpu, FlagOp::ShlB, cf as u64, r as u64); // reuse ShlB for flags
            r
        }
        7 => { // SAR
            let cf = ((val as i8) >> (count - 1)) & 1;
            let r = ((val as i8) >> count) as u8;
            set_lazy(cpu, FlagOp::SarB, cf as u64, r as u64);
            r
        }
        0 => { // ROL
            let r = val.rotate_left(count as u32);
            set_lazy(cpu, FlagOp::ShlB, (r & 1) as u64, r as u64);
            r
        }
        1 => { // ROR
            let r = val.rotate_right(count as u32);
            set_lazy(cpu, FlagOp::ShlB, ((r >> 7) & 1) as u64, r as u64);
            r
        }
        _ => val, // RCL/RCR — simplified
    };
    res
}

#[inline(always)]
fn shift_op16(cpu: &mut Cpu, val: u16, count: u8, op: u8) -> u16 {
    match op {
        4 | 6 => {
            let cf = (val >> (16 - count)) & 1;
            let r = val << count;
            set_lazy(cpu, FlagOp::ShlW, cf as u64, r as u64);
            r
        }
        5 => {
            let cf = (val >> (count - 1)) & 1;
            let r = val >> count;
            set_lazy(cpu, FlagOp::ShlW, cf as u64, r as u64);
            r
        }
        7 => {
            let cf = ((val as i16) >> (count - 1)) & 1;
            let r = ((val as i16) >> count) as u16;
            set_lazy(cpu, FlagOp::SarW, cf as u64, r as u64);
            r
        }
        0 => { let r = val.rotate_left(count as u32); set_lazy(cpu, FlagOp::ShlW, (r & 1) as u64, r as u64); r }
        1 => { let r = val.rotate_right(count as u32); set_lazy(cpu, FlagOp::ShlW, ((r >> 15) & 1) as u64, r as u64); r }
        _ => val,
    }
}

#[inline(always)]
fn shift_op32(cpu: &mut Cpu, val: u32, count: u8, op: u8) -> u32 {
    match op {
        4 | 6 => {
            let cf = (val >> (32 - count)) & 1;
            let r = val << count;
            set_lazy(cpu, FlagOp::ShlL, cf as u64, r as u64);
            r
        }
        5 => {
            let cf = (val >> (count - 1)) & 1;
            let r = val >> count;
            set_lazy(cpu, FlagOp::ShlL, cf as u64, r as u64);
            r
        }
        7 => {
            let cf = ((val as i32) >> (count - 1)) & 1;
            let r = ((val as i32) >> count) as u32;
            set_lazy(cpu, FlagOp::SarL, cf as u64, r as u64);
            r
        }
        0 => { let r = val.rotate_left(count as u32); set_lazy(cpu, FlagOp::ShlL, (r & 1) as u64, r as u64); r }
        1 => { let r = val.rotate_right(count as u32); set_lazy(cpu, FlagOp::ShlL, ((r >> 31) & 1) as u64, r as u64); r }
        _ => val,
    }
}

#[inline(always)]
fn shift_op64(cpu: &mut Cpu, val: u64, count: u8, op: u8) -> u64 {
    match op {
        4 | 6 => {
            let cf = (val >> (64 - count)) & 1;
            let r = val << count;
            set_lazy(cpu, FlagOp::ShlQ, cf, r);
            r
        }
        5 => {
            let cf = (val >> (count - 1)) & 1;
            let r = val >> count;
            set_lazy(cpu, FlagOp::ShlQ, cf, r);
            r
        }
        7 => {
            let cf = ((val as i64) >> (count - 1)) & 1;
            let r = ((val as i64) >> count) as u64;
            set_lazy(cpu, FlagOp::SarQ, cf as u64, r);
            r
        }
        0 => { let r = val.rotate_left(count as u32); set_lazy(cpu, FlagOp::ShlQ, r & 1, r); r }
        1 => { let r = val.rotate_right(count as u32); set_lazy(cpu, FlagOp::ShlQ, (r >> 63) & 1, r); r }
        _ => val,
    }
}

/// GRP3 for 16/32/64-bit
#[inline(always)]
unsafe fn grp3_rm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32) {
    let op_idx = (modrm >> 3) & 7;
    let val = load_rm(cpu, ram, ram_size, modrm, lane);

    match op_idx {
        0 | 1 => { // TEST r/m, imm
            match lane {
                LANE16 => {
                    let imm = match fetch_imm16(cpu, ram, ram_size) { Ok(v) => v, Err(_) => return };
                    set_lazy(cpu, FlagOp::AndW, 0, (val as u16 & imm) as u64);
                }
                LANE32 => {
                    let imm = match fetch_imm32(cpu, ram, ram_size) { Ok(v) => v, Err(_) => return };
                    set_lazy(cpu, FlagOp::AndL, 0, (val as u32 & imm) as u64);
                }
                LANE64 => {
                    let imm = match fetch_imm32(cpu, ram, ram_size) { Ok(v) => v as i32 as u64, Err(_) => return };
                    set_lazy(cpu, FlagOp::AndQ, 0, val & imm);
                }
                _ => {}
            }
        }
        2 => { // NOT
            let res = !val;
            store_rm(cpu, ram, ram_size, modrm, lane, res);
        }
        3 => { // NEG
            match lane {
                LANE16 => {
                    let res = (val as u16).wrapping_neg();
                    store_rm(cpu, ram, ram_size, modrm, lane, res as u64);
                    set_lazy(cpu, FlagOp::SubW, 0, res as u64);
                }
                LANE32 => {
                    let res = (val as u32).wrapping_neg();
                    store_rm(cpu, ram, ram_size, modrm, lane, res as u64);
                    set_lazy(cpu, FlagOp::SubL, 0, res as u64);
                }
                LANE64 => {
                    let res = val.wrapping_neg();
                    store_rm(cpu, ram, ram_size, modrm, lane, res);
                    set_lazy(cpu, FlagOp::SubQ, 0, res);
                }
                _ => {}
            }
        }
        4 => { // MUL
            match lane {
                LANE16 => {
                    let r = (cpu.regs[RAX] as u16 as u32).wrapping_mul(val as u16 as u32);
                    write_reg16(cpu, RAX, r as u16);
                    write_reg16(cpu, RDX, (r >> 16) as u16);
                    materialize_flags(cpu);
                    if r >> 16 != 0 { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                LANE32 => {
                    let r = (cpu.regs[RAX] as u32 as u64).wrapping_mul(val as u32 as u64);
                    cpu.regs[RAX] = r as u32 as u64;
                    cpu.regs[RDX] = (r >> 32) as u32 as u64;
                    materialize_flags(cpu);
                    if r >> 32 != 0 { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                LANE64 => {
                    let r = (cpu.regs[RAX] as u128).wrapping_mul(val as u128);
                    cpu.regs[RAX] = r as u64;
                    cpu.regs[RDX] = (r >> 64) as u64;
                    materialize_flags(cpu);
                    if r >> 64 != 0 { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                _ => {}
            }
        }
        5 => { // IMUL
            match lane {
                LANE16 => {
                    let r = (cpu.regs[RAX] as u16 as i16 as i32).wrapping_mul(val as u16 as i16 as i32);
                    write_reg16(cpu, RAX, r as u16);
                    write_reg16(cpu, RDX, (r >> 16) as u16);
                    materialize_flags(cpu);
                    if r as i16 as i32 != r { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                LANE32 => {
                    let r = (cpu.regs[RAX] as u32 as i32 as i64).wrapping_mul(val as u32 as i32 as i64);
                    cpu.regs[RAX] = r as u32 as u64;
                    cpu.regs[RDX] = (r >> 32) as u32 as u64;
                    materialize_flags(cpu);
                    if r as i32 as i64 != r { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                LANE64 => {
                    let r = (cpu.regs[RAX] as i64 as i128).wrapping_mul(val as i64 as i128);
                    cpu.regs[RAX] = r as u64;
                    cpu.regs[RDX] = (r >> 64) as u64;
                    materialize_flags(cpu);
                    if r as i64 as i128 != r { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                _ => {}
            }
        }
        6 => { // DIV
            match lane {
                LANE32 => {
                    let d = val as u32;
                    if d == 0 { raise_exception(cpu, EXC_DE, 0); return; }
                    let dividend = ((cpu.regs[RDX] as u32 as u64) << 32) | (cpu.regs[RAX] as u32 as u64);
                    let q = dividend / d as u64;
                    let r = dividend % d as u64;
                    if q > 0xFFFFFFFF { raise_exception(cpu, EXC_DE, 0); return; }
                    cpu.regs[RAX] = q as u32 as u64;
                    cpu.regs[RDX] = r as u32 as u64;
                }
                LANE64 => {
                    if val == 0 { raise_exception(cpu, EXC_DE, 0); return; }
                    let dividend = ((cpu.regs[RDX] as u128) << 64) | cpu.regs[RAX] as u128;
                    let q = dividend / val as u128;
                    let r = dividend % val as u128;
                    if q > u64::MAX as u128 { raise_exception(cpu, EXC_DE, 0); return; }
                    cpu.regs[RAX] = q as u64;
                    cpu.regs[RDX] = r as u64;
                }
                _ => {}
            }
        }
        7 => { // IDIV
            match lane {
                LANE32 => {
                    let d = val as u32 as i32;
                    if d == 0 { raise_exception(cpu, EXC_DE, 0); return; }
                    let dividend = (((cpu.regs[RDX] as u32 as u64) << 32) | (cpu.regs[RAX] as u32 as u64)) as i64;
                    let q = dividend / d as i64;
                    let r = dividend % d as i64;
                    if q > i32::MAX as i64 || q < i32::MIN as i64 { raise_exception(cpu, EXC_DE, 0); return; }
                    cpu.regs[RAX] = q as u32 as u64;
                    cpu.regs[RDX] = r as u32 as u64;
                }
                LANE64 => {
                    let d = val as i64;
                    if d == 0 { raise_exception(cpu, EXC_DE, 0); return; }
                    let dividend = (((cpu.regs[RDX] as u128) << 64) | cpu.regs[RAX] as u128) as i128;
                    let q = dividend / d as i128;
                    let r = dividend % d as i128;
                    if q > i64::MAX as i128 || q < i64::MIN as i128 { raise_exception(cpu, EXC_DE, 0); return; }
                    cpu.regs[RAX] = q as u64;
                    cpu.regs[RDX] = r as u64;
                }
                _ => {}
            }
        }
        _ => {}
    }
}

/// Store to r/m (for GRP3 NOT/NEG)
#[inline(always)]
unsafe fn store_rm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32, val: u64) {
    if modrm & 0xC0 == 0xC0 {
        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
        match lane {
            LANE16 => write_reg16(cpu, r, val as u16),
            LANE32 => cpu.regs[r] = val as u32 as u64,
            LANE64 => cpu.regs[r] = val,
            _ => {}
        }
    } else {
        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) {
            Ok(a) => a,
            Err(_) => return,
        };
        match lane {
            LANE16 => { let _ = mem::store_u16(cpu, ram, ram_size, addr, val as u16); }
            LANE32 => { let _ = mem::store_u32(cpu, ram, ram_size, addr, val as u32); }
            LANE64 => { let _ = mem::store_u64(cpu, ram, ram_size, addr, val); }
            _ => {}
        }
    }
}

/// GRP5 — INC/DEC/CALL/JMP/PUSH r/m
#[inline(always)]
unsafe fn grp5_rm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32) {
    let op_idx = (modrm >> 3) & 7;
    match op_idx {
        0 => { // INC
            let val = load_rm(cpu, ram, ram_size, modrm, lane);
            match lane {
                LANE16 => {
                    let res = (val as u16).wrapping_add(1);
                    store_rm(cpu, ram, ram_size, modrm, lane, res as u64);
                    set_lazy(cpu, FlagOp::IncW, val, res as u64);
                }
                LANE32 => {
                    let res = (val as u32).wrapping_add(1);
                    store_rm(cpu, ram, ram_size, modrm, lane, res as u64);
                    set_lazy(cpu, FlagOp::IncL, val, res as u64);
                }
                LANE64 => {
                    let res = val.wrapping_add(1);
                    store_rm(cpu, ram, ram_size, modrm, lane, res);
                    set_lazy(cpu, FlagOp::IncQ, val, res);
                }
                _ => {}
            }
        }
        1 => { // DEC
            let val = load_rm(cpu, ram, ram_size, modrm, lane);
            match lane {
                LANE16 => {
                    let res = (val as u16).wrapping_sub(1);
                    store_rm(cpu, ram, ram_size, modrm, lane, res as u64);
                    set_lazy(cpu, FlagOp::DecW, val, res as u64);
                }
                LANE32 => {
                    let res = (val as u32).wrapping_sub(1);
                    store_rm(cpu, ram, ram_size, modrm, lane, res as u64);
                    set_lazy(cpu, FlagOp::DecL, val, res as u64);
                }
                LANE64 => {
                    let res = val.wrapping_sub(1);
                    store_rm(cpu, ram, ram_size, modrm, lane, res);
                    set_lazy(cpu, FlagOp::DecQ, val, res);
                }
                _ => {}
            }
        }
        2 => { // CALL r/m (indirect)
            let target = load_rm(cpu, ram, ram_size, modrm, lane);
            let ret_addr = cpu.rip;
            if cpu.long_mode {
                cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                let _ = mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], ret_addr);
                cpu.rip = target;
            } else {
                cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                let _ = mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], ret_addr as u32);
                cpu.rip = target & 0xFFFFFFFF;
            }
        }
        4 => { // JMP r/m (indirect)
            let target = load_rm(cpu, ram, ram_size, modrm, lane);
            cpu.rip = if cpu.long_mode { target } else { target & 0xFFFFFFFF };
        }
        6 => { // PUSH r/m
            let val = load_rm(cpu, ram, ram_size, modrm, lane);
            if cpu.long_mode {
                cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                let _ = mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], val);
            } else {
                cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                let _ = mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], val as u32);
            }
        }
        _ => {
            raise_exception(cpu, EXC_UD, 0);
        }
    }
}

// ============================================================
// String operations
// ============================================================

#[inline(always)]
unsafe fn string_movsb(cpu: &mut Cpu, ram: *mut u8, ram_size: u32) {
    let df = if cpu.rflags & DF != 0 { -1i64 } else { 1i64 };
    if cpu.prefix.rep != 0 {
        while cpu.regs[RCX] != 0 {
            let val = match mem::load_u8(cpu, ram, ram_size, cpu.regs[RSI]) { Ok(v) => v, Err(_) => return };
            let _ = mem::store_u8(cpu, ram, ram_size, cpu.regs[RDI], val);
            cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(df as u64);
            cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
            cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
        }
    } else {
        let val = match mem::load_u8(cpu, ram, ram_size, cpu.regs[RSI]) { Ok(v) => v, Err(_) => return };
        let _ = mem::store_u8(cpu, ram, ram_size, cpu.regs[RDI], val);
        cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(df as u64);
        cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
    }
}

#[inline(always)]
unsafe fn string_movs(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, lane: u32) {
    let size = match lane { LANE16 => 2i64, LANE32 => 4, _ => 8 };
    let df = if cpu.rflags & DF != 0 { -size } else { size };
    if cpu.prefix.rep != 0 {
        while cpu.regs[RCX] != 0 {
            match lane {
                LANE16 => {
                    let v = mem::load_u16(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
                    let _ = mem::store_u16(cpu, ram, ram_size, cpu.regs[RDI], v);
                }
                LANE32 => {
                    let v = mem::load_u32(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
                    let _ = mem::store_u32(cpu, ram, ram_size, cpu.regs[RDI], v);
                }
                _ => {
                    let v = mem::load_u64(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
                    let _ = mem::store_u64(cpu, ram, ram_size, cpu.regs[RDI], v);
                }
            }
            cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(df as u64);
            cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
            cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
        }
    } else {
        match lane {
            LANE16 => {
                let v = mem::load_u16(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
                let _ = mem::store_u16(cpu, ram, ram_size, cpu.regs[RDI], v);
            }
            LANE32 => {
                let v = mem::load_u32(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
                let _ = mem::store_u32(cpu, ram, ram_size, cpu.regs[RDI], v);
            }
            _ => {
                let v = mem::load_u64(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
                let _ = mem::store_u64(cpu, ram, ram_size, cpu.regs[RDI], v);
            }
        }
        cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(df as u64);
        cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
    }
}

#[inline(always)]
unsafe fn string_stosb(cpu: &mut Cpu, ram: *mut u8, ram_size: u32) {
    let val = cpu.regs[RAX] as u8;
    let df = if cpu.rflags & DF != 0 { -1i64 } else { 1i64 };
    if cpu.prefix.rep != 0 {
        while cpu.regs[RCX] != 0 {
            let _ = mem::store_u8(cpu, ram, ram_size, cpu.regs[RDI], val);
            cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
            cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
        }
    } else {
        let _ = mem::store_u8(cpu, ram, ram_size, cpu.regs[RDI], val);
        cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
    }
}

#[inline(always)]
unsafe fn string_stos(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, lane: u32) {
    let size = match lane { LANE16 => 2i64, LANE32 => 4, _ => 8 };
    let df = if cpu.rflags & DF != 0 { -size } else { size };
    if cpu.prefix.rep != 0 {
        while cpu.regs[RCX] != 0 {
            match lane {
                LANE16 => { let _ = mem::store_u16(cpu, ram, ram_size, cpu.regs[RDI], cpu.regs[RAX] as u16); }
                LANE32 => { let _ = mem::store_u32(cpu, ram, ram_size, cpu.regs[RDI], cpu.regs[RAX] as u32); }
                _ => { let _ = mem::store_u64(cpu, ram, ram_size, cpu.regs[RDI], cpu.regs[RAX]); }
            }
            cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
            cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
        }
    } else {
        match lane {
            LANE16 => { let _ = mem::store_u16(cpu, ram, ram_size, cpu.regs[RDI], cpu.regs[RAX] as u16); }
            LANE32 => { let _ = mem::store_u32(cpu, ram, ram_size, cpu.regs[RDI], cpu.regs[RAX] as u32); }
            _ => { let _ = mem::store_u64(cpu, ram, ram_size, cpu.regs[RDI], cpu.regs[RAX]); }
        }
        cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
    }
}

#[inline(always)]
unsafe fn string_lodsb(cpu: &mut Cpu, ram: *mut u8, ram_size: u32) {
    let df = if cpu.rflags & DF != 0 { -1i64 } else { 1i64 };
    let val = mem::load_u8(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
    write_reg8_al(cpu, val);
    cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(df as u64);
}

#[inline(always)]
unsafe fn string_lods(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, lane: u32) {
    let size = match lane { LANE16 => 2i64, LANE32 => 4, _ => 8 };
    let df = if cpu.rflags & DF != 0 { -size } else { size };
    match lane {
        LANE16 => {
            let v = mem::load_u16(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
            write_reg16(cpu, RAX, v);
        }
        LANE32 => {
            let v = mem::load_u32(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
            cpu.regs[RAX] = v as u64;
        }
        _ => {
            let v = mem::load_u64(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
            cpu.regs[RAX] = v;
        }
    }
    cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(df as u64);
}

#[inline(always)]
unsafe fn string_cmpsb(cpu: &mut Cpu, ram: *mut u8, ram_size: u32) {
    let df = if cpu.rflags & DF != 0 { -1i64 } else { 1i64 };
    if cpu.prefix.rep != 0 {
        let repne = cpu.prefix.rep == 0xF2;
        while cpu.regs[RCX] != 0 {
            let a = mem::load_u8(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
            let b = mem::load_u8(cpu, ram, ram_size, cpu.regs[RDI]).unwrap_or(0);
            let res = a.wrapping_sub(b);
            set_lazy(cpu, FlagOp::SubB, a as u64, res as u64);
            cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(df as u64);
            cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
            cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
            let zf = res == 0;
            if repne { if zf { break; } } else { if !zf { break; } }
        }
    } else {
        let a = mem::load_u8(cpu, ram, ram_size, cpu.regs[RSI]).unwrap_or(0);
        let b = mem::load_u8(cpu, ram, ram_size, cpu.regs[RDI]).unwrap_or(0);
        let res = a.wrapping_sub(b);
        set_lazy(cpu, FlagOp::SubB, a as u64, res as u64);
        cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(df as u64);
        cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
    }
}

#[inline(always)]
unsafe fn string_cmps(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, lane: u32) {
    let size = match lane { LANE16 => 2i64, LANE32 => 4, _ => 8 };
    let df = if cpu.rflags & DF != 0 { -size } else { size };
    let a = load_from_addr(cpu, ram, ram_size, cpu.regs[RSI], lane);
    let b = load_from_addr(cpu, ram, ram_size, cpu.regs[RDI], lane);
    match lane {
        LANE16 => {
            let res = (a as u16).wrapping_sub(b as u16);
            set_lazy(cpu, FlagOp::SubW, a, res as u64);
        }
        LANE32 => {
            let res = (a as u32).wrapping_sub(b as u32);
            set_lazy(cpu, FlagOp::SubL, a, res as u64);
        }
        _ => {
            let res = a.wrapping_sub(b);
            set_lazy(cpu, FlagOp::SubQ, a, res);
        }
    }
    cpu.regs[RSI] = cpu.regs[RSI].wrapping_add(df as u64);
    cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
}

#[inline(always)]
unsafe fn string_scasb(cpu: &mut Cpu, ram: *mut u8, ram_size: u32) {
    let df = if cpu.rflags & DF != 0 { -1i64 } else { 1i64 };
    let al = cpu.regs[RAX] as u8;
    if cpu.prefix.rep != 0 {
        let repne = cpu.prefix.rep == 0xF2;
        while cpu.regs[RCX] != 0 {
            let b = mem::load_u8(cpu, ram, ram_size, cpu.regs[RDI]).unwrap_or(0);
            let res = al.wrapping_sub(b);
            set_lazy(cpu, FlagOp::SubB, al as u64, res as u64);
            cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
            cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
            let zf = res == 0;
            if repne { if zf { break; } } else { if !zf { break; } }
        }
    } else {
        let b = mem::load_u8(cpu, ram, ram_size, cpu.regs[RDI]).unwrap_or(0);
        let res = al.wrapping_sub(b);
        set_lazy(cpu, FlagOp::SubB, al as u64, res as u64);
        cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
    }
}

#[inline(always)]
unsafe fn string_scas(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, lane: u32) {
    let size = match lane { LANE16 => 2i64, LANE32 => 4, _ => 8 };
    let df = if cpu.rflags & DF != 0 { -size } else { size };
    let b = load_from_addr(cpu, ram, ram_size, cpu.regs[RDI], lane);
    match lane {
        LANE16 => {
            let res = (cpu.regs[RAX] as u16).wrapping_sub(b as u16);
            set_lazy(cpu, FlagOp::SubW, cpu.regs[RAX] & 0xFFFF, res as u64);
        }
        LANE32 => {
            let res = (cpu.regs[RAX] as u32).wrapping_sub(b as u32);
            set_lazy(cpu, FlagOp::SubL, cpu.regs[RAX] & 0xFFFFFFFF, res as u64);
        }
        _ => {
            let res = cpu.regs[RAX].wrapping_sub(b);
            set_lazy(cpu, FlagOp::SubQ, cpu.regs[RAX], res);
        }
    }
    cpu.regs[RDI] = cpu.regs[RDI].wrapping_add(df as u64);
}

#[inline(always)]
unsafe fn load_from_addr(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, addr: u64, lane: u32) -> u64 {
    match lane {
        LANE16 => mem::load_u16(cpu, ram, ram_size, addr).unwrap_or(0) as u64,
        LANE32 => mem::load_u32(cpu, ram, ram_size, addr).unwrap_or(0) as u64,
        _ => mem::load_u64(cpu, ram, ram_size, addr).unwrap_or(0),
    }
}

// ============================================================
// Helper functions (inline, no function call overhead)
// ============================================================

/// Raise a CPU exception with error code.
/// Exceptions that push error codes: DF(8), TS(10), NP(11), SS(12), GP(13), PF(14), AC(17).
#[inline(always)]
unsafe fn raise_exception(cpu: &mut Cpu, vector: u32, error_code: u32) {
    // Rewind RIP to instruction start for fault-type exceptions
    cpu.rip = cpu.instr_start_rip;

    // For page faults, store faulting address in CR2
    // (caller should set cpu.cr2 before calling this for PF)

    let has_error_code = matches!(vector, 8 | 10 | 11 | 12 | 13 | 14 | 17);

    // Read this cpu's ram from the machine
    let mach = &mut *(crate::exports::get_machine());
    let ram = mach.ram;
    let ram_size = mach.ram_size;

    deliver_interrupt(cpu, ram, ram_size, vector, has_error_code, error_code);
}

/// Deliver an interrupt/exception through the IDT.
/// In 64-bit long mode, IDT entries are 16 bytes:
///   [0:1]  offset_low   (bits 15:0 of handler address)
///   [2:3]  selector     (code segment selector)
///   [4]    IST[2:0] + reserved
///   [5]    type[3:0] | 0 | DPL[1:0] | P
///   [6:7]  offset_mid   (bits 31:16 of handler address)
///   [8:11] offset_high  (bits 63:32 of handler address)
///   [12:15] reserved
unsafe fn deliver_interrupt(
    cpu: &mut Cpu,
    ram: *mut u8,
    ram_size: u32,
    vector: u32,
    has_error_code: bool,
    error_code: u32,
) {
    if !cpu.long_mode {
        // 32-bit protected mode interrupt delivery (simplified)
        deliver_interrupt_pm(cpu, ram, ram_size, vector, has_error_code, error_code);
        return;
    }

    // --- 64-bit long mode interrupt delivery ---

    // Check IDT limit
    let idt_offset = vector * 16;
    if idt_offset + 15 > cpu.idt.limit as u32 {
        // Double fault or triple fault
        if vector == EXC_DF {
            // Triple fault → reset
            crate::host::abort_js();
        }
        deliver_interrupt(cpu, ram, ram_size, EXC_DF, true, 0);
        return;
    }

    // Read 16-byte IDT entry from physical memory
    let idt_addr = cpu.idt.base + idt_offset as u64;
    let e0 = read_phys_u32(ram, ram_size, idt_addr);
    let e1 = read_phys_u32(ram, ram_size, idt_addr + 4);
    let e2 = read_phys_u32(ram, ram_size, idt_addr + 8);

    let offset_low = e0 & 0xFFFF;
    let selector = (e0 >> 16) & 0xFFFF;
    let ist = (e1 & 7) as u8;
    let gate_type = ((e1 >> 8) & 0xF) as u8;
    let _dpl = ((e1 >> 13) & 3) as u8;
    let present = (e1 >> 15) & 1;
    let offset_mid = (e1 >> 16) & 0xFFFF;
    let offset_high = e2;

    // Check present bit
    if present == 0 {
        if vector == EXC_DF {
            crate::host::abort_js();
        }
        deliver_interrupt(cpu, ram, ram_size, EXC_DF, true, 0);
        return;
    }

    // Gate type must be interrupt gate (0xE) or trap gate (0xF)
    if gate_type != 0xE && gate_type != 0xF {
        deliver_interrupt(cpu, ram, ram_size, EXC_GP, true, (vector << 3) | 2);
        return;
    }

    // DPL check for software interrupts (INT n, INT3, INTO)
    // Hardware interrupts and exceptions bypass DPL check

    // Compute handler address
    let handler_rip = (offset_low as u64)
        | ((offset_mid as u64) << 16)
        | ((offset_high as u64) << 32);

    // Save old state
    let old_rip = cpu.rip;
    let old_cs = cpu.segs[SEG_CS].selector;
    let old_ss = cpu.segs[SEG_SS].selector;
    let old_rsp = cpu.regs[RSP];
    let old_rflags = materialize_flags(cpu) | (cpu.rflags & !(SF | ZF | AF | PF | CF | OF));

    // Determine new stack pointer
    let old_cpl = cpu.cpl;
    let _new_cpl = (selector & 3) as u8; // Target CPL from selector RPL (usually 0)
    let target_cpl = 0u8; // Interrupt gates always go to ring 0 in long mode

    let new_rsp = if ist != 0 {
        // IST mechanism: load RSP from TSS IST entry
        // IST[n] is at TSS base + 36 + (n-1) * 8
        let tss_base = cpu.tr.base;
        let ist_offset = 36 + ((ist as u64 - 1) * 8);
        read_phys_u64(ram, ram_size, tss_base + ist_offset)
    } else if old_cpl != target_cpl {
        // Privilege level change: load RSP from TSS.RSP0
        // RSP0 is at TSS base + 4
        let tss_base = cpu.tr.base;
        read_phys_u64(ram, ram_size, tss_base + 4)
    } else {
        // Same privilege: use current RSP
        old_rsp
    };

    // Set up new stack — push in order: SS, RSP, RFLAGS, CS, RIP [, error_code]
    let mut rsp = new_rsp;

    // Push old SS
    rsp -= 8;
    write_phys_u64(ram, ram_size, rsp, old_ss as u64);

    // Push old RSP
    rsp -= 8;
    write_phys_u64(ram, ram_size, rsp, old_rsp);

    // Push RFLAGS
    rsp -= 8;
    write_phys_u64(ram, ram_size, rsp, old_rflags);

    // Push old CS
    rsp -= 8;
    write_phys_u64(ram, ram_size, rsp, old_cs as u64);

    // Push old RIP
    rsp -= 8;
    write_phys_u64(ram, ram_size, rsp, old_rip);

    // Push error code if applicable
    if has_error_code {
        rsp -= 8;
        write_phys_u64(ram, ram_size, rsp, error_code as u64);
    }

    // Update CPU state
    cpu.regs[RSP] = rsp;
    cpu.rip = handler_rip;
    cpu.cpl = target_cpl;

    // Load new CS
    cpu.segs[SEG_CS].selector = selector as u16;
    cpu.segs[SEG_CS].base = 0;
    // Set CS flags: 64-bit code segment, present, DPL=0
    cpu.segs[SEG_CS].flags = 0xA09B; // G=1, L=1 (64-bit), P=1, S=1, Type=0xB (exec/read/accessed)

    // Load new SS (flat, ring 0)
    if old_cpl != target_cpl {
        cpu.segs[SEG_SS].selector = 0;
        cpu.segs[SEG_SS].base = 0;
        cpu.segs[SEG_SS].flags = 0xC093; // G=1, B=1, P=1, S=1, Type=3 (read/write/accessed)
    }

    // If interrupt gate (0xE), clear IF to disable further interrupts
    if gate_type == 0xE {
        cpu.rflags &= !IF;
    }

    // Clear TF (trap flag) and NT (nested task) on interrupt delivery
    cpu.rflags &= !(TF | NT);

    // Flush TLB if privilege level changed (page table permissions change)
    if old_cpl != target_cpl {
        cpu.tlb.flush_all();
    }

    cpu.halted = false;
}

/// 32-bit protected mode interrupt delivery (simplified for boot).
unsafe fn deliver_interrupt_pm(
    cpu: &mut Cpu,
    ram: *mut u8,
    ram_size: u32,
    vector: u32,
    has_error_code: bool,
    error_code: u32,
) {
    // IDT entries are 8 bytes in 32-bit mode
    let idt_offset = vector * 8;
    if idt_offset + 7 > cpu.idt.limit as u32 {
        if vector == EXC_DF {
            crate::host::abort_js();
        }
        deliver_interrupt_pm(cpu, ram, ram_size, EXC_DF, true, 0);
        return;
    }

    let idt_addr = cpu.idt.base + idt_offset as u64;
    let e0 = read_phys_u32(ram, ram_size, idt_addr);
    let e1 = read_phys_u32(ram, ram_size, idt_addr + 4);

    let offset = (e0 & 0xFFFF) | (e1 & 0xFFFF0000);
    let selector = (e0 >> 16) & 0xFFFF;
    let gate_type = ((e1 >> 8) & 0x1F) as u8;
    let present = (e1 >> 15) & 1;

    if present == 0 {
        return;
    }

    let old_rip = cpu.rip;
    let old_cs = cpu.segs[SEG_CS].selector;
    let old_rflags = materialize_flags(cpu) | (cpu.rflags & !(SF | ZF | AF | PF | CF | OF));
    let mut rsp = cpu.regs[RSP] as u32;

    // Push EFLAGS, CS, EIP
    rsp -= 4;
    write_phys_u32(ram, ram_size, rsp as u64, old_rflags as u32);
    rsp -= 4;
    write_phys_u32(ram, ram_size, rsp as u64, old_cs as u32);
    rsp -= 4;
    write_phys_u32(ram, ram_size, rsp as u64, old_rip as u32);

    if has_error_code {
        rsp -= 4;
        write_phys_u32(ram, ram_size, rsp as u64, error_code);
    }

    cpu.regs[RSP] = rsp as u64;
    cpu.rip = offset as u64;
    cpu.segs[SEG_CS].selector = selector as u16;

    // Interrupt gate: clear IF
    if gate_type == 0x0E {
        cpu.rflags &= !IF;
    }
    cpu.rflags &= !(TF | NT);
    cpu.halted = false;
}

/// Read a u32 directly from physical RAM (no TLB, no paging).
#[inline(always)]
unsafe fn read_phys_u32(ram: *mut u8, ram_size: u32, addr: u64) -> u32 {
    let a = addr as u32;
    if a + 4 <= ram_size {
        core::ptr::read_unaligned(ram.add(a as usize) as *const u32)
    } else {
        0
    }
}

/// Read a u64 directly from physical RAM.
#[inline(always)]
unsafe fn read_phys_u64(ram: *mut u8, ram_size: u32, addr: u64) -> u64 {
    let a = addr as u32;
    if a + 8 <= ram_size {
        core::ptr::read_unaligned(ram.add(a as usize) as *const u64)
    } else {
        0
    }
}

/// Write a u32 directly to physical RAM.
#[inline(always)]
unsafe fn write_phys_u32(ram: *mut u8, ram_size: u32, addr: u64, val: u32) {
    let a = addr as u32;
    if a + 4 <= ram_size {
        core::ptr::write_unaligned(ram.add(a as usize) as *mut u32, val);
    }
}

/// Write a u64 directly to physical RAM.
#[inline(always)]
unsafe fn write_phys_u64(ram: *mut u8, ram_size: u32, addr: u64, val: u64) {
    let a = addr as u32;
    if a + 8 <= ram_size {
        core::ptr::write_unaligned(ram.add(a as usize) as *mut u64, val);
    }
}

/// Decode ModR/M addressing mode, return effective address.
#[inline(always)]
unsafe fn decode_modrm_addr(
    cpu: &mut Cpu,
    ram: *mut u8,
    ram_size: u32,
    modrm: u8,
) -> Result<u64, mem::MemFault> {
    let rm = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
    let mod_field = modrm >> 6;

    // 64-bit addressing mode
    if cpu.long_mode && !cpu.prefix.addr_size {
        match mod_field {
            0 => {
                if (rm & 7) == 5 {
                    // RIP-relative
                    let disp = mem::fetch_u32(cpu, ram, ram_size, cpu.rip)? as i32;
                    cpu.rip += 4;
                    return Ok(cpu.rip.wrapping_add(disp as i64 as u64));
                }
                if (rm & 7) == 4 {
                    // SIB byte
                    return decode_sib(cpu, ram, ram_size, mod_field);
                }
                Ok(cpu.regs[rm])
            }
            1 => {
                if (rm & 7) == 4 {
                    let addr = decode_sib(cpu, ram, ram_size, mod_field)?;
                    let disp = mem::fetch_u8(cpu, ram, ram_size, cpu.rip)? as i8;
                    cpu.rip += 1;
                    return Ok(addr.wrapping_add(disp as i64 as u64));
                }
                let disp = mem::fetch_u8(cpu, ram, ram_size, cpu.rip)? as i8;
                cpu.rip += 1;
                Ok(cpu.regs[rm].wrapping_add(disp as i64 as u64))
            }
            2 => {
                if (rm & 7) == 4 {
                    let addr = decode_sib(cpu, ram, ram_size, mod_field)?;
                    let disp = mem::fetch_u32(cpu, ram, ram_size, cpu.rip)? as i32;
                    cpu.rip += 4;
                    return Ok(addr.wrapping_add(disp as i64 as u64));
                }
                let disp = mem::fetch_u32(cpu, ram, ram_size, cpu.rip)? as i32;
                cpu.rip += 4;
                Ok(cpu.regs[rm].wrapping_add(disp as i64 as u64))
            }
            _ => Ok(0), // mod=3 is register mode, shouldn't reach here
        }
    } else {
        // 32-bit addressing mode
        match mod_field {
            0 => {
                if (rm & 7) == 5 {
                    let disp = mem::fetch_u32(cpu, ram, ram_size, cpu.rip)?;
                    cpu.rip += 4;
                    return Ok(disp as u64);
                }
                if (rm & 7) == 4 {
                    return decode_sib(cpu, ram, ram_size, mod_field);
                }
                Ok(cpu.regs[rm] & 0xFFFFFFFF)
            }
            1 => {
                if (rm & 7) == 4 {
                    let addr = decode_sib(cpu, ram, ram_size, mod_field)?;
                    let disp = mem::fetch_u8(cpu, ram, ram_size, cpu.rip)? as i8;
                    cpu.rip += 1;
                    return Ok((addr.wrapping_add(disp as i64 as u64)) & 0xFFFFFFFF);
                }
                let disp = mem::fetch_u8(cpu, ram, ram_size, cpu.rip)? as i8;
                cpu.rip += 1;
                Ok((cpu.regs[rm].wrapping_add(disp as i64 as u64)) & 0xFFFFFFFF)
            }
            2 => {
                if (rm & 7) == 4 {
                    let addr = decode_sib(cpu, ram, ram_size, mod_field)?;
                    let disp = mem::fetch_u32(cpu, ram, ram_size, cpu.rip)? as i32;
                    cpu.rip += 4;
                    return Ok((addr.wrapping_add(disp as i64 as u64)) & 0xFFFFFFFF);
                }
                let disp = mem::fetch_u32(cpu, ram, ram_size, cpu.rip)? as i32;
                cpu.rip += 4;
                Ok((cpu.regs[rm].wrapping_add(disp as i64 as u64)) & 0xFFFFFFFF)
            }
            _ => Ok(0),
        }
    }
}

/// Decode SIB byte for addressing.
#[inline(always)]
unsafe fn decode_sib(
    cpu: &mut Cpu,
    ram: *mut u8,
    ram_size: u32,
    mod_field: u8,
) -> Result<u64, mem::MemFault> {
    let sib = mem::fetch_u8(cpu, ram, ram_size, cpu.rip)?;
    cpu.rip += 1;

    let scale = 1u64 << (sib >> 6);
    let index_reg = ((sib >> 3) & 7) as usize | ((cpu.prefix.rex as usize >> 1) & 1) << 3;
    let base_reg = (sib & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);

    let index = if (index_reg & 7) == 4 { 0 } else { cpu.regs[index_reg] };

    let base = if (base_reg & 7) == 5 && mod_field == 0 {
        let disp = mem::fetch_u32(cpu, ram, ram_size, cpu.rip)? as i32;
        cpu.rip += 4;
        disp as i64 as u64
    } else {
        cpu.regs[base_reg]
    };

    Ok(base.wrapping_add(index.wrapping_mul(scale)))
}

// Register read/write helpers for 8-bit operations

#[inline(always)]
fn read_reg8(cpu: &Cpu, reg: usize) -> u8 {
    if cpu.prefix.rex != 0 || reg < 4 {
        cpu.regs[reg] as u8
    } else {
        // Without REX: AH=4, CH=5, DH=6, BH=7
        (cpu.regs[reg - 4] >> 8) as u8
    }
}

#[inline(always)]
fn write_reg8(cpu: &mut Cpu, reg: usize, val: u8) {
    if cpu.prefix.rex != 0 || reg < 4 {
        cpu.regs[reg] = (cpu.regs[reg] & !0xFF) | val as u64;
    } else {
        cpu.regs[reg - 4] = (cpu.regs[reg - 4] & !0xFF00) | ((val as u64) << 8);
    }
}

#[inline(always)]
fn write_reg8_al(cpu: &mut Cpu, val: u8) {
    cpu.regs[RAX] = (cpu.regs[RAX] & !0xFF) | val as u64;
}

#[inline(always)]
fn write_reg16(cpu: &mut Cpu, reg: usize, val: u16) {
    cpu.regs[reg] = (cpu.regs[reg] & !0xFFFF) | val as u64;
}

fn read_reg16(cpu: &Cpu, reg: usize) -> u16 {
    cpu.regs[reg] as u16
}

// Immediate fetchers

#[inline(always)]
unsafe fn fetch_imm8(cpu: &mut Cpu, ram: *mut u8, ram_size: u32) -> Result<u8, mem::MemFault> {
    let v = mem::fetch_u8(cpu, ram, ram_size, cpu.rip)?;
    cpu.rip += 1;
    Ok(v)
}

#[inline(always)]
unsafe fn fetch_imm16(cpu: &mut Cpu, ram: *mut u8, ram_size: u32) -> Result<u16, mem::MemFault> {
    let lo = mem::fetch_u8(cpu, ram, ram_size, cpu.rip)? as u16;
    let hi = mem::fetch_u8(cpu, ram, ram_size, cpu.rip + 1)? as u16;
    cpu.rip += 2;
    Ok(lo | (hi << 8))
}

#[inline(always)]
unsafe fn fetch_imm32(cpu: &mut Cpu, ram: *mut u8, ram_size: u32) -> Result<u32, mem::MemFault> {
    let v = mem::fetch_u32(cpu, ram, ram_size, cpu.rip)?;
    cpu.rip += 4;
    Ok(v)
}

#[inline(always)]
unsafe fn fetch_imm64(cpu: &mut Cpu, ram: *mut u8, ram_size: u32) -> Result<u64, mem::MemFault> {
    let v = mem::fetch_u64(cpu, ram, ram_size, cpu.rip)?;
    cpu.rip += 8;
    Ok(v)
}

// CPUID handler
unsafe fn handle_cpuid(cpu: &mut Cpu) {
    let leaf = cpu.regs[RAX] as u32;
    match leaf {
        0 => {
            cpu.regs[RAX] = 0x0D;  // max leaf
            cpu.regs[RBX] = 0x756E6547; // "Genu"
            cpu.regs[RDX] = 0x49656E69; // "ineI"
            cpu.regs[RCX] = 0x6C65746E; // "ntel"
        }
        1 => {
            cpu.regs[RAX] = 0x000306C3; // family/model/stepping
            cpu.regs[RBX] = 0x00010800;
            cpu.regs[RCX] = 0x80202001; // SSE3, SSSE3, SSE4.1, SSE4.2, POPCNT
            cpu.regs[RDX] = 0x078BFBFF; // FPU, SSE, SSE2, etc.
        }
        0x80000000 => {
            cpu.regs[RAX] = 0x80000008;
            cpu.regs[RBX] = 0;
            cpu.regs[RCX] = 0;
            cpu.regs[RDX] = 0;
        }
        0x80000001 => {
            cpu.regs[RAX] = 0;
            cpu.regs[RBX] = 0;
            cpu.regs[RCX] = 0;
            cpu.regs[RDX] = (1 << 29) | (1 << 27) | (1 << 20); // LM, RDTSCP, NX
        }
        _ => {
            cpu.regs[RAX] = 0;
            cpu.regs[RBX] = 0;
            cpu.regs[RCX] = 0;
            cpu.regs[RDX] = 0;
        }
    }
}

// MSR handlers
unsafe fn handle_wrmsr(cpu: &mut Cpu, ecx: u32, val: u64) {
    match ecx {
        0xC0000080 => cpu.efer = val,      // EFER
        0xC0000081 => cpu.star = val,      // STAR
        0xC0000082 => cpu.lstar = val,     // LSTAR
        0xC0000083 => cpu.cstar = val,     // CSTAR
        0xC0000084 => cpu.fmask = val,     // FMASK
        0xC0000100 => cpu.segs[SEG_FS].base = val,  // FS.base
        0xC0000101 => cpu.segs[SEG_GS].base = val,  // GS.base
        0xC0000102 => cpu.kernel_gs_base = val,      // KernelGSBase
        _ => {} // ignore unknown MSRs
    }
}

unsafe fn handle_rdmsr(cpu: &Cpu, ecx: u32) -> u64 {
    match ecx {
        0xC0000080 => cpu.efer,
        0xC0000081 => cpu.star,
        0xC0000082 => cpu.lstar,
        0xC0000083 => cpu.cstar,
        0xC0000084 => cpu.fmask,
        0xC0000100 => cpu.segs[SEG_FS].base,
        0xC0000101 => cpu.segs[SEG_GS].base,
        0xC0000102 => cpu.kernel_gs_base,
        0x1B => cpu.apic_base,
        _ => 0,
    }
}

// ============================================================
// ALU helper functions
// ============================================================

/// Byte ALU operation: alu_op 0=ADD, 1=OR, 2=ADC, 3=SBB, 4=AND, 5=SUB, 6=XOR, 7=CMP
#[inline(always)]
unsafe fn alu_op_b(cpu: &mut Cpu, alu_op: usize, dst: u8, src: u8) -> (u8, FlagOp) {
    match alu_op {
        0 => (dst.wrapping_add(src), FlagOp::AddB),
        1 => (dst | src, FlagOp::OrB),
        2 => {
            let cf = flags::get_cf(cpu) as u8;
            (dst.wrapping_add(src).wrapping_add(cf), FlagOp::AdcB)
        }
        3 => {
            let cf = flags::get_cf(cpu) as u8;
            (dst.wrapping_sub(src).wrapping_sub(cf), FlagOp::SbbB)
        }
        4 => (dst & src, FlagOp::AndB),
        5 | 7 => (dst.wrapping_sub(src), FlagOp::SubB),
        6 => (dst ^ src, FlagOp::XorB),
        _ => (dst, FlagOp::External),
    }
}

/// Ev,Gv ALU on register operands
#[inline(always)]
unsafe fn alu_ev_gv_reg(cpu: &mut Cpu, alu_op: usize, dst_reg: usize, src_reg: usize, lane: u32) {
    let src = cpu.regs[src_reg];
    let dst = cpu.regs[dst_reg];
    match lane {
        LANE16 => {
            let (res, fop) = alu_op_w(cpu, alu_op, dst as u16, src as u16);
            if alu_op != 7 { write_reg16(cpu, dst_reg, res); }
            set_lazy(cpu, fop, dst & 0xFFFF, res as u64);
        }
        LANE32 => {
            let (res, fop) = alu_op_l(cpu, alu_op, dst as u32, src as u32);
            if alu_op != 7 { cpu.regs[dst_reg] = res as u64; }
            set_lazy(cpu, fop, dst & 0xFFFFFFFF, res as u64);
        }
        _ => {
            let (res, fop) = alu_op_q(cpu, alu_op, dst, src);
            if alu_op != 7 { cpu.regs[dst_reg] = res; }
            set_lazy(cpu, fop, dst, res);
        }
    }
}

/// Ev,Gv ALU on memory destination
#[inline(always)]
unsafe fn alu_ev_gv_mem(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, alu_op: usize, addr: u64, src_reg: usize, lane: u32) {
    let src = cpu.regs[src_reg];
    match lane {
        LANE16 => {
            let dst = match mem::load_u16(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => { raise_exception(cpu, EXC_PF, 0); return; } };
            let (res, fop) = alu_op_w(cpu, alu_op, dst, src as u16);
            if alu_op != 7 { let _ = mem::store_u16(cpu, ram, ram_size, addr, res); }
            set_lazy(cpu, fop, dst as u64, res as u64);
        }
        LANE32 => {
            let dst = match mem::load_u32(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => { raise_exception(cpu, EXC_PF, 0); return; } };
            let (res, fop) = alu_op_l(cpu, alu_op, dst, src as u32);
            if alu_op != 7 { let _ = mem::store_u32(cpu, ram, ram_size, addr, res); }
            set_lazy(cpu, fop, dst as u64, res as u64);
        }
        _ => {
            let dst = match mem::load_u64(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => { raise_exception(cpu, EXC_PF, 0); return; } };
            let (res, fop) = alu_op_q(cpu, alu_op, dst, src);
            if alu_op != 7 { let _ = mem::store_u64(cpu, ram, ram_size, addr, res); }
            set_lazy(cpu, fop, dst, res);
        }
    }
}

/// Gv,Ev ALU — destination is register, source is value
#[inline(always)]
unsafe fn alu_gv_ev(cpu: &mut Cpu, alu_op: usize, dst_reg: usize, src: u64, lane: u32) {
    let dst = cpu.regs[dst_reg];
    match lane {
        LANE16 => {
            let (res, fop) = alu_op_w(cpu, alu_op, dst as u16, src as u16);
            if alu_op != 7 { write_reg16(cpu, dst_reg, res); }
            set_lazy(cpu, fop, dst & 0xFFFF, res as u64);
        }
        LANE32 => {
            let (res, fop) = alu_op_l(cpu, alu_op, dst as u32, src as u32);
            if alu_op != 7 { cpu.regs[dst_reg] = res as u64; }
            set_lazy(cpu, fop, dst & 0xFFFFFFFF, res as u64);
        }
        _ => {
            let (res, fop) = alu_op_q(cpu, alu_op, dst, src);
            if alu_op != 7 { cpu.regs[dst_reg] = res; }
            set_lazy(cpu, fop, dst, res);
        }
    }
}

#[inline(always)]
unsafe fn alu_op_w(cpu: &mut Cpu, alu_op: usize, dst: u16, src: u16) -> (u16, FlagOp) {
    match alu_op {
        0 => (dst.wrapping_add(src), FlagOp::AddW),
        1 => (dst | src, FlagOp::OrW),
        2 => { let cf = flags::get_cf(cpu) as u16; (dst.wrapping_add(src).wrapping_add(cf), FlagOp::AdcW) }
        3 => { let cf = flags::get_cf(cpu) as u16; (dst.wrapping_sub(src).wrapping_sub(cf), FlagOp::SbbW) }
        4 => (dst & src, FlagOp::AndW),
        5 | 7 => (dst.wrapping_sub(src), FlagOp::SubW),
        6 => (dst ^ src, FlagOp::XorW),
        _ => (dst, FlagOp::External),
    }
}

#[inline(always)]
unsafe fn alu_op_l(cpu: &mut Cpu, alu_op: usize, dst: u32, src: u32) -> (u32, FlagOp) {
    match alu_op {
        0 => (dst.wrapping_add(src), FlagOp::AddL),
        1 => (dst | src, FlagOp::OrL),
        2 => { let cf = flags::get_cf(cpu) as u32; (dst.wrapping_add(src).wrapping_add(cf), FlagOp::AdcL) }
        3 => { let cf = flags::get_cf(cpu) as u32; (dst.wrapping_sub(src).wrapping_sub(cf), FlagOp::SbbL) }
        4 => (dst & src, FlagOp::AndL),
        5 | 7 => (dst.wrapping_sub(src), FlagOp::SubL),
        6 => (dst ^ src, FlagOp::XorL),
        _ => (dst, FlagOp::External),
    }
}

#[inline(always)]
unsafe fn alu_op_q(cpu: &mut Cpu, alu_op: usize, dst: u64, src: u64) -> (u64, FlagOp) {
    match alu_op {
        0 => (dst.wrapping_add(src), FlagOp::AddQ),
        1 => (dst | src, FlagOp::OrQ),
        2 => { let cf = flags::get_cf(cpu) as u64; (dst.wrapping_add(src).wrapping_add(cf), FlagOp::AdcQ) }
        3 => { let cf = flags::get_cf(cpu) as u64; (dst.wrapping_sub(src).wrapping_sub(cf), FlagOp::SbbQ) }
        4 => (dst & src, FlagOp::AndQ),
        5 | 7 => (dst.wrapping_sub(src), FlagOp::SubQ),
        6 => (dst ^ src, FlagOp::XorQ),
        _ => (dst, FlagOp::External),
    }
}

// ============================================================
// GRP1 Ev, imm helper
// ============================================================

#[inline(always)]
unsafe fn grp1_ev_imm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, alu_op: usize, lane: u32, sign_ext: bool) {
    let is_reg = modrm & 0xC0 == 0xC0;
    let rm = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);

    match lane {
        LANE16 => {
            let dst = if is_reg { cpu.regs[rm] as u16 }
                      else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>{ raise_exception(cpu, EXC_PF, 0); return; } };
                             match mem::load_u16(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>{ raise_exception(cpu, EXC_PF, 0); return; } } };
            let imm = if sign_ext {
                match fetch_imm8(cpu, ram, ram_size) { Ok(v) => v as i8 as u16, Err(_) => { raise_exception(cpu, EXC_PF, 0); return; } }
            } else {
                match fetch_imm16(cpu, ram, ram_size) { Ok(v) => v, Err(_) => { raise_exception(cpu, EXC_PF, 0); return; } }
            };
            let (res, fop) = alu_op_w(cpu, alu_op, dst, imm);
            if alu_op != 7 {
                if is_reg { write_reg16(cpu, rm, res); }
                else { /* addr was computed above, we need it again */ }
            }
            set_lazy(cpu, fop, dst as u64, res as u64);
        }
        LANE32 => {
            let (dst, addr) = if is_reg { (cpu.regs[rm] as u32, 0u64) }
                              else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>{ raise_exception(cpu, EXC_PF, 0); return; } };
                                     (match mem::load_u32(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>{ raise_exception(cpu, EXC_PF, 0); return; } }, a) };
            let imm = if sign_ext {
                match fetch_imm8(cpu, ram, ram_size) { Ok(v) => v as i8 as i32 as u32, Err(_) => { raise_exception(cpu, EXC_PF, 0); return; } }
            } else {
                match fetch_imm32(cpu, ram, ram_size) { Ok(v) => v, Err(_) => { raise_exception(cpu, EXC_PF, 0); return; } }
            };
            let (res, fop) = alu_op_l(cpu, alu_op, dst, imm);
            if alu_op != 7 {
                if is_reg { cpu.regs[rm] = res as u64; }
                else { let _ = mem::store_u32(cpu, ram, ram_size, addr, res); }
            }
            set_lazy(cpu, fop, dst as u64, res as u64);
        }
        _ => {
            let (dst, addr) = if is_reg { (cpu.regs[rm], 0u64) }
                              else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>{ raise_exception(cpu, EXC_PF, 0); return; } };
                                     (match mem::load_u64(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>{ raise_exception(cpu, EXC_PF, 0); return; } }, a) };
            let imm = if sign_ext {
                match fetch_imm8(cpu, ram, ram_size) { Ok(v) => v as i8 as i64 as u64, Err(_) => { raise_exception(cpu, EXC_PF, 0); return; } }
            } else {
                match fetch_imm32(cpu, ram, ram_size) { Ok(v) => v as i32 as i64 as u64, Err(_) => { raise_exception(cpu, EXC_PF, 0); return; } }
            };
            let (res, fop) = alu_op_q(cpu, alu_op, dst, imm);
            if alu_op != 7 {
                if is_reg { cpu.regs[rm] = res; }
                else { let _ = mem::store_u64(cpu, ram, ram_size, addr, res); }
            }
            set_lazy(cpu, fop, dst, res);
        }
    }
}

// ============================================================
// Shift/rotate helpers
// ============================================================

#[inline(always)]
unsafe fn shift_op_b(cpu: &mut Cpu, op: usize, val: u8, count: u8) -> u8 {
    let res = match op {
        0 => { // ROL
            let c = count & 7;
            (val << c) | (val >> (8 - c))
        }
        1 => { // ROR
            let c = count & 7;
            (val >> c) | (val << (8 - c))
        }
        4 => { // SHL
            let r = (val as u16).wrapping_shl(count as u32) as u8;
            set_lazy(cpu, FlagOp::ShlB, val as u64, r as u64);
            return r;
        }
        5 => { // SHR
            let r = val >> (count & 7);
            set_lazy(cpu, FlagOp::ShlB, val as u64, r as u64); // reuse ShlB for shifts
            return r;
        }
        7 => { // SAR
            let r = (val as i8 >> (count & 7)) as u8;
            set_lazy(cpu, FlagOp::SarB, val as u64, r as u64);
            return r;
        }
        _ => val, // RCL, RCR — TODO
    };
    res
}

#[inline(always)]
unsafe fn grp2_ev(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, shift_op: usize, count_raw: u8, lane: u32) {
    let rm = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
    let is_reg = modrm & 0xC0 == 0xC0;

    match lane {
        LANE16 => {
            let count = count_raw & 0x1F;
            if count == 0 { return; }
            let (dst, addr) = if is_reg { (cpu.regs[rm] as u16, 0u64) }
                              else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                     (match mem::load_u16(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a) };
            let res = match shift_op {
                4 => { let r = (dst as u32).wrapping_shl(count as u32) as u16; set_lazy(cpu, FlagOp::ShlW, dst as u64, r as u64); r }
                5 => { let r = dst >> count; set_lazy(cpu, FlagOp::ShlW, dst as u64, r as u64); r }
                7 => { let r = (dst as i16 >> count) as u16; set_lazy(cpu, FlagOp::SarW, dst as u64, r as u64); r }
                _ => dst,
            };
            if is_reg { write_reg16(cpu, rm, res); } else { let _ = mem::store_u16(cpu, ram, ram_size, addr, res); }
        }
        LANE32 => {
            let count = count_raw & 0x1F;
            if count == 0 { return; }
            let (dst, addr) = if is_reg { (cpu.regs[rm] as u32, 0u64) }
                              else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                     (match mem::load_u32(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a) };
            let res = match shift_op {
                4 => { let r = dst.wrapping_shl(count as u32); set_lazy(cpu, FlagOp::ShlL, dst as u64, r as u64); r }
                5 => { let r = dst.wrapping_shr(count as u32); set_lazy(cpu, FlagOp::ShlL, dst as u64, r as u64); r }
                7 => { let r = (dst as i32).wrapping_shr(count as u32) as u32; set_lazy(cpu, FlagOp::SarL, dst as u64, r as u64); r }
                0 => { let c = count & 31; ((dst as u64) << c | (dst as u64) >> (32 - c)) as u32 } // ROL
                1 => { let c = count & 31; dst >> c | dst << (32 - c) } // ROR
                _ => dst,
            };
            if is_reg { cpu.regs[rm] = res as u64; } else { let _ = mem::store_u32(cpu, ram, ram_size, addr, res); }
        }
        _ => {
            let count = count_raw & 0x3F;
            if count == 0 { return; }
            let (dst, addr) = if is_reg { (cpu.regs[rm], 0u64) }
                              else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                     (match mem::load_u64(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a) };
            let res = match shift_op {
                4 => { let r = dst.wrapping_shl(count as u32); set_lazy(cpu, FlagOp::ShlQ, dst, r); r }
                5 => { let r = dst.wrapping_shr(count as u32); set_lazy(cpu, FlagOp::ShlQ, dst, r); r }
                7 => { let r = (dst as i64).wrapping_shr(count as u32) as u64; set_lazy(cpu, FlagOp::SarQ, dst, r); r }
                0 => { let c = count & 63; dst.wrapping_shl(c as u32) | dst.wrapping_shr((64 - c) as u32) } // ROL
                1 => { let c = count & 63; dst.wrapping_shr(c as u32) | dst.wrapping_shl((64 - c) as u32) } // ROR
                _ => dst,
            };
            if is_reg { cpu.regs[rm] = res; } else { let _ = mem::store_u64(cpu, ram, ram_size, addr, res); }
        }
    }
}

// ============================================================
// GRP3 helpers (TEST/NOT/NEG/MUL/IMUL/DIV/IDIV)
// ============================================================

#[inline(always)]
unsafe fn grp3_eb(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8) {
    let op = ((modrm >> 3) & 7) as usize;
    let rm = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
    let is_reg = modrm & 0xC0 == 0xC0;

    let (val, addr) = if is_reg {
        (read_reg8(cpu, rm), 0u64)
    } else {
        let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
        (match mem::load_u8(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a)
    };

    match op {
        0 | 1 => { // TEST Eb, imm8
            let imm = match fetch_imm8(cpu, ram, ram_size) { Ok(v)=>v, Err(_)=>return };
            set_lazy(cpu, FlagOp::AndB, 0, (val & imm) as u64);
        }
        2 => { // NOT
            let res = !val;
            if is_reg { write_reg8(cpu, rm, res); }
            else { let _ = mem::store_u8(cpu, ram, ram_size, addr, res); }
        }
        3 => { // NEG
            let res = (0u8).wrapping_sub(val);
            if is_reg { write_reg8(cpu, rm, res); }
            else { let _ = mem::store_u8(cpu, ram, ram_size, addr, res); }
            set_lazy(cpu, FlagOp::SubB, 0, res as u64);
        }
        4 => { // MUL AL
            let res = (cpu.regs[RAX] as u8 as u16).wrapping_mul(val as u16);
            cpu.regs[RAX] = (cpu.regs[RAX] & !0xFFFF) | res as u64;
            let overflow = (res >> 8) != 0;
            if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
            cpu.lazy.op = FlagOp::External;
        }
        5 => { // IMUL AL
            let res = (cpu.regs[RAX] as u8 as i8 as i16).wrapping_mul(val as i8 as i16);
            cpu.regs[RAX] = (cpu.regs[RAX] & !0xFFFF) | (res as u16 as u64);
            let overflow = res != (res as i8 as i16);
            if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
            cpu.lazy.op = FlagOp::External;
        }
        6 => { // DIV AL
            if val == 0 { raise_exception(cpu, EXC_DE, 0); return; }
            let dividend = cpu.regs[RAX] as u16;
            let quot = dividend / val as u16;
            let rem = dividend % val as u16;
            if quot > 0xFF { raise_exception(cpu, EXC_DE, 0); return; }
            cpu.regs[RAX] = (cpu.regs[RAX] & !0xFFFF) | (quot & 0xFF) as u64 | ((rem & 0xFF) as u64) << 8;
        }
        7 => { // IDIV AL
            if val == 0 { raise_exception(cpu, EXC_DE, 0); return; }
            let dividend = cpu.regs[RAX] as u16 as i16;
            let divisor = val as i8 as i16;
            let quot = dividend / divisor;
            let rem = dividend % divisor;
            if quot > 127 || quot < -128 { raise_exception(cpu, EXC_DE, 0); return; }
            cpu.regs[RAX] = (cpu.regs[RAX] & !0xFFFF) | (quot as u8 as u64) | ((rem as u8 as u64) << 8);
        }
        _ => {}
    }
}

#[inline(always)]
unsafe fn grp3_ev(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32) {
    let op = ((modrm >> 3) & 7) as usize;
    let rm = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
    let is_reg = modrm & 0xC0 == 0xC0;

    match lane {
        LANE32 => {
            let (val, addr) = if is_reg { (cpu.regs[rm] as u32, 0u64) }
                              else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                     (match mem::load_u32(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a) };
            match op {
                0 | 1 => {
                    let imm = match fetch_imm32(cpu, ram, ram_size) { Ok(v)=>v, Err(_)=>return };
                    set_lazy(cpu, FlagOp::AndL, 0, (val & imm) as u64);
                }
                2 => { let r = !val; if is_reg { cpu.regs[rm] = r as u64; } else { let _ = mem::store_u32(cpu, ram, ram_size, addr, r); } }
                3 => {
                    let r = (0u32).wrapping_sub(val);
                    if is_reg { cpu.regs[rm] = r as u64; } else { let _ = mem::store_u32(cpu, ram, ram_size, addr, r); }
                    set_lazy(cpu, FlagOp::SubL, 0, r as u64);
                }
                4 => { // MUL EAX
                    let res = (cpu.regs[RAX] as u32 as u64).wrapping_mul(val as u64);
                    cpu.regs[RAX] = res as u32 as u64;
                    cpu.regs[RDX] = (res >> 32) as u32 as u64;
                    let overflow = cpu.regs[RDX] != 0;
                    if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                5 => { // IMUL EAX
                    let res = (cpu.regs[RAX] as u32 as i32 as i64).wrapping_mul(val as i32 as i64);
                    cpu.regs[RAX] = res as u32 as u64;
                    cpu.regs[RDX] = (res >> 32) as u32 as u64;
                    let overflow = res != res as i32 as i64;
                    if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                6 => { // DIV EAX
                    if val == 0 { raise_exception(cpu, EXC_DE, 0); return; }
                    let dividend = ((cpu.regs[RDX] as u32 as u64) << 32) | (cpu.regs[RAX] as u32 as u64);
                    let divisor = val as u64;
                    let quot = dividend / divisor;
                    let rem = dividend % divisor;
                    if quot > 0xFFFFFFFF { raise_exception(cpu, EXC_DE, 0); return; }
                    cpu.regs[RAX] = quot as u32 as u64;
                    cpu.regs[RDX] = rem as u32 as u64;
                }
                7 => { // IDIV EAX
                    if val == 0 { raise_exception(cpu, EXC_DE, 0); return; }
                    let dividend = (((cpu.regs[RDX] as u32 as u64) << 32) | (cpu.regs[RAX] as u32 as u64)) as i64;
                    let divisor = val as i32 as i64;
                    let quot = dividend / divisor;
                    let rem = dividend % divisor;
                    if quot > i32::MAX as i64 || quot < i32::MIN as i64 { raise_exception(cpu, EXC_DE, 0); return; }
                    cpu.regs[RAX] = quot as u32 as u64;
                    cpu.regs[RDX] = rem as u32 as u64;
                }
                _ => {}
            }
        }
        LANE64 => {
            let (val, addr) = if is_reg { (cpu.regs[rm], 0u64) }
                              else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                     (match mem::load_u64(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a) };
            match op {
                0 | 1 => {
                    let imm = match fetch_imm32(cpu, ram, ram_size) { Ok(v) => v as i32 as u64, Err(_)=>return };
                    set_lazy(cpu, FlagOp::AndQ, 0, val & imm);
                }
                2 => { let r = !val; if is_reg { cpu.regs[rm] = r; } else { let _ = mem::store_u64(cpu, ram, ram_size, addr, r); } }
                3 => {
                    let r = (0u64).wrapping_sub(val);
                    if is_reg { cpu.regs[rm] = r; } else { let _ = mem::store_u64(cpu, ram, ram_size, addr, r); }
                    set_lazy(cpu, FlagOp::SubQ, 0, r);
                }
                4 => { // MUL RAX
                    let res = (cpu.regs[RAX] as u128).wrapping_mul(val as u128);
                    cpu.regs[RAX] = res as u64;
                    cpu.regs[RDX] = (res >> 64) as u64;
                    let overflow = cpu.regs[RDX] != 0;
                    if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                5 => { // IMUL RAX
                    let res = (cpu.regs[RAX] as i64 as i128).wrapping_mul(val as i64 as i128);
                    cpu.regs[RAX] = res as u64;
                    cpu.regs[RDX] = (res >> 64) as u64;
                    let overflow = res != res as i64 as i128;
                    if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                6 => { // DIV RAX
                    if val == 0 { raise_exception(cpu, EXC_DE, 0); return; }
                    let dividend = ((cpu.regs[RDX] as u128) << 64) | (cpu.regs[RAX] as u128);
                    let divisor = val as u128;
                    let quot = dividend / divisor;
                    let rem = dividend % divisor;
                    if quot > u64::MAX as u128 { raise_exception(cpu, EXC_DE, 0); return; }
                    cpu.regs[RAX] = quot as u64;
                    cpu.regs[RDX] = rem as u64;
                }
                7 => { // IDIV RAX
                    if val == 0 { raise_exception(cpu, EXC_DE, 0); return; }
                    let dividend = ((cpu.regs[RDX] as u128) << 64 | cpu.regs[RAX] as u128) as i128;
                    let divisor = val as i64 as i128;
                    let quot = dividend / divisor;
                    let rem = dividend % divisor;
                    if quot > i64::MAX as i128 || quot < i64::MIN as i128 { raise_exception(cpu, EXC_DE, 0); return; }
                    cpu.regs[RAX] = quot as u64;
                    cpu.regs[RDX] = rem as u64;
                }
                _ => {}
            }
        }
        _ => { // LANE16
            let (val, addr) = if is_reg { (cpu.regs[rm] as u16, 0u64) }
                              else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                     (match mem::load_u16(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a) };
            match op {
                0 | 1 => {
                    let imm = match fetch_imm16(cpu, ram, ram_size) { Ok(v)=>v, Err(_)=>return };
                    set_lazy(cpu, FlagOp::AndW, 0, (val & imm) as u64);
                }
                2 => { let r = !val; if is_reg { write_reg16(cpu, rm, r); } else { let _ = mem::store_u16(cpu, ram, ram_size, addr, r); } }
                3 => {
                    let r = (0u16).wrapping_sub(val);
                    if is_reg { write_reg16(cpu, rm, r); } else { let _ = mem::store_u16(cpu, ram, ram_size, addr, r); }
                    set_lazy(cpu, FlagOp::SubW, 0, r as u64);
                }
                4 => {
                    let res = (cpu.regs[RAX] as u16 as u32).wrapping_mul(val as u32);
                    write_reg16(cpu, RAX, res as u16);
                    write_reg16(cpu, RDX, (res >> 16) as u16);
                    let overflow = (res >> 16) != 0;
                    if overflow { cpu.rflags |= CF | OF; } else { cpu.rflags &= !(CF | OF); }
                    cpu.lazy.op = FlagOp::External;
                }
                _ => {} // TODO: IMUL/DIV/IDIV 16-bit
            }
        }
    }
}

// ============================================================
// GRP5 — INC/DEC/CALL/JMP/PUSH Ev
// ============================================================

#[inline(always)]
unsafe fn grp5(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lane: u32) {
    let op = ((modrm >> 3) & 7) as usize;
    let rm = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
    let is_reg = modrm & 0xC0 == 0xC0;

    match op {
        0 | 1 => { // INC/DEC Ev
            match lane {
                LANE16 => {
                    let (val, addr) = if is_reg { (cpu.regs[rm] as u16, 0u64) }
                                      else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                             (match mem::load_u16(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a) };
                    let (res, fop) = if op == 0 { (val.wrapping_add(1), FlagOp::IncW) } else { (val.wrapping_sub(1), FlagOp::DecW) };
                    if is_reg { write_reg16(cpu, rm, res); } else { let _ = mem::store_u16(cpu, ram, ram_size, addr, res); }
                    set_lazy(cpu, fop, val as u64, res as u64);
                }
                LANE32 => {
                    let (val, addr) = if is_reg { (cpu.regs[rm] as u32, 0u64) }
                                      else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                             (match mem::load_u32(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a) };
                    let (res, fop) = if op == 0 { (val.wrapping_add(1), FlagOp::IncL) } else { (val.wrapping_sub(1), FlagOp::DecL) };
                    if is_reg { cpu.regs[rm] = res as u64; } else { let _ = mem::store_u32(cpu, ram, ram_size, addr, res); }
                    set_lazy(cpu, fop, val as u64, res as u64);
                }
                _ => {
                    let (val, addr) = if is_reg { (cpu.regs[rm], 0u64) }
                                      else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                             (match mem::load_u64(cpu, ram, ram_size, a) { Ok(v)=>v, Err(_)=>return }, a) };
                    let (res, fop) = if op == 0 { (val.wrapping_add(1), FlagOp::IncQ) } else { (val.wrapping_sub(1), FlagOp::DecQ) };
                    if is_reg { cpu.regs[rm] = res; } else { let _ = mem::store_u64(cpu, ram, ram_size, addr, res); }
                    set_lazy(cpu, fop, val, res);
                }
            }
        }
        2 => { // CALL indirect
            let target = if is_reg { cpu.regs[rm] }
                         else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                match lane {
                                    LANE16 => match mem::load_u16(cpu, ram, ram_size, a) { Ok(v) => v as u64, Err(_)=>return },
                                    LANE32 => match mem::load_u32(cpu, ram, ram_size, a) { Ok(v) => v as u64, Err(_)=>return },
                                    _ => match mem::load_u64(cpu, ram, ram_size, a) { Ok(v) => v, Err(_)=>return },
                                }
                         };
            let ret = cpu.rip;
            if cpu.long_mode {
                cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                let _ = mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], ret);
            } else {
                cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                let _ = mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], ret as u32);
            }
            cpu.rip = target;
        }
        4 => { // JMP indirect
            let target = if is_reg { cpu.regs[rm] }
                         else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                                match lane {
                                    LANE16 => match mem::load_u16(cpu, ram, ram_size, a) { Ok(v) => v as u64, Err(_)=>return },
                                    LANE32 => match mem::load_u32(cpu, ram, ram_size, a) { Ok(v) => v as u64, Err(_)=>return },
                                    _ => match mem::load_u64(cpu, ram, ram_size, a) { Ok(v) => v, Err(_)=>return },
                                }
                         };
            cpu.rip = target;
        }
        6 => { // PUSH Ev
            let val = if is_reg { cpu.regs[rm] }
                      else { let a = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v)=>v, Err(_)=>return };
                             match lane {
                                 LANE16 => match mem::load_u16(cpu, ram, ram_size, a) { Ok(v) => v as u64, Err(_)=>return },
                                 LANE32 => match mem::load_u32(cpu, ram, ram_size, a) { Ok(v) => v as u64, Err(_)=>return },
                                 _ => match mem::load_u64(cpu, ram, ram_size, a) { Ok(v) => v, Err(_)=>return },
                             }
                      };
            if cpu.long_mode {
                cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                let _ = mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], val);
            } else if lane == LANE16 {
                cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(2);
                let _ = mem::store_u16(cpu, ram, ram_size, cpu.regs[RSP], val as u16);
            } else {
                cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                let _ = mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], val as u32);
            }
        }
        _ => {} // 3=CALL far, 5=JMP far — TODO
    }
}

// (string helpers are defined earlier in the file, above this point)

/// SHLD: double-precision left shift. Returns u64::MAX if count==0 (no-op sentinel).
#[inline(always)]
unsafe fn exec_shld(dst: u64, fill: u64, count: u64, lane: u32) -> u64 {
    let mask = if lane == LANE64 { 63u64 } else { 31 };
    let count = count & mask;
    if count == 0 { return u64::MAX; }
    match lane {
        LANE16 => {
            let combined = ((dst as u16 as u32) << 16) | (fill as u16 as u32);
            let res = (combined << count) >> 16;
            res as u16 as u64
        }
        LANE32 => {
            let combined = ((dst as u32 as u64) << 32) | (fill as u32 as u64);
            let res = (combined << count) >> 32;
            res as u32 as u64
        }
        _ => {
            let combined = ((dst as u128) << 64) | (fill as u128);
            let res = (combined << count) >> 64;
            res as u64
        }
    }
}

/// SHRD: double-precision right shift. Returns u64::MAX if count==0 (no-op sentinel).
#[inline(always)]
unsafe fn exec_shrd(dst: u64, fill: u64, count: u64, lane: u32) -> u64 {
    let mask = if lane == LANE64 { 63u64 } else { 31 };
    let count = count & mask;
    if count == 0 { return u64::MAX; }
    match lane {
        LANE16 => {
            let combined = ((fill as u16 as u32) << 16) | (dst as u16 as u32);
            let res = combined >> count;
            res as u16 as u64
        }
        LANE32 => {
            let combined = ((fill as u32 as u64) << 32) | (dst as u32 as u64);
            let res = combined >> count;
            res as u32 as u64
        }
        _ => {
            let combined = ((fill as u128) << 64) | (dst as u128);
            let res = combined >> count;
            res as u64
        }
    }
}

// ============================================================
// x87 FPU helpers
// ============================================================

#[inline(always)]
fn fpu_st(cpu: &Cpu, i: u8) -> f64 {
    let idx = ((cpu.fpu.top.wrapping_add(i)) & 7) as usize;
    f64::from_bits(cpu.fpu.regs[idx])
}

#[inline(always)]
fn fpu_set_st(cpu: &mut Cpu, i: u8, val: f64) {
    let idx = ((cpu.fpu.top.wrapping_add(i)) & 7) as usize;
    cpu.fpu.regs[idx] = val.to_bits();
    // Mark tag as valid (0)
    let tag_idx = idx * 2;
    cpu.fpu.tag &= !(3 << tag_idx);
}

#[inline(always)]
fn fpu_push(cpu: &mut Cpu, val: f64) {
    cpu.fpu.top = cpu.fpu.top.wrapping_sub(1) & 7;
    let idx = cpu.fpu.top as usize;
    cpu.fpu.regs[idx] = val.to_bits();
    let tag_idx = idx * 2;
    cpu.fpu.tag &= !(3 << tag_idx);
}

#[inline(always)]
fn fpu_pop(cpu: &mut Cpu) -> f64 {
    let idx = cpu.fpu.top as usize;
    let val = f64::from_bits(cpu.fpu.regs[idx]);
    // Mark tag as empty (3)
    let tag_idx = idx * 2;
    cpu.fpu.tag |= 3 << tag_idx;
    cpu.fpu.top = cpu.fpu.top.wrapping_add(1) & 7;
    val
}

/// Set FPU condition codes C0/C2/C3 for comparison
#[inline(always)]
fn fpu_set_cc(cpu: &mut Cpu, c0: bool, c2: bool, c3: bool) {
    cpu.fpu.status &= !(0x4500); // clear C0(bit8), C2(bit10), C3(bit14)
    if c0 { cpu.fpu.status |= 0x0100; }
    if c2 { cpu.fpu.status |= 0x0400; }
    if c3 { cpu.fpu.status |= 0x4000; }
}

/// Compare two FPU values, set C0/C2/C3
#[inline(always)]
fn fpu_compare(cpu: &mut Cpu, a: f64, b: f64) {
    if a.is_nan() || b.is_nan() {
        fpu_set_cc(cpu, true, true, true); // unordered
    } else if a > b {
        fpu_set_cc(cpu, false, false, false);
    } else if a < b {
        fpu_set_cc(cpu, true, false, false);
    } else {
        fpu_set_cc(cpu, false, false, true); // equal
    }
}

/// The main FPU dispatcher.
#[inline(always)]
unsafe fn exec_fpu(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, fpu_op: u8, modrm: u8) {
    let reg_field = (modrm >> 3) & 7;
    let is_mem = modrm & 0xC0 != 0xC0;
    let st_i = modrm & 7;

    match fpu_op {
        // D8 — FADD/FMUL/FCOM/FCOMP/FSUB/FSUBR/FDIV/FDIVR (m32fp or ST(0),ST(i))
        0 => {
            let val = if is_mem {
                let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                let bits = match mem::load_u32(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => return };
                f32::from_bits(bits) as f64
            } else {
                fpu_st(cpu, st_i)
            };
            let st0 = fpu_st(cpu, 0);
            match reg_field {
                0 => fpu_set_st(cpu, 0, st0 + val),
                1 => fpu_set_st(cpu, 0, st0 * val),
                2 => fpu_compare(cpu, st0, val),
                3 => { fpu_compare(cpu, st0, val); fpu_pop(cpu); }
                4 => fpu_set_st(cpu, 0, st0 - val),
                5 => fpu_set_st(cpu, 0, val - st0),
                6 => fpu_set_st(cpu, 0, st0 / val),
                7 => fpu_set_st(cpu, 0, val / st0),
                _ => {}
            }
        }
        // D9 — FLD/FST/FSTP/FLDCW/FNSTCW/misc
        1 => {
            if is_mem {
                match reg_field {
                    0 => { // FLD m32fp
                        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                        let bits = match mem::load_u32(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => return };
                        fpu_push(cpu, f32::from_bits(bits) as f64);
                    }
                    2 => { // FST m32fp
                        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                        let val = fpu_st(cpu, 0) as f32;
                        let _ = mem::store_u32(cpu, ram, ram_size, addr, val.to_bits());
                    }
                    3 => { // FSTP m32fp
                        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                        let val = fpu_pop(cpu) as f32;
                        let _ = mem::store_u32(cpu, ram, ram_size, addr, val.to_bits());
                    }
                    4 => { // FLDENV (14/28 bytes) — simplified
                        let _addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                        // Simplified: just consume the address
                    }
                    5 => { // FLDCW
                        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                        cpu.fpu.control = match mem::load_u16(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => return };
                    }
                    6 => { // FNSTENV — simplified
                        let _addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                    }
                    7 => { // FNSTCW
                        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                        let _ = mem::store_u16(cpu, ram, ram_size, addr, cpu.fpu.control);
                    }
                    _ => {}
                }
            } else {
                // Register forms
                match modrm {
                    0xC0..=0xC7 => { // FLD ST(i)
                        let val = fpu_st(cpu, st_i);
                        fpu_push(cpu, val);
                    }
                    0xC8..=0xCF => { // FXCH ST(i)
                        let a = fpu_st(cpu, 0);
                        let b = fpu_st(cpu, st_i);
                        fpu_set_st(cpu, 0, b);
                        fpu_set_st(cpu, st_i, a);
                    }
                    0xD0 => {} // FNOP
                    0xE0 => fpu_set_st(cpu, 0, -fpu_st(cpu, 0)), // FCHS
                    0xE1 => fpu_set_st(cpu, 0, libm::fabs(fpu_st(cpu, 0))), // FABS
                    0xE4 => { // FTST
                        fpu_compare(cpu, fpu_st(cpu, 0), 0.0);
                    }
                    0xE5 => { // FXAM — simplified: set C1 for sign
                        let val = fpu_st(cpu, 0);
                        cpu.fpu.status &= !0x4700;
                        if val.is_sign_negative() { cpu.fpu.status |= 0x0200; } // C1
                        if val.is_nan() { cpu.fpu.status |= 0x0100; } // C0
                        else if val.is_infinite() { cpu.fpu.status |= 0x0500; } // C0+C2
                        else if val == 0.0 { cpu.fpu.status |= 0x4000; } // C3
                        // else: normal — all clear
                    }
                    0xE8 => fpu_push(cpu, 1.0),   // FLD1
                    0xE9 => fpu_push(cpu, core::f64::consts::LOG2_10), // FLDL2T
                    0xEA => fpu_push(cpu, core::f64::consts::LOG2_E),  // FLDL2E
                    0xEB => fpu_push(cpu, core::f64::consts::PI),      // FLDPI
                    0xEC => fpu_push(cpu, core::f64::consts::LOG10_2), // FLDLG2
                    0xED => fpu_push(cpu, core::f64::consts::LN_2),    // FLDLN2
                    0xEE => fpu_push(cpu, 0.0),    // FLDZ
                    0xF0 => { // F2XM1: ST(0) = 2^ST(0) - 1
                        let x = fpu_st(cpu, 0);
                        fpu_set_st(cpu, 0, libm::pow(2.0, x) - 1.0);
                    }
                    0xF1 => { // FYL2X: ST(1) = ST(1) * log2(ST(0)), pop
                        let x = fpu_st(cpu, 0);
                        let y = fpu_st(cpu, 1);
                        fpu_pop(cpu);
                        fpu_set_st(cpu, 0, y * libm::log2(x));
                    }
                    0xF2 => { // FPTAN: ST(0) = tan(ST(0)), push 1.0
                        let x = fpu_st(cpu, 0);
                        fpu_set_st(cpu, 0, libm::tan(x));
                        fpu_push(cpu, 1.0);
                    }
                    0xF3 => { // FPATAN: ST(1) = atan2(ST(1), ST(0)), pop
                        let x = fpu_st(cpu, 0);
                        let y = fpu_st(cpu, 1);
                        fpu_pop(cpu);
                        fpu_set_st(cpu, 0, libm::atan2(y, x));
                    }
                    0xF4 => { // FXTRACT: exponent → ST(0), significand → push
                        let val = fpu_st(cpu, 0);
                        if val == 0.0 {
                            fpu_set_st(cpu, 0, f64::NEG_INFINITY);
                            fpu_push(cpu, 0.0);
                        } else {
                            let (_, exp) = frexp_f64(val);
                            fpu_set_st(cpu, 0, (exp - 1) as f64);
                            let sig = val / libm::pow(2.0, (exp - 1) as f64);
                            fpu_push(cpu, sig);
                        }
                    }
                    0xF5 => { // FPREM1: IEEE remainder
                        let st0 = fpu_st(cpu, 0);
                        let st1 = fpu_st(cpu, 1);
                        if st1 != 0.0 {
                            fpu_set_st(cpu, 0, st0 % st1);
                        }
                        cpu.fpu.status &= !0x0400; // clear C2 (reduction complete)
                    }
                    0xF6 => { // FDECSTP
                        cpu.fpu.top = cpu.fpu.top.wrapping_sub(1) & 7;
                    }
                    0xF7 => { // FINCSTP
                        cpu.fpu.top = cpu.fpu.top.wrapping_add(1) & 7;
                    }
                    0xF8 => { // FPREM: truncated remainder
                        let st0 = fpu_st(cpu, 0);
                        let st1 = fpu_st(cpu, 1);
                        if st1 != 0.0 {
                            let q = libm::trunc(st0 / st1);
                            fpu_set_st(cpu, 0, st0 - q * st1);
                        }
                        cpu.fpu.status &= !0x0400; // clear C2
                    }
                    0xF9 => { // FYL2XP1: ST(1) = ST(1) * log2(ST(0) + 1), pop
                        let x = fpu_st(cpu, 0);
                        let y = fpu_st(cpu, 1);
                        fpu_pop(cpu);
                        fpu_set_st(cpu, 0, y * libm::log2(x + 1.0));
                    }
                    0xFA => { // FSQRT
                        fpu_set_st(cpu, 0, libm::sqrt(fpu_st(cpu, 0)));
                    }
                    0xFB => { // FSINCOS: push cos, ST(0)=sin (after push ST(1)=sin)
                        let x = fpu_st(cpu, 0);
                        fpu_set_st(cpu, 0, libm::sin(x));
                        fpu_push(cpu, libm::cos(x));
                    }
                    0xFC => { // FRNDINT
                        let val = fpu_st(cpu, 0);
                        let rc = (cpu.fpu.control >> 10) & 3;
                        let rounded = match rc {
                            0 => libm::round(val), // nearest
                            1 => libm::floor(val), // down
                            2 => libm::ceil(val),  // up
                            _ => libm::trunc(val), // truncate
                        };
                        fpu_set_st(cpu, 0, rounded);
                    }
                    0xFD => { // FSCALE: ST(0) = ST(0) * 2^trunc(ST(1))
                        let st0 = fpu_st(cpu, 0);
                        let st1 = fpu_st(cpu, 1);
                        fpu_set_st(cpu, 0, st0 * libm::pow(2.0, libm::trunc(st1)));
                    }
                    0xFE => { // FSIN
                        fpu_set_st(cpu, 0, libm::sin(fpu_st(cpu, 0)));
                        cpu.fpu.status &= !0x0400; // clear C2
                    }
                    0xFF => { // FCOS
                        fpu_set_st(cpu, 0, libm::cos(fpu_st(cpu, 0)));
                        cpu.fpu.status &= !0x0400; // clear C2
                    }
                    _ => {} // other D9 register forms — ignore
                }
            }
        }
        // DA — FIADD/FIMUL/etc m32int or FCMOVcc
        2 => {
            if is_mem {
                let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                let ival = match mem::load_u32(cpu, ram, ram_size, addr) { Ok(v) => v as i32 as f64, Err(_) => return };
                let st0 = fpu_st(cpu, 0);
                match reg_field {
                    0 => fpu_set_st(cpu, 0, st0 + ival),
                    1 => fpu_set_st(cpu, 0, st0 * ival),
                    2 => fpu_compare(cpu, st0, ival),
                    3 => { fpu_compare(cpu, st0, ival); fpu_pop(cpu); }
                    4 => fpu_set_st(cpu, 0, st0 - ival),
                    5 => fpu_set_st(cpu, 0, ival - st0),
                    6 => fpu_set_st(cpu, 0, st0 / ival),
                    7 => fpu_set_st(cpu, 0, ival / st0),
                    _ => {}
                }
            } else {
                // FCMOVcc ST(0), ST(i) — conditional move based on EFLAGS
                let flags = materialize_flags(cpu);
                let cond = match reg_field {
                    0 => flags & CF != 0,      // FCMOVB
                    1 => flags & ZF != 0,      // FCMOVE
                    2 => flags & (CF|ZF) != 0, // FCMOVBE
                    3 => flags & PF != 0,      // FCMOVU
                    _ => false,
                };
                if cond {
                    let val = fpu_st(cpu, st_i);
                    fpu_set_st(cpu, 0, val);
                }
            }
        }
        // DB — FILD m32int / FCOMI / FNINIT
        3 => {
            if is_mem {
                let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                match reg_field {
                    0 => { // FILD m32int
                        let val = match mem::load_u32(cpu, ram, ram_size, addr) { Ok(v) => v as i32 as f64, Err(_) => return };
                        fpu_push(cpu, val);
                    }
                    1 => { // FISTTP m32int
                        let val = fpu_pop(cpu) as i32;
                        let _ = mem::store_u32(cpu, ram, ram_size, addr, val as u32);
                    }
                    2 => { // FIST m32int
                        let val = fpu_st(cpu, 0) as i32;
                        let _ = mem::store_u32(cpu, ram, ram_size, addr, val as u32);
                    }
                    3 => { // FISTP m32int
                        let val = fpu_pop(cpu) as i32;
                        let _ = mem::store_u32(cpu, ram, ram_size, addr, val as u32);
                    }
                    5 => { // FLD m80fp — simplified: load as f64 (80-bit → 64-bit)
                        let lo = match mem::load_u64(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => return };
                        let hi = match mem::load_u16(cpu, ram, ram_size, addr.wrapping_add(8)) { Ok(v) => v, Err(_) => return };
                        let val = ld80_to_f64(lo, hi);
                        fpu_push(cpu, val);
                    }
                    7 => { // FSTP m80fp — simplified: store as 80-bit from f64
                        let val = fpu_pop(cpu);
                        let (lo, hi) = f64_to_ld80(val);
                        let _ = mem::store_u64(cpu, ram, ram_size, addr, lo);
                        let _ = mem::store_u16(cpu, ram, ram_size, addr.wrapping_add(8), hi);
                    }
                    _ => {}
                }
            } else {
                match modrm {
                    0xE3 => { // FNINIT — reset FPU
                        cpu.fpu.control = 0x037F;
                        cpu.fpu.status = 0;
                        cpu.fpu.tag = 0xFFFF;
                        cpu.fpu.top = 0;
                    }
                    0xE4 => { // FNSETPM — no-op (286 compat)
                    }
                    0xE0..=0xE7 if reg_field == 4 => { // FCMOVNB/FCMOVNE/FCMOVNBE/FCMOVNU — handled below
                        let flags = materialize_flags(cpu);
                        let cond = match modrm & 3 {
                            0 => flags & CF == 0,      // FCMOVNB
                            1 => flags & ZF == 0,      // FCMOVNE
                            2 => flags & (CF|ZF) == 0, // FCMOVNBE
                            3 => flags & PF == 0,      // FCMOVNU
                            _ => false,
                        };
                        if cond {
                            let val = fpu_st(cpu, st_i);
                            fpu_set_st(cpu, 0, val);
                        }
                    }
                    0xE8..=0xEF => { // FUCOMI ST(0), ST(i)
                        let a = fpu_st(cpu, 0);
                        let b = fpu_st(cpu, st_i);
                        materialize_flags(cpu);
                        cpu.rflags &= !(CF | ZF | PF);
                        if a.is_nan() || b.is_nan() {
                            cpu.rflags |= CF | ZF | PF;
                        } else if a < b {
                            cpu.rflags |= CF;
                        } else if a == b {
                            cpu.rflags |= ZF;
                        }
                        cpu.lazy.op = FlagOp::External;
                    }
                    0xF0..=0xF7 => { // FCOMI ST(0), ST(i)
                        let a = fpu_st(cpu, 0);
                        let b = fpu_st(cpu, st_i);
                        materialize_flags(cpu);
                        cpu.rflags &= !(CF | ZF | PF);
                        if a.is_nan() || b.is_nan() {
                            cpu.rflags |= CF | ZF | PF;
                        } else if a < b {
                            cpu.rflags |= CF;
                        } else if a == b {
                            cpu.rflags |= ZF;
                        }
                        cpu.lazy.op = FlagOp::External;
                    }
                    _ => {} // DB register forms with reg_field 5/6 for FCMOVNx
                }
            }
        }
        // DC — FADD/FMUL/FCOM/etc m64fp or ST(i),ST(0)
        4 => {
            if is_mem {
                let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                let bits = match mem::load_u64(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => return };
                let val = f64::from_bits(bits);
                let st0 = fpu_st(cpu, 0);
                match reg_field {
                    0 => fpu_set_st(cpu, 0, st0 + val),
                    1 => fpu_set_st(cpu, 0, st0 * val),
                    2 => fpu_compare(cpu, st0, val),
                    3 => { fpu_compare(cpu, st0, val); fpu_pop(cpu); }
                    4 => fpu_set_st(cpu, 0, st0 - val),
                    5 => fpu_set_st(cpu, 0, val - st0),
                    6 => fpu_set_st(cpu, 0, st0 / val),
                    7 => fpu_set_st(cpu, 0, val / st0),
                    _ => {}
                }
            } else {
                // DC C0-FF: ops on ST(i), ST(0) — note reversed operand order for SUB/DIV
                let st0 = fpu_st(cpu, 0);
                let sti = fpu_st(cpu, st_i);
                match reg_field {
                    0 => fpu_set_st(cpu, st_i, sti + st0), // FADD ST(i),ST(0)
                    1 => fpu_set_st(cpu, st_i, sti * st0), // FMUL
                    4 => fpu_set_st(cpu, st_i, sti - st0), // FSUBR (reversed in encoding)
                    5 => fpu_set_st(cpu, st_i, st0 - sti), // FSUB
                    6 => fpu_set_st(cpu, st_i, sti / st0), // FDIVR
                    7 => fpu_set_st(cpu, st_i, st0 / sti), // FDIV
                    _ => {}
                }
            }
        }
        // DD — FLD/FST/FSTP m64fp, FFREE, FUCOM
        5 => {
            if is_mem {
                let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                match reg_field {
                    0 => { // FLD m64fp
                        let bits = match mem::load_u64(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => return };
                        fpu_push(cpu, f64::from_bits(bits));
                    }
                    1 => { // FISTTP m64int
                        let val = fpu_pop(cpu) as i64;
                        let _ = mem::store_u64(cpu, ram, ram_size, addr, val as u64);
                    }
                    2 => { // FST m64fp
                        let val = fpu_st(cpu, 0);
                        let _ = mem::store_u64(cpu, ram, ram_size, addr, val.to_bits());
                    }
                    3 => { // FSTP m64fp
                        let val = fpu_pop(cpu);
                        let _ = mem::store_u64(cpu, ram, ram_size, addr, val.to_bits());
                    }
                    4 => { // FRSTOR (simplified — skip)
                    }
                    6 => { // FNSAVE (simplified — skip)
                    }
                    7 => { // FNSTSW m16
                        let sw = (cpu.fpu.status & 0xC7FF) | ((cpu.fpu.top as u16) << 11);
                        let _ = mem::store_u16(cpu, ram, ram_size, addr, sw);
                    }
                    _ => {}
                }
            } else {
                match reg_field {
                    0 => { // FFREE ST(i)
                        let idx = ((cpu.fpu.top.wrapping_add(st_i)) & 7) as usize;
                        let tag_idx = idx * 2;
                        cpu.fpu.tag |= 3 << tag_idx;
                    }
                    2 => { // FST ST(i)
                        let val = fpu_st(cpu, 0);
                        fpu_set_st(cpu, st_i, val);
                    }
                    3 => { // FSTP ST(i)
                        let val = fpu_st(cpu, 0);
                        fpu_set_st(cpu, st_i, val);
                        fpu_pop(cpu);
                    }
                    4 => { // FUCOM ST(i)
                        fpu_compare(cpu, fpu_st(cpu, 0), fpu_st(cpu, st_i));
                    }
                    5 => { // FUCOMP ST(i)
                        fpu_compare(cpu, fpu_st(cpu, 0), fpu_st(cpu, st_i));
                        fpu_pop(cpu);
                    }
                    _ => {}
                }
            }
        }
        // DE — FIADD/FIMUL/etc m16int or FADDP/FMULP/etc
        6 => {
            if is_mem {
                let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                let ival = match mem::load_u16(cpu, ram, ram_size, addr) { Ok(v) => v as i16 as f64, Err(_) => return };
                let st0 = fpu_st(cpu, 0);
                match reg_field {
                    0 => fpu_set_st(cpu, 0, st0 + ival),
                    1 => fpu_set_st(cpu, 0, st0 * ival),
                    2 => fpu_compare(cpu, st0, ival),
                    3 => { fpu_compare(cpu, st0, ival); fpu_pop(cpu); }
                    4 => fpu_set_st(cpu, 0, st0 - ival),
                    5 => fpu_set_st(cpu, 0, ival - st0),
                    6 => fpu_set_st(cpu, 0, st0 / ival),
                    7 => fpu_set_st(cpu, 0, ival / st0),
                    _ => {}
                }
            } else {
                // FADDP/FMULP/FCOMPP/FSUBRP/FSUBP/FDIVRP/FDIVP
                let st0 = fpu_st(cpu, 0);
                let sti = fpu_st(cpu, st_i);
                match reg_field {
                    0 => { fpu_set_st(cpu, st_i, sti + st0); fpu_pop(cpu); } // FADDP
                    1 => { fpu_set_st(cpu, st_i, sti * st0); fpu_pop(cpu); } // FMULP
                    3 => { // FCOMPP (DE D9) — compare and pop twice
                        fpu_compare(cpu, st0, fpu_st(cpu, 1));
                        fpu_pop(cpu); fpu_pop(cpu);
                    }
                    4 => { fpu_set_st(cpu, st_i, sti - st0); fpu_pop(cpu); } // FSUBRP
                    5 => { fpu_set_st(cpu, st_i, st0 - sti); fpu_pop(cpu); } // FSUBP
                    6 => { fpu_set_st(cpu, st_i, sti / st0); fpu_pop(cpu); } // FDIVRP
                    7 => { fpu_set_st(cpu, st_i, st0 / sti); fpu_pop(cpu); } // FDIVP
                    _ => {}
                }
            }
        }
        // DF — FILD m16int / FISTP / FNSTSW AX / FUCOMIP/FCOMIP
        7 => {
            if is_mem {
                let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
                match reg_field {
                    0 => { // FILD m16int
                        let val = match mem::load_u16(cpu, ram, ram_size, addr) { Ok(v) => v as i16 as f64, Err(_) => return };
                        fpu_push(cpu, val);
                    }
                    1 => { // FISTTP m16int
                        let val = fpu_pop(cpu) as i16;
                        let _ = mem::store_u16(cpu, ram, ram_size, addr, val as u16);
                    }
                    2 => { // FIST m16int
                        let val = fpu_st(cpu, 0) as i16;
                        let _ = mem::store_u16(cpu, ram, ram_size, addr, val as u16);
                    }
                    3 => { // FISTP m16int
                        let val = fpu_pop(cpu) as i16;
                        let _ = mem::store_u16(cpu, ram, ram_size, addr, val as u16);
                    }
                    5 => { // FILD m64int
                        let val = match mem::load_u64(cpu, ram, ram_size, addr) { Ok(v) => v as i64 as f64, Err(_) => return };
                        fpu_push(cpu, val);
                    }
                    7 => { // FISTP m64int
                        let val = fpu_pop(cpu) as i64;
                        let _ = mem::store_u64(cpu, ram, ram_size, addr, val as u64);
                    }
                    _ => {}
                }
            } else {
                match modrm {
                    0xE0 => { // FNSTSW AX
                        let sw = (cpu.fpu.status & 0xC7FF) | ((cpu.fpu.top as u16) << 11);
                        cpu.regs[RAX] = (cpu.regs[RAX] & !0xFFFF) | sw as u64;
                    }
                    0xE8..=0xEF => { // FUCOMIP ST(0), ST(i)
                        let a = fpu_st(cpu, 0);
                        let b = fpu_st(cpu, st_i);
                        materialize_flags(cpu);
                        cpu.rflags &= !(CF | ZF | PF);
                        if a.is_nan() || b.is_nan() {
                            cpu.rflags |= CF | ZF | PF;
                        } else if a < b {
                            cpu.rflags |= CF;
                        } else if a == b {
                            cpu.rflags |= ZF;
                        }
                        cpu.lazy.op = FlagOp::External;
                        fpu_pop(cpu);
                    }
                    0xF0..=0xF7 => { // FCOMIP ST(0), ST(i)
                        let a = fpu_st(cpu, 0);
                        let b = fpu_st(cpu, st_i);
                        materialize_flags(cpu);
                        cpu.rflags &= !(CF | ZF | PF);
                        if a.is_nan() || b.is_nan() {
                            cpu.rflags |= CF | ZF | PF;
                        } else if a < b {
                            cpu.rflags |= CF;
                        } else if a == b {
                            cpu.rflags |= ZF;
                        }
                        cpu.lazy.op = FlagOp::External;
                        fpu_pop(cpu);
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// Convert 80-bit x87 extended (mantissa + exp/sign word) to f64.
#[inline(always)]
fn ld80_to_f64(mantissa: u64, exp_sign: u16) -> f64 {
    let sign = (exp_sign >> 15) & 1;
    let exp = (exp_sign & 0x7FFF) as i32;
    if exp == 0 && mantissa == 0 {
        if sign != 0 { return -0.0; }
        return 0.0;
    }
    if exp == 0x7FFF {
        if mantissa == 0x8000000000000000 {
            return if sign != 0 { f64::NEG_INFINITY } else { f64::INFINITY };
        }
        return f64::NAN;
    }
    let f = (mantissa as f64) / (1u64 << 63) as f64;
    let result = f * libm::pow(2.0, (exp - 16383) as f64);
    if sign != 0 { -result } else { result }
}

/// Convert f64 to 80-bit x87 extended (mantissa, exp/sign word).
#[inline(always)]
fn f64_to_ld80(val: f64) -> (u64, u16) {
    if val == 0.0 {
        let sign = if val.is_sign_negative() { 0x8000u16 } else { 0u16 };
        return (0, sign);
    }
    if val.is_nan() { return (0xC000000000000000, 0x7FFF); }
    if val.is_infinite() {
        let sign = if val < 0.0 { 0x8000u16 } else { 0u16 };
        return (0x8000000000000000, sign | 0x7FFF);
    }
    let bits = val.to_bits();
    let sign = ((bits >> 63) & 1) as u16;
    let exp11 = ((bits >> 52) & 0x7FF) as i32;
    let frac52 = bits & 0x000FFFFFFFFFFFFF;
    let exp80 = (exp11 - 1023 + 16383) as u16;
    let mantissa = (1u64 << 63) | (frac52 << 11);
    (mantissa, (sign << 15) | exp80)
}

/// Simple frexp-like: extract (mantissa, exponent) where val = mantissa * 2^exp, 0.5 <= |mantissa| < 1
#[inline(always)]
fn frexp_f64(val: f64) -> (f64, i32) {
    if val == 0.0 { return (0.0, 0); }
    let bits = val.to_bits();
    let exp = ((bits >> 52) & 0x7FF) as i32 - 1022;
    let mantissa_bits = (bits & 0x800FFFFFFFFFFFFF) | 0x3FE0000000000000;
    (f64::from_bits(mantissa_bits), exp)
}

// ============================================================
// SSE/SSE2 helpers
// ============================================================

/// Load 128-bit from XMM register or memory via ModRM.
#[inline(always)]
unsafe fn load_xmm_rm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8) -> (u64, u64) {
    if modrm & 0xC0 == 0xC0 {
        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
        (cpu.sse.xmm[r][0], cpu.sse.xmm[r][1])
    } else {
        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return (0, 0) };
        let lo = match mem::load_u64(cpu, ram, ram_size, addr) { Ok(v) => v, Err(_) => return (0, 0) };
        let hi = match mem::load_u64(cpu, ram, ram_size, addr.wrapping_add(8)) { Ok(v) => v, Err(_) => return (0, 0) };
        (lo, hi)
    }
}

/// Store 128-bit to XMM register or memory via ModRM.
#[inline(always)]
unsafe fn store_xmm_rm(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, modrm: u8, lo: u64, hi: u64) {
    if modrm & 0xC0 == 0xC0 {
        let r = (modrm & 7) as usize | ((cpu.prefix.rex as usize & 1) << 3);
        cpu.sse.xmm[r][0] = lo;
        cpu.sse.xmm[r][1] = hi;
    } else {
        let addr = match decode_modrm_addr(cpu, ram, ram_size, modrm) { Ok(v) => v, Err(_) => return };
        let _ = mem::store_u64(cpu, ram, ram_size, addr, lo);
        let _ = mem::store_u64(cpu, ram, ram_size, addr.wrapping_add(8), hi);
    }
}

/// SSE compare predicate for f32 — returns all-1s or all-0s mask.
#[inline(always)]
fn sse_cmp_f32(a: f32, b: f32, pred: u8) -> u32 {
    let result = match pred {
        0 => a == b,             // EQ
        1 => a < b,              // LT
        2 => a <= b,             // LE
        3 => a.is_nan() || b.is_nan(), // UNORD
        4 => a != b,             // NEQ
        5 => !(a < b),           // NLT
        6 => !(a <= b),          // NLE
        _ => !a.is_nan() && !b.is_nan(), // ORD
    };
    if result { 0xFFFFFFFF } else { 0 }
}

/// SSE compare predicate for f64 — returns all-1s or all-0s mask.
#[inline(always)]
fn sse_cmp_f64(a: f64, b: f64, pred: u8) -> u64 {
    let result = match pred {
        0 => a == b,
        1 => a < b,
        2 => a <= b,
        3 => a.is_nan() || b.is_nan(),
        4 => a != b,
        5 => !(a < b),
        6 => !(a <= b),
        _ => !a.is_nan() && !b.is_nan(),
    };
    if result { 0xFFFFFFFFFFFFFFFF } else { 0 }
}

/// CMPPS — packed single compare
#[inline(always)]
fn sse_cmpps(cpu: &mut Cpu, dst: usize, lo: u64, hi: u64, pred: u8) {
    let d_lo = cpu.sse.xmm[dst][0];
    let d_hi = cpu.sse.xmm[dst][1];
    let r0 = sse_cmp_f32(f32::from_bits(d_lo as u32), f32::from_bits(lo as u32), pred);
    let r1 = sse_cmp_f32(f32::from_bits((d_lo >> 32) as u32), f32::from_bits((lo >> 32) as u32), pred);
    let r2 = sse_cmp_f32(f32::from_bits(d_hi as u32), f32::from_bits(hi as u32), pred);
    let r3 = sse_cmp_f32(f32::from_bits((d_hi >> 32) as u32), f32::from_bits((hi >> 32) as u32), pred);
    cpu.sse.xmm[dst][0] = r0 as u64 | ((r1 as u64) << 32);
    cpu.sse.xmm[dst][1] = r2 as u64 | ((r3 as u64) << 32);
}

/// SSE float arithmetic dispatcher — handles 0x51-0x5F based on prefix.
#[inline(always)]
unsafe fn exec_sse_arith(cpu: &mut Cpu, dst: usize, lo: u64, hi: u64, op2: u8) {
    if cpu.prefix.rep == 0xF3 {
        // Scalar single (SS)
        let a = f32::from_bits(cpu.sse.xmm[dst][0] as u32);
        let b = f32::from_bits(lo as u32);
        let r = match op2 {
            0x51 => libm::sqrtf(a) + 0.0 * b, // SQRTSS (b not used, but loaded)
            0x52 => { let _ = b; 1.0 / libm::sqrtf(a) }, // RSQRTSS (approximate)
            0x53 => { let _ = b; 1.0 / a }, // RCPSS (approximate)
            0x58 => a + b,
            0x59 => a * b,
            0x5A => { // CVTSS2SD
                let d = a as f64;
                cpu.sse.xmm[dst][0] = d.to_bits();
                return;
            }
            0x5C => a - b,
            0x5D => if a < b { a } else { b },
            0x5E => a / b,
            0x5F => if a > b { a } else { b },
            _ => return,
        };
        cpu.sse.xmm[dst][0] = (cpu.sse.xmm[dst][0] & 0xFFFFFFFF00000000) | r.to_bits() as u64;
    } else if cpu.prefix.rep == 0xF2 {
        // Scalar double (SD)
        let a = f64::from_bits(cpu.sse.xmm[dst][0]);
        let b = f64::from_bits(lo);
        let r = match op2 {
            0x51 => { let _ = b; libm::sqrt(a) },
            0x58 => a + b,
            0x59 => a * b,
            0x5A => { // CVTSD2SS
                let s = a as f32;
                cpu.sse.xmm[dst][0] = (cpu.sse.xmm[dst][0] & 0xFFFFFFFF00000000) | s.to_bits() as u64;
                return;
            }
            0x5C => a - b,
            0x5D => if a < b { a } else { b },
            0x5E => a / b,
            0x5F => if a > b { a } else { b },
            _ => return,
        };
        cpu.sse.xmm[dst][0] = r.to_bits();
    } else if cpu.prefix.op_size {
        // Packed double (PD)
        let a0 = f64::from_bits(cpu.sse.xmm[dst][0]);
        let a1 = f64::from_bits(cpu.sse.xmm[dst][1]);
        let b0 = f64::from_bits(lo);
        let b1 = f64::from_bits(hi);
        let (r0, r1) = match op2 {
            0x51 => (libm::sqrt(a0), libm::sqrt(a1)),
            0x58 => (a0 + b0, a1 + b1),
            0x59 => (a0 * b0, a1 * b1),
            0x5A => { // CVTPD2PS
                let s0 = a0 as f32;
                let s1 = a1 as f32;
                cpu.sse.xmm[dst][0] = s0.to_bits() as u64 | ((s1.to_bits() as u64) << 32);
                cpu.sse.xmm[dst][1] = 0;
                return;
            }
            0x5C => (a0 - b0, a1 - b1),
            0x5D => (if a0 < b0 { a0 } else { b0 }, if a1 < b1 { a1 } else { b1 }),
            0x5E => (a0 / b0, a1 / b1),
            0x5F => (if a0 > b0 { a0 } else { b0 }, if a1 > b1 { a1 } else { b1 }),
            _ => return,
        };
        cpu.sse.xmm[dst][0] = r0.to_bits();
        cpu.sse.xmm[dst][1] = r1.to_bits();
    } else {
        // Packed single (PS) — 4 x f32
        let d = cpu.sse.xmm[dst];
        let a = [f32::from_bits(d[0] as u32), f32::from_bits((d[0] >> 32) as u32),
                 f32::from_bits(d[1] as u32), f32::from_bits((d[1] >> 32) as u32)];
        let b = [f32::from_bits(lo as u32), f32::from_bits((lo >> 32) as u32),
                 f32::from_bits(hi as u32), f32::from_bits((hi >> 32) as u32)];
        let r: [f32; 4] = match op2 {
            0x51 => [libm::sqrtf(a[0]), libm::sqrtf(a[1]), libm::sqrtf(a[2]), libm::sqrtf(a[3])],
            0x52 => [1.0/libm::sqrtf(a[0]), 1.0/libm::sqrtf(a[1]), 1.0/libm::sqrtf(a[2]), 1.0/libm::sqrtf(a[3])],
            0x53 => [1.0/a[0], 1.0/a[1], 1.0/a[2], 1.0/a[3]],
            0x58 => [a[0]+b[0], a[1]+b[1], a[2]+b[2], a[3]+b[3]],
            0x59 => [a[0]*b[0], a[1]*b[1], a[2]*b[2], a[3]*b[3]],
            0x5A => { // CVTPS2PD: low 2 floats → 2 doubles
                cpu.sse.xmm[dst][0] = (a[0] as f64).to_bits();
                cpu.sse.xmm[dst][1] = (a[1] as f64).to_bits();
                return;
            }
            0x5B => { // CVTDQ2PS or CVTPS2DQ depending on prefix (no prefix = CVTDQ2PS)
                let d0 = d[0] as u32 as i32 as f32;
                let d1 = (d[0] >> 32) as u32 as i32 as f32;
                let d2 = d[1] as u32 as i32 as f32;
                let d3 = (d[1] >> 32) as u32 as i32 as f32;
                [d0, d1, d2, d3]
            }
            0x5C => [a[0]-b[0], a[1]-b[1], a[2]-b[2], a[3]-b[3]],
            0x5D => [if a[0]<b[0]{a[0]}else{b[0]}, if a[1]<b[1]{a[1]}else{b[1]}, if a[2]<b[2]{a[2]}else{b[2]}, if a[3]<b[3]{a[3]}else{b[3]}],
            0x5E => [a[0]/b[0], a[1]/b[1], a[2]/b[2], a[3]/b[3]],
            0x5F => [if a[0]>b[0]{a[0]}else{b[0]}, if a[1]>b[1]{a[1]}else{b[1]}, if a[2]>b[2]{a[2]}else{b[2]}, if a[3]>b[3]{a[3]}else{b[3]}],
            _ => return,
        };
        cpu.sse.xmm[dst][0] = r[0].to_bits() as u64 | ((r[1].to_bits() as u64) << 32);
        cpu.sse.xmm[dst][1] = r[2].to_bits() as u64 | ((r[3].to_bits() as u64) << 32);
    }
}

/// SSE2 packed integer operations.
#[inline(always)]
fn exec_sse_int_op(cpu: &mut Cpu, dst: usize, lo: u64, hi: u64, op2: u8) {
    let d = &mut cpu.sse.xmm[dst];
    match op2 {
        // PUNPCKLBW (0x60)
        0x60 => {
            let a = d[0]; let b = lo;
            let mut r = [0u64; 2];
            for i in 0..8 {
                let ab = (a >> (i * 8)) as u8;
                let bb = (b >> (i * 8)) as u8;
                let pos = i * 2;
                if pos < 8 { r[0] |= (ab as u64) << (pos * 8); r[0] |= (bb as u64) << ((pos + 1) * 8); }
                else { let p = pos - 8; r[1] |= (ab as u64) << (p * 8); r[1] |= (bb as u64) << ((p + 1) * 8); }
            }
            d[0] = r[0]; d[1] = r[1];
        }
        // PUNPCKLWD (0x61)
        0x61 => {
            let a = d[0]; let b = lo;
            let a0 = a as u16 as u64; let a1 = (a >> 16) as u16 as u64;
            let a2 = (a >> 32) as u16 as u64; let a3 = (a >> 48) as u16 as u64;
            let b0 = b as u16 as u64; let b1 = (b >> 16) as u16 as u64;
            let b2 = (b >> 32) as u16 as u64; let b3 = (b >> 48) as u16 as u64;
            d[0] = a0 | (b0 << 16) | (a1 << 32) | (b1 << 48);
            d[1] = a2 | (b2 << 16) | (a3 << 32) | (b3 << 48);
        }
        // PUNPCKLDQ (0x62)
        0x62 => {
            let a = d[0]; let b = lo;
            d[0] = (a as u32 as u64) | ((b as u32 as u64) << 32);
            d[1] = ((a >> 32) as u32 as u64) | (((b >> 32) as u32 as u64) << 32);
        }
        // PACKSSWB (0x63)
        0x63 => {
            let a = d.clone();
            let mut r = [0u8; 16];
            for i in 0..4 { r[i] = sat_i16_to_i8((a[0] >> (i*16)) as i16); }
            for i in 0..4 { r[i+4] = sat_i16_to_i8((a[1] >> (i*16)) as i16); }
            for i in 0..4 { r[i+8] = sat_i16_to_i8((lo >> (i*16)) as i16); }
            for i in 0..4 { r[i+12] = sat_i16_to_i8((hi >> (i*16)) as i16); }
            d[0] = u64::from_le_bytes([r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7]]);
            d[1] = u64::from_le_bytes([r[8],r[9],r[10],r[11],r[12],r[13],r[14],r[15]]);
        }
        // PCMPGTB (0x64)
        0x64 => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..8 { if (d[0] >> (i*8)) as i8 > (lo >> (i*8)) as i8 { r0 |= 0xFF << (i*8); } }
            for i in 0..8 { if (d[1] >> (i*8)) as i8 > (hi >> (i*8)) as i8 { r1 |= 0xFF << (i*8); } }
            d[0] = r0; d[1] = r1;
        }
        // PCMPGTW (0x65)
        0x65 => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..4 { if (d[0] >> (i*16)) as i16 > (lo >> (i*16)) as i16 { r0 |= 0xFFFF << (i*16); } }
            for i in 0..4 { if (d[1] >> (i*16)) as i16 > (hi >> (i*16)) as i16 { r1 |= 0xFFFF << (i*16); } }
            d[0] = r0; d[1] = r1;
        }
        // PCMPGTD (0x66)
        0x66 => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..2 { if (d[0] >> (i*32)) as i32 > (lo >> (i*32)) as i32 { r0 |= 0xFFFFFFFF << (i*32); } }
            for i in 0..2 { if (d[1] >> (i*32)) as i32 > (hi >> (i*32)) as i32 { r1 |= 0xFFFFFFFF << (i*32); } }
            d[0] = r0; d[1] = r1;
        }
        // PACKUSWB (0x67)
        0x67 => {
            let a = d.clone();
            let mut r = [0u8; 16];
            for i in 0..4 { r[i] = sat_i16_to_u8((a[0] >> (i*16)) as i16); }
            for i in 0..4 { r[i+4] = sat_i16_to_u8((a[1] >> (i*16)) as i16); }
            for i in 0..4 { r[i+8] = sat_i16_to_u8((lo >> (i*16)) as i16); }
            for i in 0..4 { r[i+12] = sat_i16_to_u8((hi >> (i*16)) as i16); }
            d[0] = u64::from_le_bytes([r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7]]);
            d[1] = u64::from_le_bytes([r[8],r[9],r[10],r[11],r[12],r[13],r[14],r[15]]);
        }
        // PUNPCKHBW (0x68)
        0x68 => {
            let a = d[1]; let b = hi;
            let mut r = [0u64; 2];
            for i in 0..8 {
                let ab = (a >> (i * 8)) as u8;
                let bb = (b >> (i * 8)) as u8;
                let pos = i * 2;
                if pos < 8 { r[0] |= (ab as u64) << (pos * 8); r[0] |= (bb as u64) << ((pos + 1) * 8); }
                else { let p = pos - 8; r[1] |= (ab as u64) << (p * 8); r[1] |= (bb as u64) << ((p + 1) * 8); }
            }
            d[0] = r[0]; d[1] = r[1];
        }
        // PUNPCKHWD (0x69)
        0x69 => {
            let a = d[1]; let b = hi;
            let a0 = a as u16 as u64; let a1 = (a >> 16) as u16 as u64;
            let a2 = (a >> 32) as u16 as u64; let a3 = (a >> 48) as u16 as u64;
            let b0 = b as u16 as u64; let b1 = (b >> 16) as u16 as u64;
            let b2 = (b >> 32) as u16 as u64; let b3 = (b >> 48) as u16 as u64;
            d[0] = a0 | (b0 << 16) | (a1 << 32) | (b1 << 48);
            d[1] = a2 | (b2 << 16) | (a3 << 32) | (b3 << 48);
        }
        // PUNPCKHDQ (0x6A)
        0x6A => {
            let a = d[1]; let b = hi;
            d[0] = (a as u32 as u64) | ((b as u32 as u64) << 32);
            d[1] = ((a >> 32) as u32 as u64) | (((b >> 32) as u32 as u64) << 32);
        }
        // PACKSSDW (0x6B)
        0x6B => {
            let a = d.clone();
            let r0 = sat_i32_to_i16(a[0] as i32) as u16 as u64
                   | ((sat_i32_to_i16((a[0] >> 32) as i32) as u16 as u64) << 16)
                   | ((sat_i32_to_i16(a[1] as i32) as u16 as u64) << 32)
                   | ((sat_i32_to_i16((a[1] >> 32) as i32) as u16 as u64) << 48);
            let r1 = sat_i32_to_i16(lo as i32) as u16 as u64
                   | ((sat_i32_to_i16((lo >> 32) as i32) as u16 as u64) << 16)
                   | ((sat_i32_to_i16(hi as i32) as u16 as u64) << 32)
                   | ((sat_i32_to_i16((hi >> 32) as i32) as u16 as u64) << 48);
            d[0] = r0; d[1] = r1;
        }
        // PUNPCKLQDQ (0x6C)
        0x6C => { d[1] = lo; }
        // PUNPCKHQDQ (0x6D)
        0x6D => { d[0] = d[1]; d[1] = hi; }
        // PCMPEQB (0x74)
        0x74 => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..8 { if (d[0] >> (i*8)) as u8 == (lo >> (i*8)) as u8 { r0 |= 0xFF << (i*8); } }
            for i in 0..8 { if (d[1] >> (i*8)) as u8 == (hi >> (i*8)) as u8 { r1 |= 0xFF << (i*8); } }
            d[0] = r0; d[1] = r1;
        }
        // PCMPEQW (0x75)
        0x75 => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..4 { if (d[0] >> (i*16)) as u16 == (lo >> (i*16)) as u16 { r0 |= 0xFFFF << (i*16); } }
            for i in 0..4 { if (d[1] >> (i*16)) as u16 == (hi >> (i*16)) as u16 { r1 |= 0xFFFF << (i*16); } }
            d[0] = r0; d[1] = r1;
        }
        // PCMPEQD (0x76)
        0x76 => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..2 { if (d[0] >> (i*32)) as u32 == (lo >> (i*32)) as u32 { r0 |= 0xFFFFFFFF << (i*32); } }
            for i in 0..2 { if (d[1] >> (i*32)) as u32 == (hi >> (i*32)) as u32 { r1 |= 0xFFFFFFFF << (i*32); } }
            d[0] = r0; d[1] = r1;
        }
        // PSRLW (0xD1), PSRLD (0xD2), PSRLQ (0xD3)
        0xD1 => { let cnt = lo as u32; packed_shift_right_w(d, cnt); }
        0xD2 => { let cnt = lo as u32; packed_shift_right_d(d, cnt); }
        0xD3 => { let cnt = lo as u32; packed_shift_right_q(d, cnt); }
        // PADDQ (0xD4)
        0xD4 => { d[0] = d[0].wrapping_add(lo); d[1] = d[1].wrapping_add(hi); }
        // PMULLW (0xD5)
        0xD5 => {
            for q in 0..2 {
                let s = if q == 0 { lo } else { hi };
                let mut r = 0u64;
                for i in 0..4 {
                    let a = (d[q] >> (i*16)) as i16;
                    let b = (s >> (i*16)) as i16;
                    r |= ((a.wrapping_mul(b)) as u16 as u64) << (i*16);
                }
                d[q] = r;
            }
        }
        // PSUBUSB (0xD8)
        0xD8 => { packed_sub_us_b(d, lo, hi); }
        // PSUBUSW (0xD9)
        0xD9 => { packed_sub_us_w(d, lo, hi); }
        // PMINUB (0xDA)
        0xDA => { packed_min_ub(d, lo, hi); }
        // PAND (0xDB)
        0xDB => { d[0] &= lo; d[1] &= hi; }
        // PADDUSB (0xDC)
        0xDC => { packed_add_us_b(d, lo, hi); }
        // PADDUSW (0xDD)
        0xDD => { packed_add_us_w(d, lo, hi); }
        // PMAXUB (0xDE)
        0xDE => { packed_max_ub(d, lo, hi); }
        // PANDN (0xDF)
        0xDF => { d[0] = (!d[0]) & lo; d[1] = (!d[1]) & hi; }
        // PAVGB (0xE0)
        0xE0 => { packed_avg_b(d, lo, hi); }
        // PSRAW (0xE1), PSRAD (0xE2)
        0xE1 => { let cnt = lo as u32; packed_shift_right_arith_w(d, cnt); }
        0xE2 => { let cnt = lo as u32; packed_shift_right_arith_d(d, cnt); }
        // PAVGW (0xE3)
        0xE3 => { packed_avg_w(d, lo, hi); }
        // PMULHUW (0xE4)
        0xE4 => {
            for q in 0..2 {
                let s = if q == 0 { lo } else { hi };
                let mut r = 0u64;
                for i in 0..4 {
                    let a = (d[q] >> (i*16)) as u16 as u32;
                    let b = (s >> (i*16)) as u16 as u32;
                    r |= (((a * b) >> 16) as u16 as u64) << (i*16);
                }
                d[q] = r;
            }
        }
        // PMULHW (0xE5)
        0xE5 => {
            for q in 0..2 {
                let s = if q == 0 { lo } else { hi };
                let mut r = 0u64;
                for i in 0..4 {
                    let a = (d[q] >> (i*16)) as i16 as i32;
                    let b = (s >> (i*16)) as i16 as i32;
                    r |= (((a * b) >> 16) as u16 as u64) << (i*16);
                }
                d[q] = r;
            }
        }
        // PSUBSB (0xE8)
        0xE8 => { packed_sub_s_b(d, lo, hi); }
        // PSUBSW (0xE9)
        0xE9 => { packed_sub_s_w(d, lo, hi); }
        // PMINSW (0xEA)
        0xEA => {
            for q in 0..2 {
                let s = if q == 0 { lo } else { hi };
                let mut r = 0u64;
                for i in 0..4 {
                    let a = (d[q] >> (i*16)) as i16;
                    let b = (s >> (i*16)) as i16;
                    r |= (if a < b { a } else { b } as u16 as u64) << (i*16);
                }
                d[q] = r;
            }
        }
        // POR (0xEB)
        0xEB => { d[0] |= lo; d[1] |= hi; }
        // PADDSB (0xEC)
        0xEC => { packed_add_s_b(d, lo, hi); }
        // PADDSW (0xED)
        0xED => { packed_add_s_w(d, lo, hi); }
        // PMAXSW (0xEE)
        0xEE => {
            for q in 0..2 {
                let s = if q == 0 { lo } else { hi };
                let mut r = 0u64;
                for i in 0..4 {
                    let a = (d[q] >> (i*16)) as i16;
                    let b = (s >> (i*16)) as i16;
                    r |= (if a > b { a } else { b } as u16 as u64) << (i*16);
                }
                d[q] = r;
            }
        }
        // PXOR (0xEF)
        0xEF => { d[0] ^= lo; d[1] ^= hi; }
        // PSLLW (0xF1), PSLLD (0xF2), PSLLQ (0xF3)
        0xF1 => { let cnt = lo as u32; packed_shift_left_w(d, cnt); }
        0xF2 => { let cnt = lo as u32; packed_shift_left_d(d, cnt); }
        0xF3 => { let cnt = lo as u32; packed_shift_left_q(d, cnt); }
        // PMULUDQ (0xF4)
        0xF4 => {
            let r0 = (d[0] as u32 as u64).wrapping_mul(lo as u32 as u64);
            let r1 = (d[1] as u32 as u64).wrapping_mul(hi as u32 as u64);
            d[0] = r0; d[1] = r1;
        }
        // PMADDWD (0xF5)
        0xF5 => {
            for q in 0..2 {
                let s = if q == 0 { lo } else { hi };
                let a0 = (d[q] as i16 as i32).wrapping_mul(s as i16 as i32);
                let a1 = ((d[q] >> 16) as i16 as i32).wrapping_mul((s >> 16) as i16 as i32);
                let a2 = ((d[q] >> 32) as i16 as i32).wrapping_mul((s >> 32) as i16 as i32);
                let a3 = ((d[q] >> 48) as i16 as i32).wrapping_mul((s >> 48) as i16 as i32);
                d[q] = (a0.wrapping_add(a1)) as u32 as u64 | (((a2.wrapping_add(a3)) as u32 as u64) << 32);
            }
        }
        // PSADBW (0xF6)
        0xF6 => {
            let mut sum0 = 0u64;
            for i in 0..8 { sum0 += ((d[0] >> (i*8)) as u8 as i16 - (lo >> (i*8)) as u8 as i16).unsigned_abs() as u64; }
            let mut sum1 = 0u64;
            for i in 0..8 { sum1 += ((d[1] >> (i*8)) as u8 as i16 - (hi >> (i*8)) as u8 as i16).unsigned_abs() as u64; }
            d[0] = sum0; d[1] = sum1;
        }
        // PSUBB (0xF8)
        0xF8 => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..8 { r0 |= (((d[0] >> (i*8)) as u8).wrapping_sub((lo >> (i*8)) as u8) as u64) << (i*8); }
            for i in 0..8 { r1 |= (((d[1] >> (i*8)) as u8).wrapping_sub((hi >> (i*8)) as u8) as u64) << (i*8); }
            d[0] = r0; d[1] = r1;
        }
        // PSUBW (0xF9)
        0xF9 => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..4 { r0 |= (((d[0] >> (i*16)) as u16).wrapping_sub((lo >> (i*16)) as u16) as u64) << (i*16); }
            for i in 0..4 { r1 |= (((d[1] >> (i*16)) as u16).wrapping_sub((hi >> (i*16)) as u16) as u64) << (i*16); }
            d[0] = r0; d[1] = r1;
        }
        // PSUBD (0xFA)
        0xFA => {
            let r0 = ((d[0] as u32).wrapping_sub(lo as u32) as u64)
                   | ((((d[0] >> 32) as u32).wrapping_sub((lo >> 32) as u32) as u64) << 32);
            let r1 = ((d[1] as u32).wrapping_sub(hi as u32) as u64)
                   | ((((d[1] >> 32) as u32).wrapping_sub((hi >> 32) as u32) as u64) << 32);
            d[0] = r0; d[1] = r1;
        }
        // PSUBQ (0xFB)
        0xFB => { d[0] = d[0].wrapping_sub(lo); d[1] = d[1].wrapping_sub(hi); }
        // PADDB (0xFC)
        0xFC => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..8 { r0 |= (((d[0] >> (i*8)) as u8).wrapping_add((lo >> (i*8)) as u8) as u64) << (i*8); }
            for i in 0..8 { r1 |= (((d[1] >> (i*8)) as u8).wrapping_add((hi >> (i*8)) as u8) as u64) << (i*8); }
            d[0] = r0; d[1] = r1;
        }
        // PADDW (0xFD)
        0xFD => {
            let mut r0 = 0u64; let mut r1 = 0u64;
            for i in 0..4 { r0 |= (((d[0] >> (i*16)) as u16).wrapping_add((lo >> (i*16)) as u16) as u64) << (i*16); }
            for i in 0..4 { r1 |= (((d[1] >> (i*16)) as u16).wrapping_add((hi >> (i*16)) as u16) as u64) << (i*16); }
            d[0] = r0; d[1] = r1;
        }
        // PADDD (0xFE)
        0xFE => {
            let r0 = ((d[0] as u32).wrapping_add(lo as u32) as u64)
                   | ((((d[0] >> 32) as u32).wrapping_add((lo >> 32) as u32) as u64) << 32);
            let r1 = ((d[1] as u32).wrapping_add(hi as u32) as u64)
                   | ((((d[1] >> 32) as u32).wrapping_add((hi >> 32) as u32) as u64) << 32);
            d[0] = r0; d[1] = r1;
        }
        _ => {}
    }
}

/// SSE2 shift-by-immediate (0x71/72/73 with reg_field selecting the operation).
#[inline(always)]
fn exec_sse_shift_imm(cpu: &mut Cpu, r: usize, op2: u8, reg_field: u8, imm: u8) {
    let d = &mut cpu.sse.xmm[r];
    let cnt = imm as u32;
    match op2 {
        0x71 => match reg_field {
            2 => packed_shift_right_w(d, cnt), // PSRLW
            4 => packed_shift_right_arith_w(d, cnt), // PSRAW
            6 => packed_shift_left_w(d, cnt),  // PSLLW
            _ => {}
        },
        0x72 => match reg_field {
            2 => packed_shift_right_d(d, cnt), // PSRLD
            4 => packed_shift_right_arith_d(d, cnt), // PSRAD
            6 => packed_shift_left_d(d, cnt),  // PSLLD
            _ => {}
        },
        0x73 => match reg_field {
            2 => packed_shift_right_q(d, cnt), // PSRLQ
            3 => { // PSRLDQ — shift right by bytes
                let bytes = cnt.min(16) as usize;
                let mut buf = [0u8; 16];
                buf[..8].copy_from_slice(&d[0].to_le_bytes());
                buf[8..].copy_from_slice(&d[1].to_le_bytes());
                let mut out = [0u8; 16];
                for i in 0..16 { out[i] = if i + bytes < 16 { buf[i + bytes] } else { 0 }; }
                d[0] = u64::from_le_bytes([out[0],out[1],out[2],out[3],out[4],out[5],out[6],out[7]]);
                d[1] = u64::from_le_bytes([out[8],out[9],out[10],out[11],out[12],out[13],out[14],out[15]]);
            }
            6 => packed_shift_left_q(d, cnt), // PSLLQ
            7 => { // PSLLDQ — shift left by bytes
                let bytes = cnt.min(16) as usize;
                let mut buf = [0u8; 16];
                buf[..8].copy_from_slice(&d[0].to_le_bytes());
                buf[8..].copy_from_slice(&d[1].to_le_bytes());
                let mut out = [0u8; 16];
                for i in 0..16 { out[i] = if i >= bytes { buf[i - bytes] } else { 0 }; }
                d[0] = u64::from_le_bytes([out[0],out[1],out[2],out[3],out[4],out[5],out[6],out[7]]);
                d[1] = u64::from_le_bytes([out[8],out[9],out[10],out[11],out[12],out[13],out[14],out[15]]);
            }
            _ => {}
        },
        _ => {}
    }
}

// --- Packed shift helpers ---
#[inline(always)]
fn packed_shift_right_w(d: &mut [u64; 2], cnt: u32) {
    if cnt >= 16 { d[0] = 0; d[1] = 0; return; }
    for q in 0..2 {
        let mut r = 0u64;
        for i in 0..4 { r |= (((d[q] >> (i*16)) as u16 >> cnt) as u64) << (i*16); }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_shift_right_d(d: &mut [u64; 2], cnt: u32) {
    if cnt >= 32 { d[0] = 0; d[1] = 0; return; }
    for q in 0..2 {
        let lo = (d[q] as u32) >> cnt;
        let hi = ((d[q] >> 32) as u32) >> cnt;
        d[q] = lo as u64 | ((hi as u64) << 32);
    }
}
#[inline(always)]
fn packed_shift_right_q(d: &mut [u64; 2], cnt: u32) {
    if cnt >= 64 { d[0] = 0; d[1] = 0; return; }
    d[0] >>= cnt; d[1] >>= cnt;
}
#[inline(always)]
fn packed_shift_left_w(d: &mut [u64; 2], cnt: u32) {
    if cnt >= 16 { d[0] = 0; d[1] = 0; return; }
    for q in 0..2 {
        let mut r = 0u64;
        for i in 0..4 { r |= ((((d[q] >> (i*16)) as u16) << cnt) as u64) << (i*16); }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_shift_left_d(d: &mut [u64; 2], cnt: u32) {
    if cnt >= 32 { d[0] = 0; d[1] = 0; return; }
    for q in 0..2 {
        let lo = (d[q] as u32) << cnt;
        let hi = ((d[q] >> 32) as u32) << cnt;
        d[q] = lo as u64 | ((hi as u64) << 32);
    }
}
#[inline(always)]
fn packed_shift_left_q(d: &mut [u64; 2], cnt: u32) {
    if cnt >= 64 { d[0] = 0; d[1] = 0; return; }
    d[0] <<= cnt; d[1] <<= cnt;
}
#[inline(always)]
fn packed_shift_right_arith_w(d: &mut [u64; 2], cnt: u32) {
    let cnt = cnt.min(15);
    for q in 0..2 {
        let mut r = 0u64;
        for i in 0..4 { r |= ((((d[q] >> (i*16)) as i16 >> cnt) as u16) as u64) << (i*16); }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_shift_right_arith_d(d: &mut [u64; 2], cnt: u32) {
    let cnt = cnt.min(31);
    for q in 0..2 {
        let lo = ((d[q] as i32) >> cnt) as u32;
        let hi = (((d[q] >> 32) as i32) >> cnt) as u32;
        d[q] = lo as u64 | ((hi as u64) << 32);
    }
}

// --- Packed saturating arithmetic helpers ---
#[inline(always)]
fn sat_i16_to_i8(v: i16) -> u8 { (if v < -128 { -128i8 } else if v > 127 { 127i8 } else { v as i8 }) as u8 }
#[inline(always)]
fn sat_i16_to_u8(v: i16) -> u8 { if v < 0 { 0 } else if v > 255 { 255 } else { v as u8 } }
#[inline(always)]
fn sat_i32_to_i16(v: i32) -> i16 { if v < -32768 { -32768 } else if v > 32767 { 32767 } else { v as i16 } }

#[inline(always)]
fn packed_sub_us_b(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..8 {
            let a = (d[q] >> (i*8)) as u8;
            let b = (s >> (i*8)) as u8;
            r |= (a.saturating_sub(b) as u64) << (i*8);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_sub_us_w(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..4 {
            let a = (d[q] >> (i*16)) as u16;
            let b = (s >> (i*16)) as u16;
            r |= (a.saturating_sub(b) as u64) << (i*16);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_add_us_b(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..8 {
            let a = (d[q] >> (i*8)) as u8;
            let b = (s >> (i*8)) as u8;
            r |= (a.saturating_add(b) as u64) << (i*8);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_add_us_w(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..4 {
            let a = (d[q] >> (i*16)) as u16;
            let b = (s >> (i*16)) as u16;
            r |= (a.saturating_add(b) as u64) << (i*16);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_sub_s_b(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..8 {
            let a = (d[q] >> (i*8)) as i8;
            let b = (s >> (i*8)) as i8;
            r |= (a.saturating_sub(b) as u8 as u64) << (i*8);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_sub_s_w(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..4 {
            let a = (d[q] >> (i*16)) as i16;
            let b = (s >> (i*16)) as i16;
            r |= (a.saturating_sub(b) as u16 as u64) << (i*16);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_add_s_b(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..8 {
            let a = (d[q] >> (i*8)) as i8;
            let b = (s >> (i*8)) as i8;
            r |= (a.saturating_add(b) as u8 as u64) << (i*8);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_add_s_w(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..4 {
            let a = (d[q] >> (i*16)) as i16;
            let b = (s >> (i*16)) as i16;
            r |= (a.saturating_add(b) as u16 as u64) << (i*16);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_min_ub(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..8 {
            let a = (d[q] >> (i*8)) as u8;
            let b = (s >> (i*8)) as u8;
            r |= (a.min(b) as u64) << (i*8);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_max_ub(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..8 {
            let a = (d[q] >> (i*8)) as u8;
            let b = (s >> (i*8)) as u8;
            r |= (a.max(b) as u64) << (i*8);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_avg_b(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..8 {
            let a = (d[q] >> (i*8)) as u8 as u16;
            let b = (s >> (i*8)) as u8 as u16;
            r |= (((a + b + 1) >> 1) as u8 as u64) << (i*8);
        }
        d[q] = r;
    }
}
#[inline(always)]
fn packed_avg_w(d: &mut [u64; 2], lo: u64, hi: u64) {
    for q in 0..2 {
        let s = if q == 0 { lo } else { hi };
        let mut r = 0u64;
        for i in 0..4 {
            let a = (d[q] >> (i*16)) as u16 as u32;
            let b = (s >> (i*16)) as u16 as u32;
            r |= (((a + b + 1) >> 1) as u16 as u64) << (i*16);
        }
        d[q] = r;
    }
}
