// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

#![no_std]
#![allow(unused_unsafe)]

mod alloc;
mod cpu;
mod decode;
mod elf;
mod exports;
mod host;
mod mem;
mod syscall;
mod term;
mod tty;
mod types;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    unsafe { host::abort_js() }
}
