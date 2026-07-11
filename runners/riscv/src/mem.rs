// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// =====================================================================
// A2: self-modifying-code detection
//
// The guest (V8) emits no `fence.i`, so we watch guest stores instead. Pages the
// interpreter has built a block from are marked in CODE_PAGES; a store into a
// marked page sets CODE_DIRTY, and the exec loop invalidates stale blocks before
// running the next one. Sized to cover the 2GB max guest address space.
// =====================================================================
const NUM_CODE_PAGES: usize = 1 << 19; // 524288 * 4KB = 2GB
static mut CODE_PAGES: [u8; NUM_CODE_PAGES] = [0; NUM_CODE_PAGES];
static mut CODE_DIRTY: bool = false;

/// Mark the 4KB page containing `guest_addr` as holding cached code.
#[inline(always)]
pub unsafe fn mark_code_page(guest_addr: u64) {
    CODE_PAGES[(guest_addr >> 12) as usize & (NUM_CODE_PAGES - 1)] = 1;
}

/// Note a guest store: flag dirty if it lands in a page that holds cached code.
#[inline(always)]
unsafe fn note_store(guest_addr: u64) {
    if CODE_PAGES[(guest_addr >> 12) as usize & (NUM_CODE_PAGES - 1)] != 0 {
        CODE_DIRTY = true;
    }
}

/// Take-and-clear the code-dirty flag (polled at the exec loop top).
#[inline(always)]
pub unsafe fn take_code_dirty() -> bool {
    let d = CODE_DIRTY;
    CODE_DIRTY = false;
    d
}

/// Clear all code-page marks (on program load / snapshot restore).
pub unsafe fn clear_code_pages() {
    core::ptr::write_bytes(CODE_PAGES.as_mut_ptr(), 0, NUM_CODE_PAGES);
    CODE_DIRTY = false;
}

// Opt-in diagnostic (cargo feature `memcheck`, off by default → zero cost):
// log any guest access whose effective address leaves linear memory, or whose
// u64 address truncates in the `addr as u32` cast (silent aliasing). Each hit
// is emitted via debug_log as addr (3 words) + guest pc (2 words) so the host
// can symbolize the faulting guest instruction. Costs a memory_size() per
// access, so it's only compiled into `--features memcheck` debug builds. This
// is how the Intl.Segmenter/NULL-BreakIterator guest fault was root-caused.
#[cfg(feature = "memcheck")]
static mut DBG_PC: u64 = 0;

/// Record the guest pc of the instruction about to execute (memcheck builds).
#[cfg(feature = "memcheck")]
#[inline(always)]
pub unsafe fn set_dbg_pc(pc: u64) {
    DBG_PC = pc;
}

#[cfg(feature = "memcheck")]
#[inline(always)]
unsafe fn dbg_check(base: u32, addr: u64, len: u64) {
    let eff = base as u64 + (addr as u32) as u64;
    let mem = (core::arch::wasm32::memory_size(0) as u64) * 65536;
    if eff + len > mem || addr > u32::MAX as u64 {
        crate::host::debug_log((0x7A000000u32 | ((addr & 0xFFFFFF) as u32)) as i32);
        crate::host::debug_log((0x7B000000u32 | (((addr >> 24) & 0xFFFFFF) as u32)) as i32);
        crate::host::debug_log((0x7C000000u32 | (((addr >> 48) & 0xFFFF) as u32)) as i32);
        crate::host::debug_log((0x7D000000u32 | ((DBG_PC & 0xFFFFFF) as u32)) as i32);
        crate::host::debug_log((0x7E000000u32 | (((DBG_PC >> 24) & 0xFFFFFF) as u32)) as i32);
    }
}
#[cfg(not(feature = "memcheck"))]
#[inline(always)]
unsafe fn dbg_check(_base: u32, _addr: u64, _len: u64) {}

/// Read u8 from guest address
#[inline(always)]
pub unsafe fn read_u8(base: u32, addr: u64) -> u8 {
    dbg_check(base, addr, 1);
    *((base + addr as u32) as *const u8)
}

/// Read u16 LE from guest address (single WASM i32.load16_u)
#[inline(always)]
pub unsafe fn read_u16(base: u32, addr: u64) -> u16 {
    dbg_check(base, addr, 2);
    ((base + addr as u32) as *const u16).read_unaligned()
}

/// Read u32 LE from guest address (single WASM i32.load)
#[inline(always)]
pub unsafe fn read_u32(base: u32, addr: u64) -> u32 {
    dbg_check(base, addr, 4);
    ((base + addr as u32) as *const u32).read_unaligned()
}

/// Read u64 LE from guest address (single WASM i64.load)
#[inline(always)]
pub unsafe fn read_u64(base: u32, addr: u64) -> u64 {
    dbg_check(base, addr, 8);
    ((base + addr as u32) as *const u64).read_unaligned()
}

/// Read i8 from guest address
#[inline(always)]
pub unsafe fn read_i8(base: u32, addr: u64) -> i8 {
    read_u8(base, addr) as i8
}

/// Read i16 from guest address
#[inline(always)]
pub unsafe fn read_i16(base: u32, addr: u64) -> i16 {
    read_u16(base, addr) as i16
}

/// Read i32 from guest address
#[inline(always)]
pub unsafe fn read_i32(base: u32, addr: u64) -> i32 {
    read_u32(base, addr) as i32
}

/// Read i64 from guest address
#[inline(always)]
pub unsafe fn read_i64(base: u32, addr: u64) -> i64 {
    read_u64(base, addr) as i64
}

/// Write u8 to guest address
#[inline(always)]
pub unsafe fn write_u8(base: u32, addr: u64, val: u8) {
    dbg_check(base, addr, 1);
    note_store(addr);
    *((base + addr as u32) as *mut u8) = val;
}

/// Write u16 LE to guest address (single WASM i32.store16)
#[inline(always)]
pub unsafe fn write_u16(base: u32, addr: u64, val: u16) {
    dbg_check(base, addr, 2);
    note_store(addr);
    ((base + addr as u32) as *mut u16).write_unaligned(val);
}

/// Write u32 LE to guest address (single WASM i32.store)
#[inline(always)]
pub unsafe fn write_u32(base: u32, addr: u64, val: u32) {
    dbg_check(base, addr, 4);
    note_store(addr);
    ((base + addr as u32) as *mut u32).write_unaligned(val);
}

/// Write u64 LE to guest address (single WASM i64.store)
#[inline(always)]
pub unsafe fn write_u64(base: u32, addr: u64, val: u64) {
    dbg_check(base, addr, 8);
    note_store(addr);
    ((base + addr as u32) as *mut u64).write_unaligned(val);
}

/// Write a byte slice to guest memory
#[inline]
pub unsafe fn write_bytes(base: u32, addr: u64, data: &[u8]) {
    dbg_check(base, addr, data.len() as u64);
    let dst = (base + addr as u32) as *mut u8;
    core::ptr::copy_nonoverlapping(data.as_ptr(), dst, data.len());
}

/// Read bytes from guest memory into a slice
#[inline]
pub unsafe fn read_bytes(base: u32, addr: u64, buf: &mut [u8]) {
    dbg_check(base, addr, buf.len() as u64);
    let src = (base + addr as u32) as *const u8;
    core::ptr::copy_nonoverlapping(src, buf.as_mut_ptr(), buf.len());
}

/// Zero a region of guest memory
#[inline]
pub unsafe fn zero_mem(base: u32, addr: u64, len: usize) {
    dbg_check(base, addr, len as u64);
    let dst = (base + addr as u32) as *mut u8;
    core::ptr::write_bytes(dst, 0, len);
}

/// Copy a region of guest memory (handles overlapping via memmove)
#[inline]
pub unsafe fn copy_within(base: u32, src_addr: u64, dst_addr: u64, len: usize) {
    dbg_check(base, src_addr, len as u64);
    dbg_check(base, dst_addr, len as u64);
    let src = (base + src_addr as u32) as *const u8;
    let dst = (base + dst_addr as u32) as *mut u8;
    core::ptr::copy(src, dst, len); // handles overlap
}

/// Get a raw pointer into guest memory
#[inline(always)]
pub unsafe fn guest_ptr(base: u32, addr: u64) -> *mut u8 {
    (base + addr as u32) as *mut u8
}

/// Read a null-terminated string from guest memory (up to max_len bytes)
pub unsafe fn read_cstr(base: u32, addr: u64, buf: &mut [u8]) -> usize {
    let src = (base + addr as u32) as *const u8;
    let max = buf.len() - 1;
    let mut i = 0;
    while i < max {
        let b = src.add(i).read();
        if b == 0 {
            break;
        }
        buf[i] = b;
        i += 1;
    }
    buf[i] = 0;
    i
}

/// Get length of null-terminated guest string
pub unsafe fn strlen_guest(base: u32, addr: u64) -> usize {
    let src = (base + addr as u32) as *const u8;
    let mut i = 0;
    while src.add(i).read() != 0 {
        i += 1;
    }
    i
}
