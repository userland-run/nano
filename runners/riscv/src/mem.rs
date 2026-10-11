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

/// Range form of note_store for bulk writes (syscall-side write_bytes /
/// zero_mem / copy_within, and host-side writes reported via
/// vm_note_host_write): flag dirty if ANY page in [addr, addr+len) holds cached
/// code, so a block decoded from bytes the host or a syscall later rewrites
/// (e.g. a file read() into a JIT code buffer) is invalidated.
pub unsafe fn note_store_range(addr: u64, len: u64) {
    if len == 0 {
        return;
    }
    let first = addr >> 12;
    let last = addr.saturating_add(len - 1) >> 12;
    let mut pg = first;
    while pg <= last {
        if CODE_PAGES[pg as usize & (NUM_CODE_PAGES - 1)] != 0 {
            CODE_DIRTY = true;
            return;
        }
        pg += 1;
    }
}

// =====================================================================
// Guest address bounds
//
// Guest RAM is one bump-allocated region; the Vm struct (and the host's
// scratch buffers, thread structs, …) are allocated right AFTER it, and the
// Rust statics (block cache, socket table, …) sit below it. A raw
// `base + addr as u32` therefore let a guest address >= ram_size (or one that
// wraps in the u32 truncation) read/overwrite host-trusted state. Every guest
// access now goes through `ea()`: an in-range address maps to base+addr as
// before; an out-of-range one is redirected to a small static SINK (loads
// read zeros/garbage, stores are discarded). This is a compare + select per
// access — no branch in the hot path — and vm_create pads RAM by
// RAM_GUARD_PAD bytes so an in-range access straddling the end (e.g. an
// 8-byte load at ram_size-4) stays inside the allocation. Out-of-range
// accesses are silently absorbed rather than raising SIGSEGV (the cheap
// option; a guest doing this was already corrupting the VM).
// =====================================================================

/// Bytes of padding allocated after guest RAM (covers an access of up to 8
/// bytes that starts in range but straddles ram_size).
pub const RAM_GUARD_PAD: u32 = 64;

/// Exclusive upper bound for guest addresses (= ram_size). 0 until a VM
/// exists, which routes every access to the sink.
static mut RAM_LIMIT: u64 = 0;

/// Landing zone for out-of-range guest accesses (>= the widest scalar access).
#[repr(align(16))]
#[allow(dead_code)]
struct Sink([u8; 64]);
static mut SINK: Sink = Sink([0; 64]);

/// Set the guest address limit (called whenever ram_size is established).
pub unsafe fn set_ram_limit(ram_size: u32) {
    RAM_LIMIT = ram_size as u64;
}

/// True when [addr, addr+len) lies entirely inside guest RAM.
#[inline(always)]
pub unsafe fn range_ok(addr: u64, len: u64) -> bool {
    addr <= RAM_LIMIT && len <= RAM_LIMIT - addr
}

/// Effective linear-memory address of a scalar guest access (<= 8 bytes).
#[inline(always)]
pub unsafe fn ea(base: u32, addr: u64) -> u32 {
    let sink = core::ptr::addr_of_mut!(SINK) as u32;
    if addr < RAM_LIMIT { base.wrapping_add(addr as u32) } else { sink }
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
    *(ea(base, addr) as *const u8)
}

/// Read u16 LE from guest address (single WASM i32.load16_u)
#[inline(always)]
pub unsafe fn read_u16(base: u32, addr: u64) -> u16 {
    dbg_check(base, addr, 2);
    (ea(base, addr) as *const u16).read_unaligned()
}

/// Read u32 LE from guest address (single WASM i32.load)
#[inline(always)]
pub unsafe fn read_u32(base: u32, addr: u64) -> u32 {
    dbg_check(base, addr, 4);
    (ea(base, addr) as *const u32).read_unaligned()
}

/// Read u64 LE from guest address (single WASM i64.load)
#[inline(always)]
pub unsafe fn read_u64(base: u32, addr: u64) -> u64 {
    dbg_check(base, addr, 8);
    (ea(base, addr) as *const u64).read_unaligned()
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
    *(ea(base, addr) as *mut u8) = val;
}

/// Write u16 LE to guest address (single WASM i32.store16)
#[inline(always)]
pub unsafe fn write_u16(base: u32, addr: u64, val: u16) {
    dbg_check(base, addr, 2);
    note_store(addr);
    (ea(base, addr) as *mut u16).write_unaligned(val);
}

/// Write u32 LE to guest address (single WASM i32.store)
#[inline(always)]
pub unsafe fn write_u32(base: u32, addr: u64, val: u32) {
    dbg_check(base, addr, 4);
    note_store(addr);
    (ea(base, addr) as *mut u32).write_unaligned(val);
}

/// Write u64 LE to guest address (single WASM i64.store)
#[inline(always)]
pub unsafe fn write_u64(base: u32, addr: u64, val: u64) {
    dbg_check(base, addr, 8);
    note_store(addr);
    (ea(base, addr) as *mut u64).write_unaligned(val);
}

/// Write a byte slice to guest memory (no-op if the range is out of bounds)
#[inline]
pub unsafe fn write_bytes(base: u32, addr: u64, data: &[u8]) {
    dbg_check(base, addr, data.len() as u64);
    if !range_ok(addr, data.len() as u64) {
        return;
    }
    note_store_range(addr, data.len() as u64);
    let dst = (base + addr as u32) as *mut u8;
    core::ptr::copy_nonoverlapping(data.as_ptr(), dst, data.len());
}

/// Read bytes from guest memory into a slice (zero-filled if out of bounds)
#[inline]
pub unsafe fn read_bytes(base: u32, addr: u64, buf: &mut [u8]) {
    dbg_check(base, addr, buf.len() as u64);
    if !range_ok(addr, buf.len() as u64) {
        buf.fill(0);
        return;
    }
    let src = (base + addr as u32) as *const u8;
    core::ptr::copy_nonoverlapping(src, buf.as_mut_ptr(), buf.len());
}

/// Zero a region of guest memory (no-op if the range is out of bounds)
#[inline]
pub unsafe fn zero_mem(base: u32, addr: u64, len: usize) {
    dbg_check(base, addr, len as u64);
    if !range_ok(addr, len as u64) {
        return;
    }
    note_store_range(addr, len as u64);
    let dst = (base + addr as u32) as *mut u8;
    core::ptr::write_bytes(dst, 0, len);
}

/// Copy a region of guest memory (handles overlapping via memmove; no-op if
/// either range is out of bounds)
#[inline]
pub unsafe fn copy_within(base: u32, src_addr: u64, dst_addr: u64, len: usize) {
    dbg_check(base, src_addr, len as u64);
    dbg_check(base, dst_addr, len as u64);
    if !range_ok(src_addr, len as u64) || !range_ok(dst_addr, len as u64) {
        return;
    }
    note_store_range(dst_addr, len as u64);
    let src = (base + src_addr as u32) as *const u8;
    let dst = (base + dst_addr as u32) as *mut u8;
    core::ptr::copy(src, dst, len); // handles overlap
}

/// Get a raw pointer into guest memory (bounds-guarded like a scalar access)
#[inline(always)]
pub unsafe fn guest_ptr(base: u32, addr: u64) -> *mut u8 {
    ea(base, addr) as *mut u8
}

/// Read a null-terminated string from guest memory (up to buf.len()-1 bytes).
/// Returns the length; stops at the end of guest RAM.
pub unsafe fn read_cstr(base: u32, addr: u64, buf: &mut [u8]) -> usize {
    let max = buf.len() - 1;
    let mut i = 0;
    while i < max {
        let a = addr.wrapping_add(i as u64);
        if a >= RAM_LIMIT {
            break;
        }
        let b = *((base + a as u32) as *const u8);
        if b == 0 {
            break;
        }
        buf[i] = b;
        i += 1;
    }
    buf[i] = 0;
    i
}

/// Copy a NUL-terminated guest string into `dst` (capacity `cap`, including the
/// NUL). Returns the length (excluding the NUL), or a negative errno:
/// -36 ENAMETOOLONG when no NUL fits in `cap`, -14 EFAULT when the string runs
/// off the end of guest RAM. Never truncates silently.
pub unsafe fn copy_cstr(base: u32, addr: u64, dst: *mut u8, cap: usize) -> i64 {
    let mut i = 0usize;
    while i < cap {
        let a = addr.wrapping_add(i as u64);
        if a >= RAM_LIMIT {
            *dst = 0;
            return -14; // EFAULT
        }
        let b = *((base + a as u32) as *const u8);
        *dst.add(i) = b;
        if b == 0 {
            return i as i64;
        }
        i += 1;
    }
    *dst = 0;
    -36 // ENAMETOOLONG
}

/// Get length of null-terminated guest string (stops at the end of guest RAM)
pub unsafe fn strlen_guest(base: u32, addr: u64) -> usize {
    let mut i = 0;
    loop {
        let a = addr.wrapping_add(i as u64);
        if a >= RAM_LIMIT || *((base + a as u32) as *const u8) == 0 {
            return i;
        }
        i += 1;
    }
}
