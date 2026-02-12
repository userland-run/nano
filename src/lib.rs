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
    // In release builds, this compiles to unreachable.
    // We call the host abort function to terminate.
    unsafe { host::abort_js(); }
    #[allow(unreachable_code)]
    loop {}
}
