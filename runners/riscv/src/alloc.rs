// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

use core::sync::atomic::{AtomicU32, Ordering};

extern "C" {
    static __heap_base: u8;
}

/// Global heap pointer for bump allocation.
/// Lazy-initialized from __heap_base on first use.
static HEAP_PTR: AtomicU32 = AtomicU32::new(0);

/// Initialize the allocator with the start of free memory
pub fn init(start: u32) {
    HEAP_PTR.store(start, Ordering::SeqCst);
}

/// Simple bump allocator - allocates `size` bytes aligned to 8
#[no_mangle]
pub extern "C" fn malloc(size: u32) -> u32 {
    let aligned_size = (size + 7) & !7;
    loop {
        let mut old = HEAP_PTR.load(Ordering::SeqCst);
        if old == 0 {
            // Lazy init from __heap_base (linker-provided symbol)
            let base = unsafe { &__heap_base as *const u8 as u32 };
            let base_aligned = (base + 7) & !7;
            let _ = HEAP_PTR.compare_exchange(0, base_aligned, Ordering::SeqCst, Ordering::SeqCst);
            old = HEAP_PTR.load(Ordering::SeqCst);
        }
        let new = old + aligned_size;
        // Check we don't exceed WASM memory
        let mem_pages = core::arch::wasm32::memory_size(0) as u32;
        let mem_bytes = mem_pages * 65536;
        if new > mem_bytes {
            // Try to grow memory
            let needed_pages = ((new - mem_bytes) + 65535) / 65536;
            if core::arch::wasm32::memory_grow(0, needed_pages as usize) == usize::MAX {
                return 0;
            }
        }
        if HEAP_PTR
            .compare_exchange(old, new, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return old;
        }
    }
}

/// Free is a no-op for bump allocator
#[no_mangle]
pub extern "C" fn free(_ptr: u32) {
    // bump allocator: no-op
}
