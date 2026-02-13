#![no_std]
#![allow(dead_code)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]

mod types;
mod host;
mod exports;
mod mem;
mod flags;
mod cpu;
mod pic;
mod pit;
mod uart;
mod pci;
mod virtio;
mod virtio_console;
mod virtio_9p;
mod virtio_blk;
mod virtio_net;
mod boot;

// Panic handler required for no_std
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    // Log code 99 = Rust panic, then abort
    unsafe { host::debug_log(99); }
    unsafe { host::abort_js(); }
    #[allow(unreachable_code)]
    loop {}
}
