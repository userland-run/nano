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
            x if (x & 0xFF) == 0x90 => {
                // NOP — do nothing (also XCHG EAX,EAX in 32-bit which is NOP)
            }

            // ============================================================
            // MOV r8, imm8 (0xB0-0xB7)
            // ============================================================
            x if (x & 0xFF) >= 0xB0 && (x & 0xFF) <= 0xB7 => {
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
            x if (x & 0xFF) >= 0xB8 && (x & 0xFF) <= 0xBF => {
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
            x if (x & 0xFF) == 0x04 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let lhs = cpu.regs[RAX] as u8;
                let res = lhs.wrapping_add(imm);
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::AddB, lhs as u64, res as u64);
            }

            // ============================================================
            // ADD rAX, imm16/32 (0x05)
            // ============================================================
            x if (x & 0xFF) == 0x05 => {
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
            x if (x & 0xFF) == 0x2C => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let lhs = cpu.regs[RAX] as u8;
                let res = lhs.wrapping_sub(imm);
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::SubB, lhs as u64, res as u64);
            }

            // ============================================================
            // SUB rAX, imm (0x2D)
            // ============================================================
            x if (x & 0xFF) == 0x2D => {
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
            x if (x & 0xFF) == 0x3C => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let lhs = cpu.regs[RAX] as u8;
                let res = lhs.wrapping_sub(imm);
                set_lazy(cpu, FlagOp::SubB, lhs as u64, res as u64);
            }

            // ============================================================
            // CMP rAX, imm (0x3D)
            // ============================================================
            x if (x & 0xFF) == 0x3D => {
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
            x if (x & 0xFF) == 0x24 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let res = (cpu.regs[RAX] as u8) & imm;
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::AndB, 0, res as u64);
            }

            // ============================================================
            // OR AL, imm8 (0x0C)
            // ============================================================
            x if (x & 0xFF) == 0x0C => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let res = (cpu.regs[RAX] as u8) | imm;
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::OrB, 0, res as u64);
            }

            // ============================================================
            // XOR AL, imm8 (0x34)
            // ============================================================
            x if (x & 0xFF) == 0x34 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let res = (cpu.regs[RAX] as u8) ^ imm;
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::XorB, 0, res as u64);
            }

            // ============================================================
            // TEST AL, imm8 (0xA8)
            // ============================================================
            x if (x & 0xFF) == 0xA8 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let res = (cpu.regs[RAX] as u8) & imm;
                set_lazy(cpu, FlagOp::AndB, 0, res as u64);
            }

            // ============================================================
            // PUSH r16/32/64 (0x50-0x57)
            // ============================================================
            x if (x & 0xFF) >= 0x50 && (x & 0xFF) <= 0x57 => {
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
            x if (x & 0xFF) >= 0x58 && (x & 0xFF) <= 0x5F => {
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
            x if (x & 0xFF) == 0xE8 => {
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
            x if (x & 0xFF) == 0xC3 => {
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
            x if (x & 0xFF) == 0xEB => {
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
            }

            // ============================================================
            // JMP rel32 (0xE9)
            // ============================================================
            x if (x & 0xFF) == 0xE9 => {
                let rel = try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as i32;
                cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                if !cpu.long_mode {
                    cpu.rip &= 0xFFFFFFFF;
                }
            }

            // ============================================================
            // Jcc rel8 (0x70-0x7F)
            // ============================================================
            x if (x & 0xFF) >= 0x70 && (x & 0xFF) <= 0x7F => {
                let cc = (opcode & 0x0F) as u8;
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                if eval_cc(cpu, cc) {
                    cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                }
            }

            // ============================================================
            // LEA r, m (0x8D) — load effective address
            // ============================================================
            x if (x & 0xFF) == 0x8D => {
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
            x if (x & 0xFF) == 0x88 => {
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
            x if (x & 0xFF) == 0x89 => {
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
            x if (x & 0xFF) == 0x8A => {
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
            x if (x & 0xFF) == 0x8B => {
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
            x if (x & 0xFF) == 0xC6 => {
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
            x if (x & 0xFF) == 0xC7 => {
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
            x if (x & 0xFF) >= 0x91 && (x & 0xFF) <= 0x97 => {
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
            x if (x & 0xFF) == 0xF8 => {
                materialize_flags(cpu);
                cpu.rflags &= !CF;
                cpu.lazy.op = FlagOp::External;
            }
            x if (x & 0xFF) == 0xF9 => {
                materialize_flags(cpu);
                cpu.rflags |= CF;
                cpu.lazy.op = FlagOp::External;
            }
            x if (x & 0xFF) == 0xF5 => {
                materialize_flags(cpu);
                cpu.rflags ^= CF;
                cpu.lazy.op = FlagOp::External;
            }

            // ============================================================
            // CLD (0xFC), STD (0xFD)
            // ============================================================
            x if (x & 0xFF) == 0xFC => { cpu.rflags &= !DF; }
            x if (x & 0xFF) == 0xFD => { cpu.rflags |= DF; }

            // ============================================================
            // CLI (0xFA), STI (0xFB)
            // ============================================================
            x if (x & 0xFF) == 0xFA => { cpu.rflags &= !IF; }
            x if (x & 0xFF) == 0xFB => {
                cpu.rflags |= IF;
                cpu.inhibit_irq = true; // delay interrupt by one instruction
            }

            // ============================================================
            // HLT (0xF4)
            // ============================================================
            x if (x & 0xFF) == 0xF4 => {
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
            x if (x & 0xFF) == 0x0F => {
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
            x if (x & 0xFF) == 0xCC => {
                // INT3 is a trap: pushed RIP is after the instruction
                deliver_interrupt(cpu, ram, ram_size, EXC_BP, false, 0);
            }

            // ============================================================
            // INT imm8 (0xCD) — software interrupt
            // ============================================================
            x if (x & 0xFF) == 0xCD => {
                let vector = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                // INT is a trap: pushed RIP is after the instruction (current rip)
                // Don't use raise_exception which rewinds RIP to instr_start
                deliver_interrupt(cpu, ram, ram_size, vector as u32, false, 0);
            }

            // ============================================================
            // IRET/IRETD/IRETQ (0xCF)
            // ============================================================
            x if (x & 0xFF) == 0xCF => {
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
            x if (x & 0xFF) == 0x63 && lane == LANE64 => {
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
            x if (x & 0xFF) == 0xC9 => {
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
            x if (x & 0xFF) == 0x98 => {
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
            x if (x & 0xFF) == 0x99 => {
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
            x if (x & 0xFF) <= 0x3F && ((x & 0xFF) & 7) == 0 => {
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
            x if (x & 0xFF) <= 0x3F && ((x & 0xFF) & 7) == 1 => {
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
            x if (x & 0xFF) <= 0x3F && ((x & 0xFF) & 7) == 2 => {
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
            x if (x & 0xFF) <= 0x3F && ((x & 0xFF) & 7) == 3 => {
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
            x if (x & 0xFF) == 0x14 => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let lhs = cpu.regs[RAX] as u8;
                let cf = flags::get_cf(cpu) as u8;
                let res = lhs.wrapping_add(imm).wrapping_add(cf);
                write_reg8_al(cpu, res);
                set_lazy(cpu, FlagOp::AdcB, lhs as u64, res as u64);
            }
            x if (x & 0xFF) == 0x1C => {
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
            x if (x & 0xFF) == 0x15 => {
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
            x if (x & 0xFF) == 0x1D => {
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
            x if (x & 0xFF) == 0x25 || (x & 0xFF) == 0x0D || (x & 0xFF) == 0x35 => {
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
            x if (x & 0xFF) == 0xA9 => {
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
            x if (x & 0xFF) == 0x84 => {
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
            x if (x & 0xFF) == 0x85 => {
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
            x if (x & 0xFF) == 0x86 => {
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
            x if (x & 0xFF) == 0x87 => {
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
            x if (x & 0xFF) == 0x80 => {
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
            x if (x & 0xFF) == 0x81 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                let alu_op = ((modrm >> 3) & 7) as usize;
                grp1_ev_imm(cpu, ram, ram_size, modrm, alu_op, lane, false);
            }

            // ============================================================
            // GRP1 Eb, imm8 (0x82 — alias of 0x80 in 32-bit mode)
            // ============================================================
            x if (x & 0xFF) == 0x82 => {
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
            x if (x & 0xFF) == 0x83 => {
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
            x if (x & 0xFF) == 0xC0 || (x & 0xFF) == 0xD0 || (x & 0xFF) == 0xD2 => {
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
            x if (x & 0xFF) == 0xC1 || (x & 0xFF) == 0xD1 || (x & 0xFF) == 0xD3 => {
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
            x if (x & 0xFF) == 0xF6 => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                grp3_eb(cpu, ram, ram_size, modrm);
            }
            x if (x & 0xFF) == 0xF7 => {
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
            x if (x & 0xFF) == 0xFE => {
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
            x if (x & 0xFF) == 0xFF => {
                let modrm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size));
                grp5(cpu, ram, ram_size, modrm, lane);
            }

            // ============================================================
            // PUSHF (0x9C), POPF (0x9D)
            // ============================================================
            x if (x & 0xFF) == 0x9C => {
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
            x if (x & 0xFF) == 0x9D => {
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
            x if (x & 0xFF) == 0x9E => {
                // SAHF: AH → lower 8 bits of EFLAGS
                let ah = (cpu.regs[RAX] >> 8) as u8;
                cpu.rflags = (cpu.rflags & !0xFF) | (ah as u64 & (CF | PF | AF | ZF | SF)) | 0x02;
                cpu.lazy.op = FlagOp::External;
            }
            x if (x & 0xFF) == 0x9F => {
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
            x if (x & 0xFF) == 0xE4 => {
                let port = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as u16;
                let val = crate::pic::io_read(cpu, ram, ram_size, port, 1);
                write_reg8_al(cpu, val as u8);
            }
            x if (x & 0xFF) == 0xEC => {
                let port = cpu.regs[RDX] as u16;
                let val = crate::pic::io_read(cpu, ram, ram_size, port, 1);
                write_reg8_al(cpu, val as u8);
            }
            x if (x & 0xFF) == 0xE5 => {
                let port = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as u16;
                let size = if lane == LANE16 { 2u8 } else { 4u8 };
                let val = crate::pic::io_read(cpu, ram, ram_size, port, size);
                match lane {
                    LANE16 => write_reg16(cpu, RAX, val as u16),
                    _ => cpu.regs[RAX] = val as u64,
                }
            }
            x if (x & 0xFF) == 0xED => {
                let port = cpu.regs[RDX] as u16;
                let size = if lane == LANE16 { 2u8 } else { 4u8 };
                let val = crate::pic::io_read(cpu, ram, ram_size, port, size);
                match lane {
                    LANE16 => write_reg16(cpu, RAX, val as u16),
                    _ => cpu.regs[RAX] = val as u64,
                }
            }
            x if (x & 0xFF) == 0xE6 => {
                let port = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as u16;
                crate::pic::io_write(cpu, ram, ram_size, port, cpu.regs[RAX] as u32 & 0xFF, 1);
            }
            x if (x & 0xFF) == 0xEE => {
                let port = cpu.regs[RDX] as u16;
                crate::pic::io_write(cpu, ram, ram_size, port, cpu.regs[RAX] as u32 & 0xFF, 1);
            }
            x if (x & 0xFF) == 0xE7 => {
                let port = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as u16;
                let size = if lane == LANE16 { 2u8 } else { 4u8 };
                crate::pic::io_write(cpu, ram, ram_size, port, cpu.regs[RAX] as u32, size);
            }
            x if (x & 0xFF) == 0xEF => {
                let port = cpu.regs[RDX] as u16;
                let size = if lane == LANE16 { 2u8 } else { 4u8 };
                crate::pic::io_write(cpu, ram, ram_size, port, cpu.regs[RAX] as u32, size);
            }

            // ============================================================
            // MOV moffs — MOV AL,moffs8 (0xA0), MOV rAX,moffs (0xA1)
            //              MOV moffs8,AL (0xA2), MOV moffs,rAX (0xA3)
            // ============================================================
            x if (x & 0xFF) == 0xA0 => {
                let addr = if cpu.long_mode && !cpu.prefix.addr_size {
                    try_or_fault!(cpu, fetch_imm64(cpu, ram, ram_size))
                } else {
                    try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as u64
                };
                let val = try_or_fault!(cpu, mem::load_u8(cpu, ram, ram_size, addr));
                write_reg8_al(cpu, val);
            }
            x if (x & 0xFF) == 0xA1 => {
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
            x if (x & 0xFF) == 0xA2 => {
                let addr = if cpu.long_mode && !cpu.prefix.addr_size {
                    try_or_fault!(cpu, fetch_imm64(cpu, ram, ram_size))
                } else {
                    try_or_fault!(cpu, fetch_imm32(cpu, ram, ram_size)) as u64
                };
                try_or_fault!(cpu, mem::store_u8(cpu, ram, ram_size, addr, cpu.regs[RAX] as u8));
            }
            x if (x & 0xFF) == 0xA3 => {
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
            x if (x & 0xFF) == 0xA4 => { string_movsb(cpu, ram, ram_size); }
            x if (x & 0xFF) == 0xA5 => { string_movs(cpu, ram, ram_size, lane); }
            x if (x & 0xFF) == 0xA6 => { string_cmpsb(cpu, ram, ram_size); }
            x if (x & 0xFF) == 0xA7 => { string_cmps(cpu, ram, ram_size, lane); }
            x if (x & 0xFF) == 0xAA => { string_stosb(cpu, ram, ram_size); }
            x if (x & 0xFF) == 0xAB => { string_stos(cpu, ram, ram_size, lane); }
            x if (x & 0xFF) == 0xAC => { string_lodsb(cpu, ram, ram_size); }
            x if (x & 0xFF) == 0xAD => { string_lods(cpu, ram, ram_size, lane); }
            x if (x & 0xFF) == 0xAE => { string_scasb(cpu, ram, ram_size); }
            x if (x & 0xFF) == 0xAF => { string_scas(cpu, ram, ram_size, lane); }

            // ============================================================
            // RET imm16 (0xC2)
            // ============================================================
            x if (x & 0xFF) == 0xC2 => {
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
            x if (x & 0xFF) == 0x69 => {
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
            x if (x & 0xFF) == 0x6B => {
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
            x if (x & 0xFF) == 0xC8 => {
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
            x if (x & 0xFF) == 0x6A => {
                let imm = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8 as i64 as u64;
                if cpu.long_mode {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(8);
                    try_or_fault!(cpu, mem::store_u64(cpu, ram, ram_size, cpu.regs[RSP], imm));
                } else {
                    cpu.regs[RSP] = cpu.regs[RSP].wrapping_sub(4);
                    try_or_fault!(cpu, mem::store_u32(cpu, ram, ram_size, cpu.regs[RSP], imm as u32));
                }
            }
            x if (x & 0xFF) == 0x68 => {
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
            x if (x & 0xFF) == 0xE2 => {
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
                if cpu.regs[RCX] != 0 {
                    cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                }
            }
            x if (x & 0xFF) == 0xE0 => {
                // LOOPNZ
                let rel = try_or_fault!(cpu, fetch_imm8(cpu, ram, ram_size)) as i8;
                cpu.regs[RCX] = cpu.regs[RCX].wrapping_sub(1);
                if cpu.regs[RCX] != 0 && !eval_cc(cpu, 4) { // ZF==0
                    cpu.rip = cpu.rip.wrapping_add(rel as i64 as u64);
                }
            }
            x if (x & 0xFF) == 0xE1 => {
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
            x if (x & 0xFF) == 0x8C => {
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
            x if (x & 0xFF) == 0x8E => {
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
