// Memory subsystem — Software TLB, page walker, and load/store operations.
// This is the most performance-critical code after the CPU interpreter itself.

use crate::types::*;
use core::ptr::{read_unaligned, write_unaligned};

// ============================================================
// Page table entry bits
// ============================================================
const PTE_PRESENT: u64 = 1 << 0;
const PTE_WRITE: u64 = 1 << 1;
const PTE_USER: u64 = 1 << 2;
const PTE_ACCESSED: u64 = 1 << 5;
const PTE_DIRTY: u64 = 1 << 6;
const PTE_PS: u64 = 1 << 7;     // Page Size (2MB/1GB pages)
const PTE_NX: u64 = 1u64 << 63; // No-Execute
const PTE_ADDR_MASK: u64 = 0x000F_FFFF_FFFF_F000;

/// Error type for memory access faults
#[derive(Copy, Clone, Debug)]
pub enum MemFault {
    PageFault { vaddr: u64, error_code: u32 },
    DeviceAccess { phys: u64, size: u32 },
}

// ============================================================
// TLB Operations
// ============================================================

/// TLB lookup for reads. Returns host pointer on hit.
#[inline(always)]
pub unsafe fn tlb_lookup_read(cpu: &Cpu, vaddr: u64) -> Option<*const u8> {
    let page = vaddr & !PAGE_MASK;
    let set_idx = ((vaddr >> PAGE_SHIFT) as usize) & (TLB_SETS - 1);
    let set = &cpu.tlb.read[set_idx];

    // Check all 4 ways
    for way in 0..TLB_WAYS {
        if set[way].tag == page {
            let host = set[way].addend as usize + vaddr as u32 as usize;
            return Some(host as *const u8);
        }
    }
    None
}

/// TLB lookup for writes. Returns host pointer on hit.
#[inline(always)]
pub unsafe fn tlb_lookup_write(cpu: &Cpu, vaddr: u64) -> Option<*mut u8> {
    let page = vaddr & !PAGE_MASK;
    let set_idx = ((vaddr >> PAGE_SHIFT) as usize) & (TLB_SETS - 1);
    let set = &cpu.tlb.write[set_idx];

    for way in 0..TLB_WAYS {
        if set[way].tag == page {
            let host = set[way].addend as usize + vaddr as u32 as usize;
            return Some(host as *mut u8);
        }
    }
    None
}

/// TLB lookup for code fetch. Returns host pointer on hit.
#[inline(always)]
pub unsafe fn tlb_lookup_code(cpu: &Cpu, vaddr: u64) -> Option<*const u8> {
    let page = vaddr & !PAGE_MASK;
    let set_idx = ((vaddr >> PAGE_SHIFT) as usize) & (TLB_SETS - 1);
    let set = &cpu.tlb.code[set_idx];

    for way in 0..TLB_WAYS {
        if set[way].tag == page {
            let host = set[way].addend as usize + vaddr as u32 as usize;
            return Some(host as *const u8);
        }
    }
    None
}

/// Insert into read TLB. Shifts way 0 eviction.
#[inline(always)]
pub unsafe fn tlb_insert_read(cpu: &mut Cpu, vaddr: u64, ram: *mut u8, phys: u64, ram_size: u32) {
    if (phys & !PAGE_MASK) + PAGE_SIZE > ram_size as u64 { return; }
    let page = vaddr & !PAGE_MASK;
    let phys_page = phys & !PAGE_MASK;
    let set_idx = ((vaddr >> PAGE_SHIFT) as usize) & (TLB_SETS - 1);

    // Compute addend: host_ptr = addend + vaddr_low32
    // ram + phys_page - vaddr_page_low32
    let addend = ram as u32 + phys_page as u32 - page as u32;

    // Shift entries down, insert at way 0
    let set = &mut cpu.tlb.read[set_idx];
    set[3] = set[2];
    set[2] = set[1];
    set[1] = set[0];
    set[0] = TlbEntry { tag: page, addend };
}

/// Insert into write TLB.
#[inline(always)]
pub unsafe fn tlb_insert_write(cpu: &mut Cpu, vaddr: u64, ram: *mut u8, phys: u64, ram_size: u32) {
    if (phys & !PAGE_MASK) + PAGE_SIZE > ram_size as u64 { return; }
    let page = vaddr & !PAGE_MASK;
    let phys_page = phys & !PAGE_MASK;
    let set_idx = ((vaddr >> PAGE_SHIFT) as usize) & (TLB_SETS - 1);

    let addend = ram as u32 + phys_page as u32 - page as u32;

    let set = &mut cpu.tlb.write[set_idx];
    set[3] = set[2];
    set[2] = set[1];
    set[1] = set[0];
    set[0] = TlbEntry { tag: page, addend };
}

/// Insert into code TLB.
#[inline(always)]
pub unsafe fn tlb_insert_code(cpu: &mut Cpu, vaddr: u64, ram: *mut u8, phys: u64, ram_size: u32) {
    if (phys & !PAGE_MASK) + PAGE_SIZE > ram_size as u64 { return; }
    let page = vaddr & !PAGE_MASK;
    let phys_page = phys & !PAGE_MASK;
    let set_idx = ((vaddr >> PAGE_SHIFT) as usize) & (TLB_SETS - 1);

    let addend = ram as u32 + phys_page as u32 - page as u32;

    let set = &mut cpu.tlb.code[set_idx];
    set[3] = set[2];
    set[2] = set[1];
    set[1] = set[0];
    set[0] = TlbEntry { tag: page, addend };
}

// ============================================================
// 4-Level Page Walk (PML4 → PDP → PD → PT)
// ============================================================

/// Walk 4-level page tables. Returns physical address.
/// Sets Accessed/Dirty bits. Raises page fault on error.
pub unsafe fn walk_page_tables(
    cpu: &mut Cpu,
    ram: *mut u8,
    ram_size: u32,
    vaddr: u64,
    write: bool,
    exec: bool,
) -> Result<u64, MemFault> {
    let cr3 = cpu.cr3;

    // PML4 entry
    let pml4_idx = ((vaddr >> 39) & 0x1FF) as usize;
    let pml4_addr = (cr3 & PTE_ADDR_MASK) + (pml4_idx as u64 * 8);
    if pml4_addr + 8 > ram_size as u64 {
        return Err(MemFault::PageFault { vaddr, error_code: pf_error(write, cpu.cpl == 3, false, exec) });
    }
    let pml4e = read_unaligned((ram as usize + pml4_addr as usize) as *const u64);
    if pml4e & PTE_PRESENT == 0 {
        return Err(MemFault::PageFault { vaddr, error_code: pf_error(write, cpu.cpl == 3, false, exec) });
    }
    check_perms(pml4e, write, exec, cpu.cpl, cpu.cr0, cpu.cr4, cpu.efer, vaddr)?;

    // Set accessed bit
    if pml4e & PTE_ACCESSED == 0 {
        write_unaligned(
            (ram as usize + pml4_addr as usize) as *mut u64,
            pml4e | PTE_ACCESSED,
        );
    }

    // PDP entry
    let pdp_idx = ((vaddr >> 30) & 0x1FF) as usize;
    let pdp_addr = (pml4e & PTE_ADDR_MASK) + (pdp_idx as u64 * 8);
    if pdp_addr + 8 > ram_size as u64 {
        return Err(MemFault::PageFault { vaddr, error_code: pf_error(write, cpu.cpl == 3, false, exec) });
    }
    let pdpe = read_unaligned((ram as usize + pdp_addr as usize) as *const u64);
    if pdpe & PTE_PRESENT == 0 {
        return Err(MemFault::PageFault { vaddr, error_code: pf_error(write, cpu.cpl == 3, false, exec) });
    }
    check_perms(pdpe, write, exec, cpu.cpl, cpu.cr0, cpu.cr4, cpu.efer, vaddr)?;

    if pdpe & PTE_ACCESSED == 0 {
        write_unaligned(
            (ram as usize + pdp_addr as usize) as *mut u64,
            pdpe | PTE_ACCESSED,
        );
    }

    // 1GB page?
    if pdpe & PTE_PS != 0 {
        let phys = (pdpe & 0x000F_FFFF_C000_0000) | (vaddr & 0x3FFF_FFFF);
        if write && pdpe & PTE_DIRTY == 0 {
            write_unaligned(
                (ram as usize + pdp_addr as usize) as *mut u64,
                pdpe | PTE_DIRTY,
            );
        }
        return Ok(phys);
    }

    // PD entry
    let pd_idx = ((vaddr >> 21) & 0x1FF) as usize;
    let pd_addr = (pdpe & PTE_ADDR_MASK) + (pd_idx as u64 * 8);
    if pd_addr + 8 > ram_size as u64 {
        return Err(MemFault::PageFault { vaddr, error_code: pf_error(write, cpu.cpl == 3, false, exec) });
    }
    let pde = read_unaligned((ram as usize + pd_addr as usize) as *const u64);
    if pde & PTE_PRESENT == 0 {
        return Err(MemFault::PageFault { vaddr, error_code: pf_error(write, cpu.cpl == 3, false, exec) });
    }
    check_perms(pde, write, exec, cpu.cpl, cpu.cr0, cpu.cr4, cpu.efer, vaddr)?;

    if pde & PTE_ACCESSED == 0 {
        write_unaligned(
            (ram as usize + pd_addr as usize) as *mut u64,
            pde | PTE_ACCESSED,
        );
    }

    // 2MB page?
    if pde & PTE_PS != 0 {
        let phys = (pde & 0x000F_FFFF_FFE0_0000) | (vaddr & 0x1FFFFF);
        if write && pde & PTE_DIRTY == 0 {
            write_unaligned(
                (ram as usize + pd_addr as usize) as *mut u64,
                pde | PTE_DIRTY,
            );
        }
        return Ok(phys);
    }

    // PT entry
    let pt_idx = ((vaddr >> 12) & 0x1FF) as usize;
    let pt_addr = (pde & PTE_ADDR_MASK) + (pt_idx as u64 * 8);
    if pt_addr + 8 > ram_size as u64 {
        return Err(MemFault::PageFault { vaddr, error_code: pf_error(write, cpu.cpl == 3, false, exec) });
    }
    let pte = read_unaligned((ram as usize + pt_addr as usize) as *const u64);
    if pte & PTE_PRESENT == 0 {
        return Err(MemFault::PageFault { vaddr, error_code: pf_error(write, cpu.cpl == 3, false, exec) });
    }
    check_perms(pte, write, exec, cpu.cpl, cpu.cr0, cpu.cr4, cpu.efer, vaddr)?;

    // Set accessed + dirty
    let mut new_pte = pte | PTE_ACCESSED;
    if write {
        new_pte |= PTE_DIRTY;
    }
    if new_pte != pte {
        write_unaligned(
            (ram as usize + pt_addr as usize) as *mut u64,
            new_pte,
        );
    }

    let phys = (pte & PTE_ADDR_MASK) | (vaddr & PAGE_MASK);
    Ok(phys)
}

/// Check page table entry permissions
#[inline(always)]
unsafe fn check_perms(
    pte: u64,
    write: bool,
    exec: bool,
    cpl: u8,
    cr0: u64,
    _cr4: u64,
    efer: u64,
    vaddr: u64,
) -> Result<(), MemFault> {
    let user = cpl == 3;
    // Write check
    if write && (pte & PTE_WRITE == 0) {
        // In ring 0, writes to read-only pages are allowed unless CR0.WP is set
        if user || (cr0 & CR0_WP != 0) {
            return Err(MemFault::PageFault {
                vaddr,
                error_code: pf_error(true, user, true, false),
            });
        }
    }
    // User check
    if user && (pte & PTE_USER == 0) {
        return Err(MemFault::PageFault {
            vaddr,
            error_code: pf_error(write, true, true, false),
        });
    }
    // NX check
    if exec && (efer & EFER_NXE != 0) && (pte & PTE_NX != 0) {
        return Err(MemFault::PageFault {
            vaddr,
            error_code: pf_error(false, user, true, true),
        });
    }
    Ok(())
}

/// Build page fault error code
#[inline(always)]
fn pf_error(write: bool, user: bool, present: bool, exec: bool) -> u32 {
    let mut code = 0u32;
    if present { code |= 1; }
    if write { code |= 2; }
    if user { code |= 4; }
    if exec { code |= 16; }
    code
}

// ============================================================
// High-level load/store (TLB + page walk)
// ============================================================

/// Load a byte from virtual address.
#[inline(always)]
pub unsafe fn load_u8(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64) -> Result<u8, MemFault> {
    if let Some(ptr) = tlb_lookup_read(cpu, vaddr) {
        return Ok(read_unaligned(ptr));
    }
    // TLB miss → page walk
    let phys = walk_page_tables(cpu, ram, ram_size, vaddr, false, false)?;
    tlb_insert_read(cpu, vaddr, ram, phys, ram_size);
    if phys < ram_size as u64 {
        Ok(read_unaligned((ram as usize + phys as usize) as *const u8))
    } else {
        Ok(0xFF) // MMIO read returns 0xFF
    }
}

/// Load a 16-bit value from virtual address.
#[inline(always)]
pub unsafe fn load_u16(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64) -> Result<u16, MemFault> {
    // Check for page crossing
    if (vaddr & PAGE_MASK) <= PAGE_MASK - 1 {
        if let Some(ptr) = tlb_lookup_read(cpu, vaddr) {
            return Ok(read_unaligned(ptr as *const u16));
        }
    }
    // Slow path: byte-by-byte for cross-page or TLB miss
    let b0 = load_u8(cpu, ram, ram_size, vaddr)? as u16;
    let b1 = load_u8(cpu, ram, ram_size, vaddr.wrapping_add(1))? as u16;
    Ok(b0 | (b1 << 8))
}

/// Load a 32-bit value from virtual address.
#[inline(always)]
pub unsafe fn load_u32(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64) -> Result<u32, MemFault> {
    if (vaddr & PAGE_MASK) <= PAGE_MASK - 3 {
        if let Some(ptr) = tlb_lookup_read(cpu, vaddr) {
            return Ok(read_unaligned(ptr as *const u32));
        }
    }
    let b0 = load_u8(cpu, ram, ram_size, vaddr)? as u32;
    let b1 = load_u8(cpu, ram, ram_size, vaddr.wrapping_add(1))? as u32;
    let b2 = load_u8(cpu, ram, ram_size, vaddr.wrapping_add(2))? as u32;
    let b3 = load_u8(cpu, ram, ram_size, vaddr.wrapping_add(3))? as u32;
    Ok(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24))
}

/// Load a 64-bit value from virtual address.
#[inline(always)]
pub unsafe fn load_u64(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64) -> Result<u64, MemFault> {
    if (vaddr & PAGE_MASK) <= PAGE_MASK - 7 {
        if let Some(ptr) = tlb_lookup_read(cpu, vaddr) {
            return Ok(read_unaligned(ptr as *const u64));
        }
    }
    let lo = load_u32(cpu, ram, ram_size, vaddr)? as u64;
    let hi = load_u32(cpu, ram, ram_size, vaddr.wrapping_add(4))? as u64;
    Ok(lo | (hi << 32))
}

/// Store a byte to virtual address.
#[inline(always)]
pub unsafe fn store_u8(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64, val: u8) -> Result<(), MemFault> {
    if let Some(ptr) = tlb_lookup_write(cpu, vaddr) {
        write_unaligned(ptr, val);
        return Ok(());
    }
    let phys = walk_page_tables(cpu, ram, ram_size, vaddr, true, false)?;
    tlb_insert_write(cpu, vaddr, ram, phys, ram_size);
    if phys < ram_size as u64 {
        write_unaligned((ram as usize + phys as usize) as *mut u8, val);
    }
    Ok(())
}

/// Store a 16-bit value to virtual address.
#[inline(always)]
pub unsafe fn store_u16(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64, val: u16) -> Result<(), MemFault> {
    if (vaddr & PAGE_MASK) <= PAGE_MASK - 1 {
        if let Some(ptr) = tlb_lookup_write(cpu, vaddr) {
            write_unaligned(ptr as *mut u16, val);
            return Ok(());
        }
    }
    store_u8(cpu, ram, ram_size, vaddr, val as u8)?;
    store_u8(cpu, ram, ram_size, vaddr.wrapping_add(1), (val >> 8) as u8)?;
    Ok(())
}

/// Store a 32-bit value to virtual address.
#[inline(always)]
pub unsafe fn store_u32(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64, val: u32) -> Result<(), MemFault> {
    if (vaddr & PAGE_MASK) <= PAGE_MASK - 3 {
        if let Some(ptr) = tlb_lookup_write(cpu, vaddr) {
            write_unaligned(ptr as *mut u32, val);
            return Ok(());
        }
    }
    store_u8(cpu, ram, ram_size, vaddr, val as u8)?;
    store_u8(cpu, ram, ram_size, vaddr.wrapping_add(1), (val >> 8) as u8)?;
    store_u8(cpu, ram, ram_size, vaddr.wrapping_add(2), (val >> 16) as u8)?;
    store_u8(cpu, ram, ram_size, vaddr.wrapping_add(3), (val >> 24) as u8)?;
    Ok(())
}

/// Store a 64-bit value to virtual address.
#[inline(always)]
pub unsafe fn store_u64(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64, val: u64) -> Result<(), MemFault> {
    if (vaddr & PAGE_MASK) <= PAGE_MASK - 7 {
        if let Some(ptr) = tlb_lookup_write(cpu, vaddr) {
            write_unaligned(ptr as *mut u64, val);
            return Ok(());
        }
    }
    store_u32(cpu, ram, ram_size, vaddr, val as u32)?;
    store_u32(cpu, ram, ram_size, vaddr.wrapping_add(4), (val >> 32) as u32)?;
    Ok(())
}

/// Fetch a code byte from virtual address (uses code TLB).
#[inline(always)]
pub unsafe fn fetch_u8(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64) -> Result<u8, MemFault> {
    if let Some(ptr) = tlb_lookup_code(cpu, vaddr) {
        return Ok(read_unaligned(ptr));
    }
    let phys = walk_page_tables(cpu, ram, ram_size, vaddr, false, true)?;
    tlb_insert_code(cpu, vaddr, ram, phys, ram_size);
    if phys < ram_size as u64 {
        Ok(read_unaligned((ram as usize + phys as usize) as *const u8))
    } else {
        Ok(0xFF)
    }
}

/// Fetch a 32-bit immediate from instruction stream.
#[inline(always)]
pub unsafe fn fetch_u32(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64) -> Result<u32, MemFault> {
    if (vaddr & PAGE_MASK) <= PAGE_MASK - 3 {
        if let Some(ptr) = tlb_lookup_code(cpu, vaddr) {
            return Ok(read_unaligned(ptr as *const u32));
        }
    }
    let b0 = fetch_u8(cpu, ram, ram_size, vaddr)? as u32;
    let b1 = fetch_u8(cpu, ram, ram_size, vaddr.wrapping_add(1))? as u32;
    let b2 = fetch_u8(cpu, ram, ram_size, vaddr.wrapping_add(2))? as u32;
    let b3 = fetch_u8(cpu, ram, ram_size, vaddr.wrapping_add(3))? as u32;
    Ok(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24))
}

/// Fetch a 64-bit immediate from instruction stream.
#[inline(always)]
pub unsafe fn fetch_u64(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, vaddr: u64) -> Result<u64, MemFault> {
    let lo = fetch_u32(cpu, ram, ram_size, vaddr)? as u64;
    let hi = fetch_u32(cpu, ram, ram_size, vaddr.wrapping_add(4))? as u64;
    Ok(lo | (hi << 32))
}

/// Physical memory read (bypasses TLB, for page table walks and MMIO)
#[inline(always)]
pub unsafe fn phys_read_u8(ram: *mut u8, ram_size: u32, phys: u64) -> u8 {
    if phys < ram_size as u64 {
        read_unaligned((ram as usize + phys as usize) as *const u8)
    } else {
        0xFF
    }
}

/// Physical memory write
#[inline(always)]
pub unsafe fn phys_write_u8(ram: *mut u8, ram_size: u32, phys: u64, val: u8) {
    if phys < ram_size as u64 {
        write_unaligned((ram as usize + phys as usize) as *mut u8, val);
    }
}

/// Physical memory read 32-bit
#[inline(always)]
pub unsafe fn phys_read_u32(ram: *mut u8, ram_size: u32, phys: u64) -> u32 {
    if phys + 4 <= ram_size as u64 {
        read_unaligned((ram as usize + phys as usize) as *const u32)
    } else {
        0xFFFFFFFF
    }
}

/// Physical memory write 32-bit
#[inline(always)]
pub unsafe fn phys_write_u32(ram: *mut u8, ram_size: u32, phys: u64, val: u32) {
    if phys + 4 <= ram_size as u64 {
        write_unaligned((ram as usize + phys as usize) as *mut u32, val);
    }
}

/// Physical memory read 64-bit
#[inline(always)]
pub unsafe fn phys_read_u64(ram: *mut u8, ram_size: u32, phys: u64) -> u64 {
    if phys + 8 <= ram_size as u64 {
        read_unaligned((ram as usize + phys as usize) as *const u64)
    } else {
        0xFFFFFFFFFFFFFFFF
    }
}

/// Physical memory write 64-bit
#[inline(always)]
pub unsafe fn phys_write_u64(ram: *mut u8, ram_size: u32, phys: u64, val: u64) {
    if phys + 8 <= ram_size as u64 {
        write_unaligned((ram as usize + phys as usize) as *mut u64, val);
    }
}
