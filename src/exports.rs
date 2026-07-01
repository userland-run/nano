// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

use crate::alloc;
use crate::cpu;
use crate::elf;
use crate::host;
use crate::mem;
use crate::types::*;

// ---------- VM lifecycle ----------

/// Create a new VM instance. Takes RAM size as parameter.
/// Allocates both the VM struct and the RAM region.
#[no_mangle]
pub extern "C" fn vm_create(ram_size: i32) -> i32 {
    let struct_size = core::mem::size_of::<Vm>() as u32;

    // Allocate RAM
    let ram_ptr = alloc::malloc(ram_size as u32);
    if ram_ptr == 0 {
        return 0;
    }

    // Zero the RAM
    unsafe {
        core::ptr::write_bytes(ram_ptr as *mut u8, 0, ram_size as usize);
    }

    // Allocate VM struct (tracked via global offset, not malloc)
    let vm_ptr = alloc::malloc(struct_size);
    if vm_ptr == 0 {
        return 0;
    }

    unsafe {
        let vm = &mut *(vm_ptr as *mut Vm);
        vm.init();
        vm.ram_base = ram_ptr;
        vm.ram_size = ram_size as u32;
        vm.heap_ptr = ram_ptr;
        // Stack at top of guest RAM
        vm.stack_limit = ram_size as u64;

        // Log creation for debug (also prevents debug_log from being DCE'd)
        host::debug_log(vm_ptr as i32);
    }

    vm_ptr as i32
}

#[no_mangle]
pub unsafe extern "C" fn vm_init(vm_ptr: u32, ram_base: u32, ram_size: u32) {
    let vm = &mut *(vm_ptr as *mut Vm);
    vm.ram_base = ram_base;
    vm.ram_size = ram_size;
    vm.heap_ptr = ram_base + ram_size;
    vm.status = STATUS_OK;

    // Initialize the global allocator with memory after RAM
    alloc::init(ram_base + ram_size);
}

/// Execute instructions. Returns remaining budget (0 = budget exhausted, <0 = trap/syscall).
#[no_mangle]
pub unsafe extern "C" fn vm_step(vm_ptr: u32, budget: i32) -> i32 {
    let vm = &mut *(vm_ptr as *mut Vm);
    if vm.status != STATUS_OK && vm.status != STATUS_RUNNING {
        return -1;
    }
    vm.status = STATUS_RUNNING;
    let result = cpu::exec(vm, budget);
    if vm.status == STATUS_RUNNING {
        vm.status = STATUS_OK;
    }
    result
}

/// Step for a thread (takes thread VM ptr)
#[no_mangle]
pub unsafe extern "C" fn vm_thread_step(vm_ptr: u32, budget: i32) -> i32 {
    vm_step(vm_ptr, budget)
}

/// Load an ELF binary from guest memory
#[no_mangle]
pub unsafe extern "C" fn vm_load_elf(vm_ptr: u32, elf_offset: u32, elf_size: u32) -> i32 {
    let vm = &mut *(vm_ptr as *mut Vm);
    let result = elf::load(vm, elf_offset as u64, elf_size);
    if result.entry == 0 {
        return -1;
    }

    // Set up stack
    let stack_top = vm.stack_limit;
    let sp = stack_top - 4096; // Leave some space at top

    // Write argv[0] onto stack area
    let argv0_addr = sp - 64;
    mem::write_bytes(vm.ram_base, argv0_addr, b"busybox\0");

    let argv = [argv0_addr];
    let envp: [u64; 0] = [];

    let final_sp = elf::setup_stack(
        vm,
        sp - 128,
        result.entry,
        1,
        &argv,
        &envp,
        result.phdr_addr,
        result.phentsize,
        result.phnum,
    );

    vm.pc = result.entry;
    vm.x[2] = final_sp; // sp = x2

    0
}

/// Load a raw binary at a given address and set PC
#[no_mangle]
pub unsafe extern "C" fn vm_load_raw(
    vm_ptr: u32,
    data_offset: u32,
    data_size: u32,
    load_addr: u32,
    entry: u32,
) -> i32 {
    let vm = &mut *(vm_ptr as *mut Vm);
    // Copy data into guest memory at load_addr
    let src = data_offset as *const u8;
    let dst = (vm.ram_base + load_addr) as *mut u8;
    core::ptr::copy_nonoverlapping(src, dst, data_size as usize);

    vm.pc = entry as u64;
    vm.x[2] = vm.stack_limit - 4096; // initial stack

    // Set up brk
    let end = (load_addr + data_size) as u64;
    vm.brk_start = (end + PAGE_SIZE - 1) & PAGE_MASK;
    vm.brk_current = vm.brk_start;
    vm.mmap_next_addr = vm.brk_start + 64 * 1024 * 1024;

    0
}

/// Allocate a thread VM struct (for clone/pthread_create)
#[no_mangle]
pub unsafe extern "C" fn vm_alloc_thread(parent_ptr: u32) -> u32 {
    let size = core::mem::size_of::<Vm>() as u32;
    let child_ptr = alloc::malloc(size);
    if child_ptr == 0 {
        return 0;
    }

    // Copy parent state
    let src = parent_ptr as *const u8;
    let dst = child_ptr as *mut u8;
    core::ptr::copy_nonoverlapping(src, dst, size as usize);

    let child = &mut *(child_ptr as *mut Vm);
    child.parent_vm = parent_ptr;
    child.tid += 1;
    child.status = STATUS_OK;

    child_ptr
}

/// Return from fork in child
#[no_mangle]
pub unsafe extern "C" fn vm_fork_return(vm_ptr: u32, child_sp: u64, child_tls: u64) {
    let vm = &mut *(vm_ptr as *mut Vm);
    vm.x[2] = child_sp;  // sp
    vm.x[4] = child_tls;  // tp (thread pointer)
    vm.x[10] = 0;         // a0 = 0 (child return value)
    vm.tls_base = child_tls;
}

// ---------- FS protocol pointers ----------

#[no_mangle]
pub unsafe extern "C" fn vm_fs_request_ptr(vm_ptr: u32) -> u32 {
    let vm = &*(vm_ptr as *const Vm);
    &vm.fs_request as *const _ as u32
}

#[no_mangle]
pub unsafe extern "C" fn vm_fs_response_ptr(vm_ptr: u32) -> u32 {
    let vm = &*(vm_ptr as *const Vm);
    &vm.fs_response as *const _ as u32
}

/// Thread FS request is at fixed offset 3972 within the VM struct
#[no_mangle]
pub extern "C" fn vm_thread_fs_request_ptr(vm_ptr: u32) -> u32 {
    vm_ptr + THREAD_FS_OFFSET
}

/// Thread FS response follows thread FS request (296 bytes later)
#[no_mangle]
pub extern "C" fn vm_thread_fs_response_ptr(vm_ptr: u32) -> u32 {
    vm_ptr + THREAD_FS_OFFSET + core::mem::size_of::<FsRequest>() as u32
}

// ---------- Memory info ----------

#[no_mangle]
pub unsafe extern "C" fn vm_ram_ptr(vm_ptr: u32) -> u32 {
    let vm = &*(vm_ptr as *const Vm);
    vm.ram_base
}

#[no_mangle]
pub unsafe extern "C" fn vm_ram_size(vm_ptr: u32) -> u32 {
    let vm = &*(vm_ptr as *const Vm);
    vm.ram_size
}

// ---------- TTY (Console) ----------

/// Enable or disable tty mode for this VM and set the initial window size.
/// When enabled, the std-stream fds report as a terminal (isatty() == true)
/// with cooked-mode termios defaults; when disabled (the default), the tty
/// ioctls return ENOTTY exactly as before. The host (terminal front-end) calls
/// this; batch/node runs leave it off so the V8 init path is unaffected.
#[no_mangle]
pub unsafe extern "C" fn vm_tty_enable(vm_ptr: u32, on: i32, cols: u32, rows: u32) {
    let vm = &mut *(vm_ptr as *mut Vm);
    if on != 0 {
        vm.tty_enabled = 1;
        vm.ws_col = cols as u16;
        vm.ws_row = rows as u16;
        crate::syscall::tty_init_termios(vm);
    } else {
        vm.tty_enabled = 0;
    }
}

/// Update the terminal window size (on resize / font zoom). SIGWINCH delivery
/// is wired in the signal-delivery step.
#[no_mangle]
pub unsafe extern "C" fn vm_tty_set_size(vm_ptr: u32, cols: u32, rows: u32) {
    let vm = &mut *(vm_ptr as *mut Vm);
    vm.ws_col = cols as u16;
    vm.ws_row = rows as u16;
}

// ---------- stdin (in-VM tty ring) ----------

/// Push `len` host input bytes (at linear-memory `ptr`) into the stdin ring,
/// applying the line discipline (cooked echo/erase or raw passthrough).
#[no_mangle]
pub unsafe extern "C" fn vm_stdin_push(vm_ptr: u32, ptr: u32, len: u32) {
    let vm = &mut *(vm_ptr as *mut Vm);
    let bytes = core::slice::from_raw_parts(ptr as *const u8, len as usize);
    crate::tty::stdin_push(vm, bytes);
}

/// Raise a signal on the VM from the host (e.g. SIGWINCH on resize, SIGTERM).
#[no_mangle]
pub unsafe extern "C" fn vm_signal(vm_ptr: u32, signum: u32) {
    crate::syscall::raise_signal(&mut *(vm_ptr as *mut Vm), signum);
}

/// Mark interactive stdin: when true, an empty read parks (blocks) instead of
/// returning EOF. Batch runs leave this false to preserve EOF-on-empty.
#[no_mangle]
pub unsafe extern "C" fn vm_stdin_set_interactive(_vm_ptr: u32, on: i32) {
    crate::tty::set_interactive(on != 0);
}

/// Signal end-of-input on stdin (e.g. host closed the input / Ctrl-D).
#[no_mangle]
pub unsafe extern "C" fn vm_stdin_eof(_vm_ptr: u32) {
    crate::tty::set_eof();
}

/// Re-attempt a parked stdin read/ppoll. Returns 1 if completed (a0 + status
/// set), 0 if it must keep waiting for input.
#[no_mangle]
pub unsafe extern "C" fn vm_io_retry(vm_ptr: u32) -> i32 {
    crate::syscall::io_retry(&mut *(vm_ptr as *mut Vm))
}

#[no_mangle]
pub unsafe extern "C" fn vm_struct_ptr(vm_ptr: u32) -> u32 {
    vm_ptr
}

#[no_mangle]
pub extern "C" fn vm_struct_size() -> i32 {
    core::mem::size_of::<Vm>() as i32
}

#[no_mangle]
pub unsafe extern "C" fn vm_exit_code(vm_ptr: u32) -> i32 {
    let vm = &*(vm_ptr as *const Vm);
    vm.exit_code
}

#[no_mangle]
pub unsafe extern "C" fn vm_shared_efd_ptr(vm_ptr: u32) -> u32 {
    let vm = &*(vm_ptr as *const Vm);
    &vm.shared_efd as *const _ as u32
}

// ---------- Bundled binaries ----------
// RISC-V ELF binaries embedded into WASM data section via include_bytes!.
// Each has a feature gate; when disabled, returns ptr=0 size=0.

// BusyBox (~1MB static RISC-V ELF)
#[cfg(feature = "busybox")]
static BUSYBOX_DATA: &[u8] = include_bytes!("../build/busybox.gz");

#[cfg(not(feature = "busybox"))]
static BUSYBOX_DATA: &[u8] = &[];

#[no_mangle]
pub extern "C" fn vm_bundled_busybox_ptr() -> i32 {
    BUSYBOX_DATA.as_ptr() as i32
}

#[no_mangle]
pub extern "C" fn vm_bundled_busybox_size() -> i32 {
    BUSYBOX_DATA.len() as i32
}

// Node.js (~52MB static RISC-V ELF)
#[cfg(feature = "node")]
static NODE_DATA: &[u8] = include_bytes!("../build/node.gz");

#[cfg(not(feature = "node"))]
static NODE_DATA: &[u8] = &[];

#[no_mangle]
pub extern "C" fn vm_bundled_node_ptr() -> i32 {
    NODE_DATA.as_ptr() as i32
}

#[no_mangle]
pub extern "C" fn vm_bundled_node_size() -> i32 {
    NODE_DATA.len() as i32
}

// Generic ELF (legacy — points to busybox if available, else empty)
#[no_mangle]
pub extern "C" fn vm_bundled_elf_ptr() -> i32 {
    BUSYBOX_DATA.as_ptr() as i32
}

#[no_mangle]
pub extern "C" fn vm_bundled_elf_size() -> i32 {
    BUSYBOX_DATA.len() as i32
}

// ---------- Bundled devenv ----------
// Complete JS dev environment (Node+npm, esbuild, TS, ESLint, Prettier, etc.)
// embedded as a compressed tarball. Only included with `--features devenv`.

#[cfg(feature = "devenv")]
static DEVENV_DATA: &[u8] = include_bytes!("../build/devenv.tar.gz");

#[cfg(not(feature = "devenv"))]
static DEVENV_DATA: &[u8] = &[];

#[no_mangle]
pub extern "C" fn vm_bundled_devenv_ptr() -> i32 {
    DEVENV_DATA.as_ptr() as i32
}

#[no_mangle]
pub extern "C" fn vm_bundled_devenv_size() -> i32 {
    DEVENV_DATA.len() as i32
}

// ---------- Debug ----------
// Names match reference: debug_pc, debug_reg, debug_status, debug_read_guest,
// debug_fault_pc, debug_fault_addr (no "_get_" prefix)

#[no_mangle]
pub unsafe extern "C" fn debug_pc(vm_ptr: u32) -> u64 {
    let vm = &*(vm_ptr as *const Vm);
    vm.pc
}

#[no_mangle]
pub unsafe extern "C" fn debug_reg(vm_ptr: u32, reg: u32) -> u64 {
    let vm = &*(vm_ptr as *const Vm);
    if reg < 32 {
        vm.x[reg as usize]
    } else {
        0
    }
}

#[no_mangle]
pub unsafe extern "C" fn debug_status(vm_ptr: u32) -> i32 {
    let vm = &*(vm_ptr as *const Vm);
    vm.status
}

#[no_mangle]
pub unsafe extern "C" fn debug_read_guest(vm_ptr: u32, addr: u64) -> u32 {
    let vm = &*(vm_ptr as *const Vm);
    mem::read_u32(vm.ram_base, addr)
}

#[no_mangle]
pub unsafe extern "C" fn debug_fault_pc(vm_ptr: u32) -> u64 {
    let vm = &*(vm_ptr as *const Vm);
    vm.fault_pc
}

#[no_mangle]
pub unsafe extern "C" fn debug_fault_addr(vm_ptr: u32) -> u64 {
    let vm = &*(vm_ptr as *const Vm);
    vm.fault_addr
}

// ---------- C1: block-cache instrumentation ----------
// Counters are global (not per-VM) and reset on block-cache reset.

#[no_mangle]
pub extern "C" fn debug_block_hits() -> u64 {
    cpu::stat_block_hits()
}

#[no_mangle]
pub extern "C" fn debug_block_builds() -> u64 {
    cpu::stat_block_builds()
}

#[no_mangle]
pub extern "C" fn debug_block_insns() -> u64 {
    cpu::stat_block_insns()
}

#[no_mangle]
pub extern "C" fn debug_baseline_insns() -> u64 {
    cpu::stat_baseline_insns()
}

#[no_mangle]
pub extern "C" fn debug_jalr_execs() -> u64 {
    cpu::stat_jalr_execs()
}

#[no_mangle]
pub extern "C" fn debug_jalfwd_execs() -> u64 {
    cpu::stat_jalfwd_execs()
}

#[no_mangle]
pub extern "C" fn debug_brfwd_execs() -> u64 {
    cpu::stat_brfwd_execs()
}

// ---------- Virtual Server ----------
// JS host injects HTTP connections into the VM's socket layer.

/// Inject an HTTP connection to a listening server on `port`.
/// `req_ptr`/`req_len` point to raw HTTP request bytes in WASM linear memory.
/// Returns connection ID (>= 0) for polling the response, or < 0 on error.
#[no_mangle]
pub unsafe extern "C" fn vm_inject_connection(
    vm_ptr: u32,
    port: u32,
    req_ptr: u32,
    req_len: u32,
) -> i32 {
    let vm = &mut *(vm_ptr as *mut Vm);
    crate::syscall::inject_connection(vm, port as u16, req_ptr, req_len)
}

/// Read response bytes from a virtual connection into `dst_ptr`.
/// Returns: >0 bytes copied, 0 = still waiting, -1 = response complete.
#[no_mangle]
pub unsafe extern "C" fn vm_read_response(
    _vm_ptr: u32,
    conn_id: i32,
    dst_ptr: u32,
    dst_len: u32,
) -> i32 {
    crate::syscall::read_response(conn_id, dst_ptr, dst_len)
}

/// Close a virtual connection (both sides).
#[no_mangle]
pub unsafe extern "C" fn vm_close_connection(_vm_ptr: u32, conn_id: i32) {
    crate::syscall::close_connection(conn_id);
}

// ---------- Console ----------

/// Clear the block cache (call on ELF load or self-modifying code)
#[no_mangle]
pub extern "C" fn vm_reset_blocks() {
    cpu::reset_blocks();
}

/// Reset all cached state for snapshot restore (block cache + syscall statics)
#[no_mangle]
pub unsafe extern "C" fn vm_snapshot_restore_reset() {
    cpu::reset_blocks();
    crate::syscall::reset_statics();
}

/// No-op: matches reference where console_queue_char aliases free()
#[no_mangle]
pub extern "C" fn console_queue_char(_ch: i32) {
    // Intentionally empty - reference binary aliases this to free (no-op)
}

// ---------- Signal handler preservation across a serialized fork ----------

/// Copy the process-global signal handler/flag tables into a scratch buffer and
/// return its address; the host reads it into the parent's fork snapshot so a
/// child's execve() reset can't wipe the parent shell's SIGINT handler.
#[no_mangle]
pub unsafe extern "C" fn vm_signals_dump() -> u32 {
    crate::syscall::signals_dump()
}

/// Restore the signal handler/flag tables from the scratch buffer (host wrote the
/// parent's saved tables back before this call). Paired with vm_signals_dump().
#[no_mangle]
pub unsafe extern "C" fn vm_signals_load() {
    crate::syscall::signals_load();
}
