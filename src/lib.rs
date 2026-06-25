// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// On the wasm target the full emulator is compiled as `no_std` (the shipped
// artifact). On any other target — i.e. `cargo test`/`cargo nextest` on the host
// — only the pure, host-safe core modules (decode, types) are built, with std,
// so they can run real unit tests. The wasm/host-coupled modules are excluded
// there; their behaviour is covered end-to-end by the node-harness suite.
// Every gate below is true on wasm32, so the wasm build is byte-for-byte unchanged.
#![cfg_attr(target_arch = "wasm32", no_std)]
#![allow(unused_unsafe)]

#[cfg(target_arch = "wasm32")]
mod alloc;
#[cfg(target_arch = "wasm32")]
mod cpu;
mod decode;
#[cfg(target_arch = "wasm32")]
mod elf;
#[cfg(target_arch = "wasm32")]
mod exports;
#[cfg(target_arch = "wasm32")]
mod host;
#[cfg(target_arch = "wasm32")]
mod mem;
#[cfg(target_arch = "wasm32")]
mod syscall;
#[cfg(target_arch = "wasm32")]
mod term;
#[cfg(target_arch = "wasm32")]
mod tty;
mod types;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    unsafe { host::abort_js() }
}
