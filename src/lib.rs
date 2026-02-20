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
mod types;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    unsafe { host::abort_js() }
}
