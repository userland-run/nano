/// Read u8 from guest address
#[inline(always)]
pub unsafe fn read_u8(base: u32, addr: u64) -> u8 {
    *((base + addr as u32) as *const u8)
}

/// Read u16 LE from guest address (single WASM i32.load16_u)
#[inline(always)]
pub unsafe fn read_u16(base: u32, addr: u64) -> u16 {
    ((base + addr as u32) as *const u16).read_unaligned()
}

/// Read u32 LE from guest address (single WASM i32.load)
#[inline(always)]
pub unsafe fn read_u32(base: u32, addr: u64) -> u32 {
    ((base + addr as u32) as *const u32).read_unaligned()
}

/// Read u64 LE from guest address (single WASM i64.load)
#[inline(always)]
pub unsafe fn read_u64(base: u32, addr: u64) -> u64 {
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
    *((base + addr as u32) as *mut u8) = val;
}

/// Write u16 LE to guest address (single WASM i32.store16)
#[inline(always)]
pub unsafe fn write_u16(base: u32, addr: u64, val: u16) {
    ((base + addr as u32) as *mut u16).write_unaligned(val);
}

/// Write u32 LE to guest address (single WASM i32.store)
#[inline(always)]
pub unsafe fn write_u32(base: u32, addr: u64, val: u32) {
    ((base + addr as u32) as *mut u32).write_unaligned(val);
}

/// Write u64 LE to guest address (single WASM i64.store)
#[inline(always)]
pub unsafe fn write_u64(base: u32, addr: u64, val: u64) {
    ((base + addr as u32) as *mut u64).write_unaligned(val);
}

/// Write a byte slice to guest memory
#[inline]
pub unsafe fn write_bytes(base: u32, addr: u64, data: &[u8]) {
    let dst = (base + addr as u32) as *mut u8;
    core::ptr::copy_nonoverlapping(data.as_ptr(), dst, data.len());
}

/// Read bytes from guest memory into a slice
#[inline]
pub unsafe fn read_bytes(base: u32, addr: u64, buf: &mut [u8]) {
    let src = (base + addr as u32) as *const u8;
    core::ptr::copy_nonoverlapping(src, buf.as_mut_ptr(), buf.len());
}

/// Zero a region of guest memory
#[inline]
pub unsafe fn zero_mem(base: u32, addr: u64, len: usize) {
    let dst = (base + addr as u32) as *mut u8;
    core::ptr::write_bytes(dst, 0, len);
}

/// Copy a region of guest memory (handles overlapping via memmove)
#[inline]
pub unsafe fn copy_within(base: u32, src_addr: u64, dst_addr: u64, len: usize) {
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
