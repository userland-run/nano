// WASM exports — public API functions callable from JavaScript.
// Mirrors the original TinyEMU export table.
//
// IMPORTANT: All global state (MACHINE, HEAP_PTR, HEAP_END) must use volatile
// read/write. Without volatile, LTO + opt-level="z" eliminates stores to these
// globals as "dead stores" because the compiler doesn't treat exported functions
// as independently callable entry points. Volatile forces the compiler to
// preserve every read and write.

use crate::types::Machine;

// Global machine instance pointer
static mut MACHINE: *mut Machine = core::ptr::null_mut();

// Volatile accessors — prevent LTO from dead-store-eliminating global state
#[inline(always)]
unsafe fn read_machine() -> *mut Machine {
    core::ptr::read_volatile(&raw const MACHINE)
}
#[inline(always)]
unsafe fn write_machine(m: *mut Machine) {
    core::ptr::write_volatile(&raw mut MACHINE, m);
}
#[inline(always)]
unsafe fn read_heap_ptr() -> u32 {
    core::ptr::read_volatile(&raw const HEAP_PTR)
}
#[inline(always)]
unsafe fn write_heap_ptr(val: u32) {
    core::ptr::write_volatile(&raw mut HEAP_PTR, val);
}
#[inline(always)]
unsafe fn read_heap_end() -> u32 {
    core::ptr::read_volatile(&raw const HEAP_END)
}
#[inline(always)]
unsafe fn write_heap_end(val: u32) {
    core::ptr::write_volatile(&raw mut HEAP_END, val);
}

/// Main entry point: parse config, create VM, boot kernel.
/// Called from JS: vm_start(url, mem_size, cmdline, pwd, width, height, net_enabled, drive_url)
#[no_mangle]
pub unsafe extern "C" fn vm_start(
    url: u32,
    mem_size: u32,
    cmdline: u32,
    pwd: u32,
    width: u32,
    height: u32,
    net_enabled: u32,
    drive_url: u32,
) {
    crate::boot::vm_start_impl(url, mem_size, cmdline, pwd, width, height, net_enabled, drive_url);
}

/// Initialize the heap allocator. Must be called before vm_start.
/// heap_start: byte offset in WASM linear memory where heap begins.
/// heap_size: total bytes available for heap.
#[no_mangle]
pub unsafe extern "C" fn vm_init(heap_start: u32, heap_size: u32) {
    init_heap(heap_start, heap_size);
}

/// Execute one timeslice of CPU instructions.
/// `budget` is the max instructions to execute.
/// `now_ms` is the wall-clock time from the host (Date.now()) for PIT timer.
/// Returns remaining budget (<=0 means timeslice exhausted).
#[no_mangle]
pub unsafe extern "C" fn vm_step(budget: i32, now_ms: f64) -> i32 {
    let m = read_machine();
    if m.is_null() {
        return 0;
    }
    let mach = &mut *m;
    // Advance PIT timer and fire IRQ 0 if needed
    crate::pit::tick(&mut mach.cpu, now_ms);
    crate::cpu::exec(&mut mach.cpu, mach.ram, mach.ram_size, budget)
}

/// Queue a character for the VM's console input (keyboard).
#[no_mangle]
pub unsafe extern "C" fn console_queue_char(ch: u32) {
    let m = read_machine();
    if !m.is_null() {
        let mach = &mut *m;
        // Feed UART (for console=ttyS0)
        mach.console_fifo.push(ch as u8);
        crate::uart::on_char_received(mach);
        // Feed VirtIO console RX (for console=hvc0)
        crate::virtio_console::recv_char(mach, ch as u8);
    }
}

/// Notify VM that terminal dimensions changed.
#[no_mangle]
pub unsafe extern "C" fn console_resize_event() {
    // Terminal resize — will be handled by virtio console
}

/// Send keyboard event to graphical display.
#[no_mangle]
pub unsafe extern "C" fn display_key_event(_down: u32, _keycode: u32) {
    // Graphical display keyboard input (Phase 11+)
}

/// Send mouse event to graphical display.
#[no_mangle]
pub unsafe extern "C" fn display_mouse_event(_dx: u32, _dy: u32, _buttons: u32) {
    // Graphical display mouse input
}

/// Send mouse wheel event.
#[no_mangle]
pub unsafe extern "C" fn display_wheel_event(_delta: u32) {
    // Graphical display wheel input
}

/// Write an Ethernet frame to the virtual NIC.
#[no_mangle]
pub unsafe extern "C" fn net_write_packet(_buf: u32, _len: u32) -> u32 {
    // Network packet from host → guest
    0
}

/// Set network link carrier state.
#[no_mangle]
pub unsafe extern "C" fn net_set_carrier(_carrier: u32) {
    // Network carrier state change
}

/// Load a kernel bzImage into guest RAM.
/// kernel_ptr points to the bzImage data in WASM linear memory.
/// Returns 1 on success, 0 on failure.
#[no_mangle]
pub unsafe extern "C" fn load_kernel(kernel_ptr: u32, kernel_size: u32) -> u32 {
    let m = read_machine();
    if m.is_null() {
        return 0;
    }
    let mach = &mut *m;
    let kernel = kernel_ptr as *const u8;
    if crate::boot::load_kernel(mach.ram, mach.ram_size, kernel, kernel_size) {
        1
    } else {
        0
    }
}

/// Import a file into the VM's filesystem.
#[no_mangle]
pub unsafe extern "C" fn fs_import_file(_name: u32, _buf: u32, _len: u32) {
    // File upload from host
}

// ============================================================
// Memory allocator
// ============================================================

// Simple bump allocator for WASM linear memory.
// The original uses dlmalloc; we use a minimal implementation.

static mut HEAP_PTR: u32 = 0;
static mut HEAP_END: u32 = 0;

/// Initialize the heap allocator.
pub unsafe fn init_heap(start: u32, size: u32) {
    write_heap_ptr((start + 7) & !7); // align to 8
    write_heap_end(start + size);
}

/// Allocate memory from the heap.
#[no_mangle]
pub unsafe extern "C" fn malloc(size: u32) -> u32 {
    let aligned_size = (size + 7) & !7;
    let ptr = read_heap_ptr();
    let end = read_heap_end();
    if ptr + aligned_size > end {
        return 0; // OOM
    }
    write_heap_ptr(ptr + aligned_size);
    ptr
}

/// Free memory (no-op in bump allocator; original uses dlmalloc).
#[no_mangle]
pub unsafe extern "C" fn free(_ptr: u32) {
    // Bump allocator doesn't free
}

// ============================================================
// Machine access
// ============================================================

pub unsafe fn set_machine(m: *mut Machine) {
    write_machine(m);
}

pub unsafe fn get_machine() -> *mut Machine {
    read_machine()
}
