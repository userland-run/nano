// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

use crate::mem;
use crate::types::*;

// ELF64 constants
const EI_MAG: [u8; 4] = [0x7F, b'E', b'L', b'F'];
const ELFCLASS64: u8 = 2;
const ELFDATA2LSB: u8 = 1;
const EM_RISCV: u16 = 0xF3;
const PT_LOAD: u32 = 1;
const PT_TLS: u32 = 7;

// Auxiliary vector types
const AT_NULL: u64 = 0;
const AT_PHDR: u64 = 3;
const AT_PHENT: u64 = 4;
const AT_PHNUM: u64 = 5;
const AT_PAGESZ: u64 = 6;
const AT_ENTRY: u64 = 9;
const AT_HWCAP: u64 = 16;
const AT_CLKTCK: u64 = 17;
const AT_RANDOM: u64 = 25;

/// Result of ELF loading
pub struct ElfLoadResult {
    pub entry: u64,
    pub phdr_addr: u64,
    pub phentsize: u64,
    pub phnum: u64,
}

/// Load an ELF64 RISC-V binary into guest memory.
/// Returns ElfLoadResult with entry point and phdr info, or entry=0 on failure.
pub unsafe fn load(vm: &mut Vm, elf_addr: u64, elf_size: u32) -> ElfLoadResult {
    let fail = ElfLoadResult { entry: 0, phdr_addr: 0, phentsize: 0, phnum: 0 };
    // Validate ELF header
    if elf_size < 64 {
        return fail;
    }

    // Check magic
    for i in 0..4 {
        if mem::read_u8(vm.ram_base, elf_addr + i as u64) != EI_MAG[i] {
            return fail;
        }
    }

    // Check class (64-bit) and endianness (little)
    if mem::read_u8(vm.ram_base, elf_addr + 4) != ELFCLASS64 {
        return fail;
    }
    if mem::read_u8(vm.ram_base, elf_addr + 5) != ELFDATA2LSB {
        return fail;
    }

    // Check machine type
    let e_machine = mem::read_u16(vm.ram_base, elf_addr + 18);
    if e_machine != EM_RISCV {
        return fail;
    }

    let e_entry = mem::read_u64(vm.ram_base, elf_addr + 24);
    let e_phoff = mem::read_u64(vm.ram_base, elf_addr + 32);
    let e_phentsize = mem::read_u16(vm.ram_base, elf_addr + 54) as u64;
    let e_phnum = mem::read_u16(vm.ram_base, elf_addr + 56) as u64;

    let mut highest_addr: u64 = 0;
    let mut phdr_guest_addr: u64 = 0;
    let mut tls_addr: u64 = 0;
    let mut tls_memsz: u64 = 0;
    let mut tls_filesz: u64 = 0;
    let mut tls_align: u64 = 0;

    // Two-pass ELF loading to handle overlapping ELF source and segment destinations.
    // When the ELF file is at guest offset 0, loading segment 0 to a higher VA
    // can overwrite the source data needed for later segments.
    //
    // Pass 1: Collect PT_LOAD info and metadata (TLS, phdr addr, highest_addr).
    // Pass 2: Load segments from highest file offset to lowest, so later segments'
    //         source data is read before being overwritten by earlier segments.

    // Max 8 PT_LOAD segments (typical ELFs have 2-4)
    let mut loads: [(u64, u64, u64, u64); 8] = [(0, 0, 0, 0); 8]; // (p_offset, p_vaddr, p_filesz, p_memsz)
    let mut n_loads: usize = 0;

    // Pass 1: Scan headers
    let mut i: u64 = 0;
    while i < e_phnum {
        let ph_off = elf_addr + e_phoff + i * e_phentsize;

        let p_type = mem::read_u32(vm.ram_base, ph_off);
        let _p_flags = mem::read_u32(vm.ram_base, ph_off + 4);
        let p_offset = mem::read_u64(vm.ram_base, ph_off + 8);
        let p_vaddr = mem::read_u64(vm.ram_base, ph_off + 16);
        let p_filesz = mem::read_u64(vm.ram_base, ph_off + 32);
        let p_memsz = mem::read_u64(vm.ram_base, ph_off + 40);
        let _p_align = mem::read_u64(vm.ram_base, ph_off + 48);

        if p_type == PT_LOAD {
            if n_loads < 8 {
                loads[n_loads] = (p_offset, p_vaddr, p_filesz, p_memsz);
                n_loads += 1;
            }

            let seg_end = p_vaddr + p_memsz;
            if seg_end > highest_addr {
                highest_addr = seg_end;
            }

            // Track where phdr is loaded for AT_PHDR
            if p_offset <= e_phoff && e_phoff < p_offset + p_filesz {
                phdr_guest_addr = p_vaddr + (e_phoff - p_offset);
            }
        } else if p_type == PT_TLS {
            tls_addr = p_vaddr;
            tls_memsz = p_memsz;
            tls_filesz = p_filesz;
            tls_align = _p_align;
        }

        i += 1;
    }

    // Pass 2: Load segments from highest file offset to lowest
    // Simple selection sort by p_offset descending
    let mut loaded = [false; 8];
    let mut pass: usize = 0;
    while pass < n_loads {
        // Find unloaded segment with highest p_offset
        let mut best: usize = 0;
        let mut best_off: u64 = 0;
        let mut found = false;
        let mut k: usize = 0;
        while k < n_loads {
            if !loaded[k] && (!found || loads[k].0 > best_off) {
                best = k;
                best_off = loads[k].0;
                found = true;
            }
            k += 1;
        }
        loaded[best] = true;

        let (p_offset, p_vaddr, p_filesz, p_memsz) = loads[best];

        // Copy file data using physical pointers (memmove-safe)
        if p_filesz > 0 {
            let src_phys = (vm.ram_base as u64 + elf_addr + p_offset) as *const u8;
            let dst_phys = (vm.ram_base as u64 + p_vaddr) as *mut u8;
            core::ptr::copy(src_phys, dst_phys, p_filesz as usize);
        }
        // Zero BSS (memsz > filesz)
        if p_memsz > p_filesz {
            mem::zero_mem(vm.ram_base, p_vaddr + p_filesz, (p_memsz - p_filesz) as usize);
        }

        pass += 1;
    }

    // Set up brk at page-aligned boundary above highest segment
    let brk_start = (highest_addr + PAGE_SIZE - 1) & PAGE_MASK;
    vm.brk_start = brk_start;
    vm.brk_current = brk_start;

    // mmap region starts well above brk
    vm.mmap_next_addr = brk_start + 64 * 1024 * 1024; // 64MB above brk

    // Store TLS info
    if tls_memsz > 0 {
        vm.tls_base = tls_addr;
    }

    // Return entry point and phdr info
    ElfLoadResult {
        entry: e_entry,
        phdr_addr: phdr_guest_addr,
        phentsize: e_phentsize,
        phnum: e_phnum,
    }
}

/// Set up the initial user stack with argc, argv, envp, and auxvec.
/// Returns the final stack pointer.
pub unsafe fn setup_stack(
    vm: &mut Vm,
    sp: u64,
    entry: u64,
    argc: i32,
    argv_ptrs: &[u64],
    envp_ptrs: &[u64],
    phdr_addr: u64,
    phent: u64,
    phnum: u64,
) -> u64 {
    // Stack grows downward. Layout:
    // [random bytes (16)] [padding] [auxvec] [envp NULL] [envp ptrs] [argv NULL] [argv ptrs] [argc]

    let mut sp = sp;

    // Write 16 random bytes for AT_RANDOM
    sp -= 16;
    let random_addr = sp;
    let mut i = 0;
    while i < 4 {
        let r = crate::host::emscripten_random();
        let bytes = r.to_bits().to_le_bytes();
        mem::write_u8(vm.ram_base, sp + i * 4, bytes[0]);
        mem::write_u8(vm.ram_base, sp + i * 4 + 1, bytes[1]);
        mem::write_u8(vm.ram_base, sp + i * 4 + 2, bytes[2]);
        mem::write_u8(vm.ram_base, sp + i * 4 + 3, bytes[3]);
        i += 1;
    }

    // Align to 16 bytes
    sp &= !0xF;

    // Auxiliary vector (grows downward, will be reversed)
    // We build auxvec as pairs (type, value) going downward
    // AT_HWCAP for rv64gc: I(8) M(12) A(0) F(5) D(3) C(2) = 0x112D
    let auxvec: [(u64, u64); 9] = [
        (AT_NULL, 0),
        (AT_RANDOM, random_addr),
        (AT_CLKTCK, 100),
        (AT_HWCAP, 0x112D),
        (AT_PAGESZ, 4096),
        (AT_ENTRY, entry),
        (AT_PHNUM, phnum),
        (AT_PHENT, phent),
        (AT_PHDR, phdr_addr),
    ];

    // Calculate total size needed on stack
    let auxvec_size = auxvec.len() * 16; // 7 pairs * 16 bytes
    let envp_size = (envp_ptrs.len() + 1) * 8; // envp[] + NULL
    let argv_size = (argv_ptrs.len() + 1) * 8; // argv[] + NULL
    let argc_size = 8;
    let total = argc_size + argv_size + envp_size + auxvec_size;

    sp -= total as u64;
    sp &= !0xF; // 16-byte align

    let mut pos = sp;

    // argc
    mem::write_u64(vm.ram_base, pos, argc as u64);
    pos += 8;

    // argv pointers
    for ptr in argv_ptrs {
        mem::write_u64(vm.ram_base, pos, *ptr);
        pos += 8;
    }
    mem::write_u64(vm.ram_base, pos, 0); // NULL terminator
    pos += 8;

    // envp pointers
    for ptr in envp_ptrs {
        mem::write_u64(vm.ram_base, pos, *ptr);
        pos += 8;
    }
    mem::write_u64(vm.ram_base, pos, 0); // NULL terminator
    pos += 8;

    // auxvec (AT_PHDR first, AT_NULL last)
    for i in (0..auxvec.len()).rev() {
        mem::write_u64(vm.ram_base, pos, auxvec[i].0);
        pos += 8;
        mem::write_u64(vm.ram_base, pos, auxvec[i].1);
        pos += 8;
    }

    sp
}
