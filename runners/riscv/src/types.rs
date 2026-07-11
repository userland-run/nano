// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

use core::sync::atomic::AtomicI32;

// VM status codes
pub const STATUS_OK: i32 = 0;
pub const STATUS_FAULT: i32 = 3;
pub const STATUS_FS_PENDING: i32 = 6;
pub const STATUS_EPOLL_BLOCKED: i32 = 7;
pub const STATUS_RUNNING: i32 = 18;

// FD types
pub const FD_TYPE_NONE: i32 = 0;
pub const FD_TYPE_STDIN: i32 = 1;
pub const FD_TYPE_STDOUT: i32 = 2;
pub const FD_TYPE_STDERR: i32 = 3;
pub const FD_TYPE_FILE: i32 = 4;
pub const FD_TYPE_DIR: i32 = 5;
pub const FD_TYPE_PIPE: i32 = 6;
pub const FD_TYPE_EPOLL: i32 = 7;
pub const FD_TYPE_EVENTFD: i32 = 8;
pub const FD_TYPE_DEVNULL: i32 = 9;
pub const FD_TYPE_SOCKET: i32 = 10;
pub const FD_TYPE_TIMERFD: i32 = 11;

// Page size
pub const PAGE_SIZE: u64 = 4096;
pub const PAGE_MASK: u64 = !(PAGE_SIZE - 1);

// Max file descriptors
pub const MAX_FDS: usize = 64;

// Max mmap regions
pub const MAX_MMAP_REGIONS: usize = 16;

// Thread FS request offset within VM struct
pub const THREAD_FS_OFFSET: u32 = 3972;

/// File descriptor entry (24 bytes)
#[repr(C)]
#[derive(Copy, Clone)]
pub struct FdEntry {
    pub fd_type: i32,     // 0
    pub host_fd: i32,     // 4
    pub offset: i64,      // 8
    pub flags: i32,       // 16
    pub _pad: i32,        // 20
}

/// Memory mapping entry (32 bytes)
#[repr(C)]
#[derive(Copy, Clone)]
pub struct MmapEntry {
    pub guest_addr: u64,  // 0
    pub length: u64,      // 8
    pub prot: i32,        // 16
    pub flags: i32,       // 20
    pub offset: u64,      // 24
}

/// FS request block (552 bytes)
#[repr(C)]
pub struct FsRequest {
    pub syscall_nr: i32,      // 0
    pub fd: i32,              // 4
    pub arg1: i64,            // 8
    pub arg2: i64,            // 16
    pub arg3: i64,            // 24
    pub buf_ptr: u32,         // 32
    pub buf_len: u32,         // 36
    pub path: [u8; 256],      // 40..296
    pub path2: [u8; 256],     // 296..552
}

/// FS response block (24 bytes)
#[repr(C)]
pub struct FsResponse {
    pub result: i64,          // 0
    pub error: i32,           // 8
    pub _pad: i32,            // 12
    pub data_len: u32,        // 16
    pub _pad2: u32,           // 20
}

/// Main VM struct - 12680 bytes total
/// Offsets match reference nano.wasm binary for JS host compatibility.
///
/// Layout:
///   0..560     CPU state (x, pc, f, fcsr, status, fault info)
///   560..600   brk/stack (brk_start, brk_current, stack_limit)
///   600..2136  fd_table[64] (64 * 24 bytes)
///   2136..2144 fd_count + padding
///   2144..2216 fd_configs (std stream metadata, 3 * 24 bytes)
///   2216..3680 process state (fs_request, fs_response, mmap, signals, tls, misc)
///   3680..3936 cwd[256]
///   3936..3972 run state (tid, run_status, ram_base, ram_size, heap_ptr)
///   3972..12680 thread area (thread FS requests + thread CPU slots)
#[repr(C)]
pub struct Vm {
    // === CPU state (offset 0, 560 bytes) ===
    pub x: [u64; 32],            // 0..256: integer registers (x0 hardwired to 0)
    pub pc: u64,                 // 256..264: program counter
    pub f: [u64; 32],           // 264..520: FP registers (as f64 bits)
    pub fcsr: u32,               // 520..524: FP control/status register
    pub _fp_pad: u32,            // 524..528
    pub status: i32,             // 528..532: VM status code
    pub exit_code: i32,          // 532..536: process exit code
    pub insn_budget: i32,        // 536..540: instructions remaining
    pub _budget_pad: i32,        // 540..544
    pub fault_pc: u64,           // 544..552
    pub fault_addr: u64,         // 552..560

    // === brk/memory (offset 560, 40 bytes) ===
    pub brk_start: u64,          // 560..568 (init: u64::MAX sentinel)
    pub brk_current: u64,        // 568..576 (init: 0)
    pub _reserved576: u64,       // 576..584
    pub _reserved584: u64,       // 584..592
    pub stack_limit: u64,        // 592..600

    // === FD table (offset 600, 1536 bytes) ===
    pub fd_table: [FdEntry; MAX_FDS], // 600..2136 (64 * 24 = 1536)

    // === FD metadata (offset 2136, 8 bytes) ===
    pub fd_count: i32,           // 2136..2140
    pub _fd_pad: i32,            // 2140..2144

    // === Std FD configs (offset 2144, 72 bytes) ===
    pub fd_configs: [FdEntry; 3], // 2144..2216 (stdin/stdout/stderr metadata)

    // === FS request/response (offset 2216) ===
    pub fs_request: FsRequest,   // 2216..2768 (552 bytes)
    pub fs_response: FsResponse, // 2768..2792 (24 bytes)

    // === mmap table (offset 2792) ===
    pub mmap_entries: [MmapEntry; MAX_MMAP_REGIONS], // 2792..3304 (16 * 32 = 512)
    pub mmap_count: i32,         // 3304..3308
    pub _mmap_pad: i32,          // 3308..3312
    pub mmap_next_addr: u64,     // 3312..3320

    // === Signal state (offset 3320) ===
    pub sig_mask: u64,           // 3320..3328
    pub sig_pending: u64,        // 3328..3336
    pub sigaltstack_sp: u64,     // 3336..3344
    pub sigaltstack_size: u64,   // 3344..3352
    pub sigaltstack_flags: i32,  // 3352..3356
    pub _sig_pad: i32,           // 3356..3360

    // === TLS (offset 3360) ===
    pub tls_base: u64,           // 3360..3368
    pub clear_child_tid: u64,    // 3368..3376

    // === Thread/pipe/eventfd state (offset 3376) ===
    pub parent_vm: u32,          // 3376..3380
    pub thread_count: i32,       // 3380..3384
    pub pipe_read_fd: i32,       // 3384..3388
    pub pipe_write_fd: i32,      // 3388..3392
    pub eventfd_val: u32,        // 3392..3396
    pub shared_efd: AtomicI32,   // 3396..3400

    // === Debug: last 4 PCs ring buffer (offset 3400..3432 = 32 bytes) ===
    pub pc_trace: [u64; 4],      // 3400..3432
    pub pc_trace_idx: u32,       // 3432..3436
    pub _pc_trace_pad: u32,      // 3436..3440

    // === Per-thread state (offset 3440..3632 = 192 bytes) ===
    pub thread_tids: [i32; 16],   // 3440..3504 - TID per thread slot
    pub thread_ctids: [u64; 16],  // 3504..3632 - clear_child_tid per thread slot

    // === TTY / termios state (offset 3632..3680 = 48 bytes, carved from the
    // pre-CWD pad; opt-in — tty_enabled stays 0 for batch/node runs so isatty
    // remains false). Keeps CWD at 3680. ===
    pub tty_enabled: u8,         // 3632: 0 = not a tty (ioctls return ENOTTY)
    pub _tty_pad0: u8,           // 3633
    pub ws_row: u16,             // 3634: window size — rows
    pub ws_col: u16,             // 3636: window size — cols
    pub _tty_pad1: u16,          // 3638 (align termios flags to 3640)
    pub c_iflag: u32,            // 3640: termios input flags
    pub c_oflag: u32,            // 3644: termios output flags
    pub c_cflag: u32,            // 3648: termios control flags
    pub c_lflag: u32,            // 3652: termios local flags (ICANON/ECHO/ISIG)
    pub c_cc: [u8; 19],          // 3656..3675: control chars (VINTR, VMIN, …)
    pub c_line: u8,              // 3675: line discipline
    pub _pre_cwd_pad: [u8; 4],   // 3676..3680

    // === Current working directory (offset 3680, 256 bytes) ===
    pub cwd: [u8; 256],          // 3680..3936

    // === Run state (offset 3936) ===
    pub tid: i32,                // 3936..3940 (init: 1)
    pub _tid_extra: i32,         // 3940..3944 (init: 1)
    pub _reserved3944: u64,      // 3944..3952 (init: 0)
    pub run_status: i32,         // 3952..3956 (init: STATUS_RUNNING = 18)
    pub _run_pad: i32,           // 3956..3960

    // === RAM pointers (offset 3960, 12 bytes) ===
    pub ram_base: u32,           // 3960..3964
    pub ram_size: u32,           // 3964..3968
    pub heap_ptr: u32,           // 3968..3972

    // === Thread area (offset 3972, 8704 bytes) ===
    /// Contains per-thread CPU state slots (544 bytes each × 16 slots).
    /// Thread FS request starts at offset 3972 (THREAD_FS_OFFSET).
    /// Initialized to zero by vm_create.
    pub thread_area: [u8; 8708], // 3972..12680 (16 slots × 544 + 4 padding)
}

// Compile-time size verification
const _: () = assert!(core::mem::size_of::<Vm>() == 12680);

#[cfg(test)]
mod tests {
    // The Vm layout is a contract with the JS host (hardcoded offsets). These
    // tests lock the offsets the host boundary depends on so a struct change can
    // never silently drift. test/feature-map.json maps `types::tests::` to
    // the registry feature emulator.types.layout.
    use super::*;
    use core::mem::{offset_of, size_of};

    #[test]
    fn vm_size_is_locked() {
        assert_eq!(size_of::<Vm>(), 12680);
    }

    #[test]
    fn host_shared_offsets_are_stable() {
        assert_eq!(offset_of!(Vm, x), 0);
        assert_eq!(offset_of!(Vm, pc), 256);
        assert_eq!(offset_of!(Vm, status), 528);
        assert_eq!(offset_of!(Vm, fs_request), 2216);
        assert_eq!(offset_of!(Vm, cwd), 3680);
        assert_eq!(offset_of!(Vm, ram_base), 3960);
    }

    #[test]
    fn a0_and_sp_register_offsets() {
        // a0 = x[10] @ +80, sp = x[2] @ +16 (used by the host to read/write regs)
        assert_eq!(offset_of!(Vm, x) + 10 * 8, 80);
        assert_eq!(offset_of!(Vm, x) + 2 * 8, 16);
    }

    #[test]
    fn fsrequest_path_buffers_are_256() {
        // FsRequest.path @ +40 (256), path2 @ +296 (256) — node_modules paths.
        assert_eq!(offset_of!(FsRequest, path), 40);
        assert_eq!(offset_of!(FsRequest, path2), 296);
    }
}

impl Vm {
    /// Initialize a fresh VM
    pub unsafe fn init(&mut self) {
        // Zero everything
        let ptr = self as *mut Vm as *mut u8;
        core::ptr::write_bytes(ptr, 0, core::mem::size_of::<Vm>());

        // brk_start = u64::MAX (sentinel: "not yet initialized")
        self.brk_start = u64::MAX;

        // Stack limit default (1GB)
        self.stack_limit = 1073741824;

        // Set up standard FD table entries
        self.fd_table[0].fd_type = FD_TYPE_STDIN;
        self.fd_table[0].host_fd = 0;
        self.fd_table[1].fd_type = FD_TYPE_STDOUT;
        self.fd_table[1].host_fd = 1;
        self.fd_table[2].fd_type = FD_TYPE_STDERR;
        self.fd_table[2].host_fd = 2;
        self.fd_count = 3;

        // Set up FD config entries (matching reference binary)
        self.fd_configs[0].fd_type = FD_TYPE_STDIN;
        self.fd_configs[1].fd_type = FD_TYPE_STDOUT;
        self.fd_configs[2].fd_type = FD_TYPE_STDERR;

        // CWD = "/"
        self.cwd[0] = b'/';

        // Thread state
        self.tid = 1;
        self._tid_extra = 0;  // active thread slot = 0 (main)
        self.thread_count = 1; // 1 thread (main)
        self.thread_tids[0] = 1; // main thread TID = 1
        self.run_status = STATUS_RUNNING;
    }
}
