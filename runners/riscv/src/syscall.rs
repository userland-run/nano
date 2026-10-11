// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

use crate::host;
use crate::mem;
use crate::types::*;

// Linux RISC-V syscall numbers
const SYS_GETCWD: u64 = 17;
const SYS_EVENTFD2: u64 = 19;
const SYS_EPOLL_CREATE1: u64 = 20;
const SYS_EPOLL_CTL: u64 = 21;
const SYS_EPOLL_PWAIT: u64 = 22;
const SYS_DUP: u64 = 23;
const SYS_DUP3: u64 = 24;
const SYS_FCNTL: u64 = 25;
const SYS_IOCTL: u64 = 29;
const SYS_MKDIRAT: u64 = 34;
const SYS_UNLINKAT: u64 = 35;
const SYS_FACCESSAT: u64 = 48;
const SYS_CHDIR: u64 = 49;
const SYS_OPENAT: u64 = 56;
const SYS_CLOSE: u64 = 57;
const SYS_PIPE2: u64 = 59;
const SYS_GETDENTS64: u64 = 61;
const SYS_LSEEK: u64 = 62;
const SYS_READ: u64 = 63;
const SYS_WRITE: u64 = 64;
const SYS_READV: u64 = 65;
const SYS_WRITEV: u64 = 66;
const SYS_PREAD64: u64 = 67;
const SYS_PWRITE64: u64 = 68;
const SYS_PREADV: u64 = 69;
const SYS_PWRITEV: u64 = 70;
const SYS_SYNC: u64 = 81;      // whole-system sync — no-op (memfs is in RAM)
const SYS_FSYNC: u64 = 82;     // flush a file — no-op (memfs is in RAM)
const SYS_FDATASYNC: u64 = 83; // flush file data — no-op (memfs is in RAM)
const SYS_SYNCFS: u64 = 267;   // sync a filesystem — no-op (memfs is in RAM)
const SYS_RISCV_FLUSH_ICACHE: u64 = 259; // RISC-V: flush icache (no-op on the interpreter)
const SYS_IO_URING_SETUP: u64 = 425;     // io_uring: intentionally unavailable (callers fall back)
const SYS_READLINKAT: u64 = 78;
const SYS_NEWFSTATAT: u64 = 79;
const SYS_FSTAT: u64 = 80;
const SYS_EXIT: u64 = 93;
const SYS_EXIT_GROUP: u64 = 94;
const SYS_SET_TID_ADDRESS: u64 = 96;
const SYS_FUTEX: u64 = 98;
const SYS_SET_ROBUST_LIST: u64 = 99;
const SYS_NANOSLEEP: u64 = 101;
const SYS_CLOCK_GETTIME: u64 = 113;
const SYS_SYSLOG: u64 = 116;
const SYS_SCHED_GETAFFINITY: u64 = 123;
const SYS_SCHED_YIELD: u64 = 124;
const SYS_KILL: u64 = 129;
const SYS_TKILL: u64 = 130;
const SYS_TGKILL: u64 = 131;
const SYS_SIGALTSTACK: u64 = 132;
const SYS_RT_SIGACTION: u64 = 134;
const SYS_RT_SIGPROCMASK: u64 = 135;
const SYS_RT_SIGRETURN: u64 = 139;
const SYS_TIMES: u64 = 153;
const SYS_UNAME: u64 = 160;
const SYS_UMASK: u64 = 166;
const SYS_GETPID: u64 = 172;
const SYS_GETPPID: u64 = 173;
const SYS_GETUID: u64 = 174;
const SYS_GETEUID: u64 = 175;
const SYS_GETGID: u64 = 176;
const SYS_GETEGID: u64 = 177;
const SYS_GETTID: u64 = 178;
const SYS_SYSINFO: u64 = 179;
const SYS_BRK: u64 = 214;
const SYS_MUNMAP: u64 = 215;
const SYS_MREMAP: u64 = 216;
const SYS_CLONE: u64 = 220;
const SYS_EXECVE: u64 = 221;
const SYS_WAIT4: u64 = 260;
const SYS_MMAP: u64 = 222;
const SYS_MPROTECT: u64 = 226;
const SYS_PRLIMIT64: u64 = 261;
const SYS_GETRANDOM: u64 = 278;
const SYS_MADVISE: u64 = 233;
const SYS_UTIMENSAT: u64 = 88;
const SYS_CAPGET: u64 = 90;
const SYS_PPOLL: u64 = 73;
const SYS_RENAMEAT2: u64 = 276;
const SYS_STATX: u64 = 291;
const SYS_TIMERFD_CREATE: u64 = 85;
const SYS_TIMERFD_SETTIME: u64 = 86;
const SYS_RSEQ: u64 = 293;
const SYS_CLOCK_GETRES: u64 = 114;
const SYS_PRCTL: u64 = 167;

// Socket syscalls
const SYS_SOCKET: u64 = 198;
const SYS_SOCKETPAIR: u64 = 199;
const SYS_BIND: u64 = 200;
const SYS_LISTEN: u64 = 201;
const SYS_ACCEPT: u64 = 202;
const SYS_CONNECT: u64 = 203;
const SYS_GETSOCKNAME: u64 = 204;
const SYS_GETPEERNAME: u64 = 205;
const SYS_SENDTO: u64 = 206;
const SYS_RECVFROM: u64 = 207;
const SYS_SETSOCKOPT: u64 = 208;
const SYS_GETSOCKOPT: u64 = 209;
const SYS_SHUTDOWN: u64 = 210;
const SYS_ACCEPT4: u64 = 242;

// Error codes
const ENOSYS: i64 = -38;
const ENOMEM: i64 = -12;
const EINTR: i64 = -4;
const EBADF: i64 = -9;
const EINVAL: i64 = -22;
const ENOENT: i64 = -2;
const EPERM: i64 = -1;
const EAGAIN: i64 = -11;
const ENOTCONN: i64 = -107;
const ECONNREFUSED: i64 = -111;
const EINPROGRESS: i64 = -115;
const EAFNOSUPPORT: i64 = -97;
const EFAULT: i64 = -14;
const ENODEV: i64 = -19;
const EEXIST: i64 = -17;
const ENOSPC: i64 = -28;
const EMFILE: i64 = -24;

// open/fcntl flag bits (RISC-V Linux generic values)
const O_NONBLOCK: i32 = 0x800;
const O_CLOEXEC: i32 = 0x80000;
/// Status flags F_SETFL may change (O_APPEND|O_NONBLOCK|O_ASYNC|O_DIRECT|O_NOATIME);
/// the access mode and creation flags are fixed at open time.
const SETFL_MASK: i32 = 0x400 | 0x800 | 0x2000 | 0x4000 | 0x40000;

// ============================================================
// In-memory loopback socket layer
// ============================================================

const MAX_SOCKETS: usize = 32;
const SOCK_BUF_SIZE: usize = 16384; // 16KB per socket recv buffer

const SOCK_FREE: u8 = 0;
const SOCK_CREATED: u8 = 1;
const SOCK_BOUND: u8 = 2;
const SOCK_LISTENING: u8 = 3;
const SOCK_CONNECTED: u8 = 4;
const SOCK_SHUTDOWN: u8 = 5;

const ACCEPT_QUEUE_SIZE: usize = 8;

#[derive(Copy, Clone)]
struct SocketSlot {
    state: u8,
    nonblock: u8,
    _pad: [u8; 2],
    local_port: u16,
    _pad2: u16,
    peer_idx: i32,    // connected peer socket index (-1 if none)
    guest_fd: i32,    // which guest FD this socket is on (-1 if not yet assigned)
    // Accept queue (for listening sockets)
    accept_queue: [i32; ACCEPT_QUEUE_SIZE],
    accept_head: u32,
    accept_tail: u32,
    // Receive ring buffer
    recv_head: u32,
    recv_tail: u32,
    recv_buf: [u8; SOCK_BUF_SIZE],
}

const EMPTY_SOCKET: SocketSlot = SocketSlot {
    state: 0, nonblock: 0, _pad: [0; 2],
    local_port: 0, _pad2: 0,
    peer_idx: -1, guest_fd: -1,
    accept_queue: [-1; ACCEPT_QUEUE_SIZE],
    accept_head: 0, accept_tail: 0,
    recv_head: 0, recv_tail: 0,
    recv_buf: [0; SOCK_BUF_SIZE],
};

static mut SOCKETS: [SocketSlot; MAX_SOCKETS] = [EMPTY_SOCKET; MAX_SOCKETS];

/// Address + byte size of the SOCKETS table, so the host can persist the
/// in-memory socket state (listening sockets, accept queues, recv rings) across
/// snapshot()/restoreAndRun(). SocketSlot is pure value state (no host handles /
/// pointers), so a raw byte copy round-trips it. reset_statics() zeroes SOCKETS,
/// so the host must write these bytes back AFTER vm_snapshot_restore_reset() —
/// otherwise a warm-restored server (e.g. `opencode serve`) loses the sockets it
/// bound before the snapshot and its event loop watches dead fds.
pub unsafe fn sockets_ptr() -> u32 {
    core::ptr::addr_of!(SOCKETS) as u32
}
pub unsafe fn sockets_bytes() -> u32 {
    (MAX_SOCKETS * core::mem::size_of::<SocketSlot>()) as u32
}

// ============================================================
// Epoll interest list (tracks registered FD watches)
// ============================================================

const MAX_EPOLL_ENTRIES: usize = 64;

#[derive(Copy, Clone)]
struct EpollEntry {
    epfd: i32,
    fd: i32,
    events: u32,
    data: u64,
}

const EMPTY_EPOLL: EpollEntry = EpollEntry { epfd: -1, fd: -1, events: 0, data: 0 };

static mut EPOLL_ENTRIES: [EpollEntry; MAX_EPOLL_ENTRIES] = [EMPTY_EPOLL; MAX_EPOLL_ENTRIES];
static mut EPOLL_COUNT: usize = 0;

const EPOLLIN: u32 = 0x001;
const EPOLLOUT: u32 = 0x004;
const EPOLLERR: u32 = 0x008;
const EPOLLHUP: u32 = 0x010;

// ============================================================
// Per-FD eventfd counters (fixes shared-counter bug)
// ============================================================

const MAX_EVENTFDS: usize = 16;
static mut EVENTFD_COUNTERS: [u32; MAX_EVENTFDS] = [0; MAX_EVENTFDS];
static mut EVENTFD_ALLOC: usize = 0;
/// Bitmask of eventfd slots below EVENTFD_ALLOC released by close() and free
/// for reuse. Deliberately not part of the evloop snapshot dump (its layout is
/// fixed); after a restore every slot below the high-water mark counts as used.
static mut EVENTFD_FREE: u32 = 0;

// Pipe identity counter — monotonic across the VM lifetime (deliberately NOT reset
// by reset_statics, so pipe ids stay unique across execve/fork). The host keys its
// per-pipe buffers by this id and clears them between top-level runs.
static mut PIPE_NEXT_ID: i32 = 1;

// ============================================================
// Timerfd state — stores expiry time in ms (from emscripten_date_now)
// ============================================================

const MAX_TIMERFDS: usize = 16;
/// Absolute expiry time in ms (0.0 = disarmed)
static mut TIMERFD_EXPIRY_MS: [f64; MAX_TIMERFDS] = [0.0; MAX_TIMERFDS];
/// Interval in ms for repeating timers (0.0 = one-shot)
static mut TIMERFD_INTERVAL_MS: [f64; MAX_TIMERFDS] = [0.0; MAX_TIMERFDS];
static mut TIMERFD_ALLOC: usize = 0;
/// Released timerfd slots (see EVENTFD_FREE).
static mut TIMERFD_FREE: u32 = 0;

/// Hint for find_runnable: set when any thread enters EPOLL_WAIT with a
/// finite positive timeout (e.g. libuv timer). Tells find_runnable to wake
/// epoll_wait threads so the event loop can yield to the host for real time
/// to advance.
static mut EPOLL_FINITE_TIMEOUT_ACTIVE: bool = false;

/// The epoll_pwait timeout (ms, -1 = infinite) of the wait that most recently
/// yielded STATUS_EPOLL_BLOCKED. The host reads this via vm_epoll_timeout_ms()
/// to park an idle listening server for exactly that long (waking early on an
/// injected connection) instead of busy re-entering the event loop every
/// macrotask — which pinned the tab at 100% for `opencode serve`.
static mut EPOLL_BLOCKED_TIMEOUT_MS: i32 = 0;

/// Timeout (ms; -1 = infinite) the last STATUS_EPOLL_BLOCKED wait asked for.
pub unsafe fn epoll_blocked_timeout_ms() -> i32 {
    EPOLL_BLOCKED_TIMEOUT_MS
}

// ioctl constants
const TIOCGWINSZ: u64 = 0x5413;
const TIOCSWINSZ: u64 = 0x5414;
const TCGETS: u64 = 0x5401;
const TCSETS: u64 = 0x5402;
const TCSETSW: u64 = 0x5403;
const TCSETSF: u64 = 0x5404;
const FIONREAD: u64 = 0x541B;

// termios c_oflag bits (output post-processing).
const OPOST: u32 = 0x0001;
const ONLCR: u32 = 0x0004;

/// Install sane "cooked mode" termios defaults on a freshly-enabled tty so the
/// guest reads back a believable terminal (ICANON+ECHO+ISIG, ^C/^D/erase, etc.).
pub unsafe fn tty_init_termios(vm: &mut Vm) {
    vm.c_iflag = 0x4500; // ICRNL | IXON | IUTF8
    vm.c_oflag = 0x0005; // OPOST | ONLCR
    vm.c_cflag = 0x00BF; // B38400 | CS8 | CREAD
    vm.c_lflag = 0x8A3B; // ISIG ICANON ECHO ECHOE ECHOK ECHOCTL ECHOKE IEXTEN
    vm.c_line = 0;
    vm.c_cc = [0; 19];
    vm.c_cc[0] = 0x03; // VINTR  = ^C
    vm.c_cc[1] = 0x1C; // VQUIT  = ^\
    vm.c_cc[2] = 0x7F; // VERASE = DEL
    vm.c_cc[3] = 0x15; // VKILL  = ^U
    vm.c_cc[4] = 0x04; // VEOF   = ^D
    vm.c_cc[6] = 0x01; // VMIN   = 1
    vm.c_cc[8] = 0x11; // VSTART = ^Q
    vm.c_cc[9] = 0x13; // VSTOP  = ^S
    vm.c_cc[10] = 0x1A; // VSUSP  = ^Z
    vm.c_cc[12] = 0x12; // VREPRINT = ^R
    vm.c_cc[13] = 0x0F; // VDISCARD = ^O
    vm.c_cc[14] = 0x17; // VWERASE  = ^W
    vm.c_cc[15] = 0x16; // VLNEXT   = ^V
}

// ============================================================
// Signals
// ============================================================
//
// A pragmatic delivery model: rt_sigaction records handlers; pending signals
// (set by ^C/kill/the host) are delivered at the next syscall boundary or when
// a parked stdin op is interrupted. Custom handlers are invoked with a
// simplified frame — the pre-signal context is saved to a static (single level,
// no nesting), a0=signum, and ra points at an injected `li a7,139; ecall`
// trampoline so the handler returns through rt_sigreturn, which restores the
// context. We don't synthesise a full ucontext (handlers that inspect it are
// rare for SIGINT/SIGWINCH).

const NSIG: usize = 64;
const SIGINT: u32 = 2;
const SIG_TRAMPOLINE: u64 = 0x800; // guest addr of the injected rt_sigreturn stub

static mut SIG_HANDLERS: [u64; NSIG] = [0; NSIG]; // 0 = SIG_DFL, 1 = SIG_IGN, else addr
static mut SIG_FLAGS: [u64; NSIG] = [0; NSIG];
static mut SIG_SAVED_X: [u64; 32] = [0; 32];
static mut SIG_SAVED_PC: u64 = 0;
static mut SIG_ACTIVE: bool = false; // currently inside a handler
static mut TRAMPOLINE_READY: bool = false;

pub unsafe fn signals_reset() {
    SIG_HANDLERS = [0; NSIG];
    SIG_FLAGS = [0; NSIG];
    SIG_ACTIVE = false;
    TRAMPOLINE_READY = false;
}

// Serialized-fork signal preservation. SIG_HANDLERS/SIG_FLAGS are process-global
// statics, but a forked child's execve() runs reset_statics()/signals_reset() —
// which would also clobber the PARENT shell's handlers (they share the globals).
// The host saves them on clone() and restores them when the child exits, through
// this scratch buffer, so an interactive shell KEEPS its SIGINT handler across
// running a command → Ctrl-C at the prompt aborts the input line, it doesn't kill
// the shell. (A real OS keeps handlers per-process; only the exec'ing child resets.)
static mut SIG_DUMP: [u64; 2 * NSIG] = [0; 2 * NSIG];

/// Copy the current handler/flag tables into the scratch buffer; return its addr.
pub unsafe fn signals_dump() -> u32 {
    let mut i = 0;
    while i < NSIG {
        SIG_DUMP[i] = SIG_HANDLERS[i];
        SIG_DUMP[NSIG + i] = SIG_FLAGS[i];
        i += 1;
    }
    SIG_DUMP.as_ptr() as u32
}

/// Restore the handler/flag tables from the scratch buffer (written by the host).
pub unsafe fn signals_load() {
    let mut i = 0;
    while i < NSIG {
        SIG_HANDLERS[i] = SIG_DUMP[i];
        SIG_FLAGS[i] = SIG_DUMP[NSIG + i];
        i += 1;
    }
}

/// Mark a signal pending on this VM (from ^C, kill, or the host).
pub unsafe fn raise_signal(vm: &mut Vm, signum: u32) {
    if signum >= 1 && (signum as usize) <= NSIG {
        vm.sig_pending |= 1u64 << (signum - 1);
    }
}

/// Signals whose default disposition is "ignore" (vs terminate).
fn default_ignore(sig: u32) -> bool {
    matches!(sig, 17 | 18 | 23 | 28 | 29) // SIGCHLD SIGCONT SIGURG SIGWINCH SIGIO
}

unsafe fn ensure_trampoline(vm: &Vm) {
    if !TRAMPOLINE_READY {
        // li a7, 139 (rt_sigreturn); ecall
        mem::write_u32(vm.ram_base, SIG_TRAMPOLINE, 0x08B0_0893);
        mem::write_u32(vm.ram_base, SIG_TRAMPOLINE + 4, 0x0000_0073);
        TRAMPOLINE_READY = true;
    }
}

/// Deliver one pending, unblocked signal if any. May redirect vm.pc to a handler
/// (saving the interrupted context) or terminate the VM on a default-fatal
/// signal. No-op while already inside a handler.
pub unsafe fn deliver_signals(vm: &mut Vm) {
    if SIG_ACTIVE {
        // A handler that returns normally clears SIG_ACTIVE via the rt_sigreturn
        // trampoline. But busybox ash's SIGINT handler (onsig) escapes through
        // longjmp and never runs the trampoline — which would leave SIG_ACTIVE
        // stuck true forever, blocking every later signal and (via io_retry's
        // EINTR path) spinning the shell in a prompt-reprint storm. Detect the
        // escape by the stack pointer: the guest SP (x[2]) always sits BELOW the
        // pre-handler SP (SIG_SAVED_X[2]) while the handler frame is live, so once
        // it has unwound to/above that level the frame is gone (longjmped out) and
        // we can safely recover and deliver the next signal.
        if vm.x[2] >= SIG_SAVED_X[2] {
            SIG_ACTIVE = false;
        } else {
            return;
        }
    }
    let deliverable = vm.sig_pending & !vm.sig_mask;
    if deliverable == 0 {
        return;
    }
    let bit = deliverable.trailing_zeros();
    let signum = bit + 1;
    vm.sig_pending &= !(1u64 << bit);

    let h = SIG_HANDLERS[signum as usize];
    if h == 1 {
        return; // SIG_IGN
    }
    if h == 0 {
        // SIG_DFL
        if default_ignore(signum) {
            return;
        }
        vm.exit_code = 128 + signum as i32;
        vm.status = STATUS_FAULT;
        return;
    }
    // Custom handler: invoke with the simplified frame.
    ensure_trampoline(vm);
    SIG_SAVED_X = vm.x;
    SIG_SAVED_PC = vm.pc;
    SIG_ACTIVE = true;
    vm.x[10] = signum as u64; // a0 = signum
    vm.x[1] = SIG_TRAMPOLINE; // ra = restorer trampoline
    vm.pc = h;
}

unsafe fn sys_rt_sigaction(vm: &mut Vm, signum: u32, act: u64, oldact: u64) -> i64 {
    if signum < 1 || signum as usize >= NSIG {
        return EINVAL;
    }
    let idx = signum as usize;
    if oldact != 0 {
        mem::write_u64(vm.ram_base, oldact, SIG_HANDLERS[idx]);
        mem::write_u64(vm.ram_base, oldact + 8, SIG_FLAGS[idx]);
        mem::write_u64(vm.ram_base, oldact + 16, 0);
    }
    if act != 0 {
        // SIGKILL (9) / SIGSTOP (19) cannot be caught.
        if signum != 9 && signum != 19 {
            SIG_HANDLERS[idx] = mem::read_u64(vm.ram_base, act);
            SIG_FLAGS[idx] = mem::read_u64(vm.ram_base, act + 8);
        }
    }
    0
}

unsafe fn sys_rt_sigprocmask(vm: &mut Vm, how: i32, set: u64, oldset: u64) -> i64 {
    if oldset != 0 {
        mem::write_u64(vm.ram_base, oldset, vm.sig_mask);
    }
    if set != 0 {
        let s = mem::read_u64(vm.ram_base, set);
        match how {
            0 => vm.sig_mask |= s,  // SIG_BLOCK
            1 => vm.sig_mask &= !s, // SIG_UNBLOCK
            2 => vm.sig_mask = s,   // SIG_SETMASK
            _ => return EINVAL,
        }
    }
    0
}

/// rt_sigreturn: restore the context saved at signal delivery.
unsafe fn sys_rt_sigreturn(vm: &mut Vm) -> i64 {
    if SIG_ACTIVE {
        vm.x = SIG_SAVED_X;
        vm.pc = SIG_SAVED_PC;
        SIG_ACTIVE = false;
    }
    // handle() will write our return value into a0; return the restored a0 so it
    // is preserved.
    vm.x[10] as i64
}

// Event-loop syscall statics that reset_statics() clears but a warm snapshot
// must preserve (paired with the SOCKETS ptr/size restore): the epoll interest
// list + count, eventfd counters + alloc, timerfd expiries/intervals + alloc,
// and the finite-timeout latch. Serialized into a scratch buffer for the host,
// mirroring signals_dump(). Without these, a warm-restored server's libuv loop
// watches an empty epoll set and never wakes. Layout: EPOLL_ENTRIES |
// EVENTFD_COUNTERS | TIMERFD_EXPIRY | TIMERFD_INTERVAL | 4 u64 counters.
const EVLOOP_DUMP_SIZE: usize = MAX_EPOLL_ENTRIES * core::mem::size_of::<EpollEntry>()
    + MAX_EVENTFDS * 4
    + MAX_TIMERFDS * 8
    + MAX_TIMERFDS * 8
    + 4 * 8;
static mut EVLOOP_DUMP: [u8; EVLOOP_DUMP_SIZE] = [0; EVLOOP_DUMP_SIZE];

pub unsafe fn evloop_size() -> u32 {
    EVLOOP_DUMP_SIZE as u32
}

/// Copy the event-loop statics into the scratch buffer; return its address.
pub unsafe fn evloop_dump() -> u32 {
    let dst = core::ptr::addr_of_mut!(EVLOOP_DUMP) as *mut u8;
    let mut o = 0usize;
    let n_ep = MAX_EPOLL_ENTRIES * core::mem::size_of::<EpollEntry>();
    core::ptr::copy_nonoverlapping(core::ptr::addr_of!(EPOLL_ENTRIES) as *const u8, dst.add(o), n_ep);
    o += n_ep;
    let n_ev = MAX_EVENTFDS * 4;
    core::ptr::copy_nonoverlapping(core::ptr::addr_of!(EVENTFD_COUNTERS) as *const u8, dst.add(o), n_ev);
    o += n_ev;
    let n_tf = MAX_TIMERFDS * 8;
    core::ptr::copy_nonoverlapping(core::ptr::addr_of!(TIMERFD_EXPIRY_MS) as *const u8, dst.add(o), n_tf);
    o += n_tf;
    core::ptr::copy_nonoverlapping(core::ptr::addr_of!(TIMERFD_INTERVAL_MS) as *const u8, dst.add(o), n_tf);
    o += n_tf;
    let c = [EPOLL_COUNT as u64, EVENTFD_ALLOC as u64, TIMERFD_ALLOC as u64, EPOLL_FINITE_TIMEOUT_ACTIVE as u64];
    core::ptr::copy_nonoverlapping(c.as_ptr() as *const u8, dst.add(o), 4 * 8);
    dst as u32
}

/// Restore the event-loop statics from the scratch buffer (host wrote it back).
pub unsafe fn evloop_load() {
    let src = core::ptr::addr_of!(EVLOOP_DUMP) as *const u8;
    let mut o = 0usize;
    let n_ep = MAX_EPOLL_ENTRIES * core::mem::size_of::<EpollEntry>();
    core::ptr::copy_nonoverlapping(src.add(o), core::ptr::addr_of_mut!(EPOLL_ENTRIES) as *mut u8, n_ep);
    o += n_ep;
    let n_ev = MAX_EVENTFDS * 4;
    core::ptr::copy_nonoverlapping(src.add(o), core::ptr::addr_of_mut!(EVENTFD_COUNTERS) as *mut u8, n_ev);
    o += n_ev;
    let n_tf = MAX_TIMERFDS * 8;
    core::ptr::copy_nonoverlapping(src.add(o), core::ptr::addr_of_mut!(TIMERFD_EXPIRY_MS) as *mut u8, n_tf);
    o += n_tf;
    core::ptr::copy_nonoverlapping(src.add(o), core::ptr::addr_of_mut!(TIMERFD_INTERVAL_MS) as *mut u8, n_tf);
    o += n_tf;
    let mut c = [0u64; 4];
    core::ptr::copy_nonoverlapping(src.add(o), c.as_mut_ptr() as *mut u8, 4 * 8);
    EPOLL_COUNT = c[0] as usize;
    EVENTFD_ALLOC = c[1] as usize;
    TIMERFD_ALLOC = c[2] as usize;
    EPOLL_FINITE_TIMEOUT_ACTIVE = c[3] != 0;
    EVENTFD_FREE = 0;
    TIMERFD_FREE = 0;
}

/// Reset all static mut globals to their initial state.
/// Must be called before each new program execution to avoid stale state.
pub unsafe fn reset_statics() {
    SOCKETS = [EMPTY_SOCKET; MAX_SOCKETS];
    EPOLL_ENTRIES = [EMPTY_EPOLL; MAX_EPOLL_ENTRIES];
    EPOLL_COUNT = 0;
    EVENTFD_COUNTERS = [0; MAX_EVENTFDS];
    EVENTFD_ALLOC = 0;
    TIMERFD_EXPIRY_MS = [0.0; MAX_TIMERFDS];
    TIMERFD_INTERVAL_MS = [0.0; MAX_TIMERFDS];
    TIMERFD_ALLOC = 0;
    EVENTFD_FREE = 0;
    TIMERFD_FREE = 0;
    EPOLL_FINITE_TIMEOUT_ACTIVE = false;
    EPOLL_BLOCKED_TIMEOUT_MS = 0;
    MMAP_FREE_COUNT = 0; // free-list isn't part of the snapshot image
    FORK_DEPTH = 0; // a cancelled run can leave suspended fork parents behind
    crate::tty::reset();
    signals_reset();
}

/// Handle a syscall. Called from cpu.rs when ECALL is executed.
/// Reads syscall number from x[17] (a7), args from x[10..16] (a0..a6).
/// Result goes into x[10] (a0).
pub unsafe fn handle(vm: &mut Vm) {
    let nr = vm.x[17];
    let a0 = vm.x[10];
    let a1 = vm.x[11];
    let a2 = vm.x[12];
    let a3 = vm.x[13];
    let a4 = vm.x[14];
    let a5 = vm.x[15];

    // Per-syscall trace event (tag 0x0A, low 16 bits = syscall nr). Gated behind
    // the `trace` feature so the plain (min) build skips the hot-path host call;
    // the conformance pipeline runs a `trace`-built wasm to collect syscall coverage.
    #[cfg(feature = "trace")]
    host::debug_log(0x0A000000 | (nr as i32 & 0xFFFF));
    let result: i64 = match nr {
        SYS_EXIT => {
            let current_slot = vm._tid_extra as usize;
            if current_slot != 0 {
                // Non-main thread exiting: mark slot unused, switch to another
                set_tstate(vm, current_slot, TSTATE_UNUSED);
                // Write 0 to clear_child_tid and futex_wake it (CLONE_CHILD_CLEARTID)
                let ctid_addr = vm.thread_ctids[current_slot];
                if ctid_addr != 0 {
                    mem::write_u32(vm.ram_base, ctid_addr, 0);
                    // Wake any thread waiting on this address (pthread_join)
                    let n = vm.thread_count as usize;
                    let mut i = 0;
                    while i < n && i < MAX_THREADS {
                        if i != current_slot
                            && get_tstate(vm, i) == TSTATE_FUTEX_WAIT
                            && get_futex_addr(vm, i) == ctid_addr
                        {
                            set_tstate(vm, i, TSTATE_RUNNABLE);
                        }
                        i += 1;
                    }
                }
                // Find another runnable thread (prefer main=0)
                let mut target: i32 = -1;
                let n = vm.thread_count as usize;
                // Try slot 0 (main) first
                let s0 = get_tstate(vm, 0);
                if s0 == TSTATE_RUNNABLE || s0 == TSTATE_FUTEX_WAIT || s0 == TSTATE_EPOLL_WAIT {
                    target = 0;
                } else {
                    let mut i = 0;
                    while i < n && i < MAX_THREADS {
                        if i != current_slot {
                            let st = get_tstate(vm, i);
                            if st == TSTATE_RUNNABLE || st == TSTATE_FUTEX_WAIT || st == TSTATE_EPOLL_WAIT {
                                target = i as i32;
                                break;
                            }
                        }
                        i += 1;
                    }
                }
                if target >= 0 {
                    let t = target as usize;
                    log_switch(current_slot, t, 3); // 3=thread_exit
                    let was_futex = get_tstate(vm, t) == TSTATE_FUTEX_WAIT;
                    load_thread(vm, t);
                    if was_futex {
                        vm.x[10] = 0; // return 0 from futex_wait
                    }
                    // Epoll-wait threads keep their saved x[10] (EINTR)
                    set_tstate(vm, t, TSTATE_UNUSED); // running
                    vm._tid_extra = t as i32;
                    return; // continue execution as target thread
                }
                // No other threads — fall through to exit
            }
            vm.exit_code = a0 as i32;
            vm.status = STATUS_FAULT;
            return;
        }
        SYS_EXIT_GROUP => {
            vm.exit_code = a0 as i32;
            vm.status = STATUS_FAULT; // signal exit
            return;
        }

        SYS_BRK => sys_brk(vm, a0),
        SYS_MMAP => sys_mmap(vm, a0, a1, a2, a3, a4 as i32, a5),
        SYS_MUNMAP => sys_munmap(vm, a0, a1),
        SYS_MREMAP => sys_mremap(vm, a0, a1, a2, a3),
        SYS_MPROTECT => 0, // stub: always succeed
        SYS_MADVISE => 0,  // stub

        SYS_WRITE => sys_write(vm, a0 as i32, a1, a2 as u32),
        SYS_WRITEV => sys_writev(vm, a0 as i32, a1, a2 as u32),
        SYS_READ => sys_read(vm, a0 as i32, a1, a2 as u32),
        SYS_READV => sys_readv(vm, a0 as i32, a1, a2 as u32),
        SYS_PREAD64 => sys_pread64(vm, a0 as i32, a1, a2 as u32, a3),
        SYS_PREADV => sys_preadv(vm, a0 as i32, a1, a2 as u32, a3),
        SYS_PWRITE64 => sys_pwrite64(vm, a0 as i32, a1, a2 as u32, a3),
        SYS_PWRITEV => sys_pwritev(vm, a0 as i32, a1, a2 as u32, a3),

        SYS_OPENAT => {
            sys_fs_request(vm, SYS_OPENAT as i32, a0 as i32, a1, a2 as i64, a3 as i64);
            return;
        }
        SYS_CLOSE => sys_close(vm, a0 as i32),
        SYS_LSEEK => {
            sys_fs_request(vm, SYS_LSEEK as i32, a0 as i32, 0, a1 as i64, a2 as i64);
            return;
        }
        SYS_FSTAT => {
            sys_fs_request(vm, SYS_FSTAT as i32, a0 as i32, 0, a1 as i64, 0);
            return;
        }
        SYS_NEWFSTATAT => {
            sys_fs_request(vm, SYS_NEWFSTATAT as i32, a0 as i32, a1, a2 as i64, a3 as i64);
            return;
        }
        SYS_GETDENTS64 => {
            sys_fs_request(vm, SYS_GETDENTS64 as i32, a0 as i32, 0, a1 as i64, a2 as i64);
            return;
        }
        SYS_READLINKAT => {
            sys_fs_request(vm, SYS_READLINKAT as i32, a0 as i32, a1, a2 as i64, a3 as i64);
            return;
        }
        SYS_MKDIRAT => {
            sys_fs_request(vm, SYS_MKDIRAT as i32, a0 as i32, a1, a2 as i64, 0);
            return;
        }
        SYS_UNLINKAT => {
            sys_fs_request(vm, SYS_UNLINKAT as i32, a0 as i32, a1, a2 as i64, 0);
            return;
        }
        SYS_FACCESSAT => {
            sys_fs_request(vm, SYS_FACCESSAT as i32, a0 as i32, a1, a2 as i64, a3 as i64);
            return;
        }
        SYS_UTIMENSAT => {
            sys_fs_request(vm, SYS_UTIMENSAT as i32, a0 as i32, a1, a2 as i64, a3 as i64);
            return;
        }
        SYS_RENAMEAT2 => {
            // Copy first path, then second path into path2
            sys_fs_request_rename(vm, a0 as i32, a1, a2 as i32, a3, a4 as i64);
            return;
        }
        SYS_STATX => {
            sys_fs_request(vm, SYS_STATX as i32, a0 as i32, a1, a2 as i64, a4 as i64);
            return;
        }

        SYS_GETCWD => sys_getcwd(vm, a0, a1 as u32),
        SYS_CHDIR => {
            // The host validates the target (ENOENT/ENOTDIR), canonicalizes it
            // against the current cwd, and stores it into vm.cwd.
            sys_fs_request(vm, SYS_CHDIR as i32, -100, a0, 0, 0);
            return;
        }

        SYS_CLOCK_GETTIME => sys_clock_gettime(vm, a0 as i32, a1),
        SYS_NANOSLEEP => sys_nanosleep(vm, a0),

        SYS_UNAME => sys_uname(vm, a0),
        SYS_GETPID | SYS_GETPPID => 1,
        SYS_GETUID | SYS_GETEUID | SYS_GETGID | SYS_GETEGID => 0,
        SYS_GETTID => {
            let slot = vm._tid_extra as usize;
            vm.thread_tids[slot] as i64
        }
        SYS_SCHED_GETAFFINITY => sys_sched_getaffinity(vm, a1 as u32, a2),
        SYS_SCHED_YIELD => 0,

        SYS_GETRANDOM => sys_getrandom(vm, a0, a1 as u32),

        SYS_RT_SIGACTION => sys_rt_sigaction(vm, a0 as u32, a1, a2),
        SYS_RT_SIGPROCMASK => sys_rt_sigprocmask(vm, a0 as i32, a1, a2),
        SYS_RT_SIGRETURN => sys_rt_sigreturn(vm),
        SYS_SIGALTSTACK => sys_sigaltstack(vm, a0, a1),
        SYS_KILL | SYS_TKILL => {
            // kill(pid, sig) / tkill(tid, sig): deliver to self (single process).
            if a1 != 0 {
                raise_signal(vm, a1 as u32);
            }
            0
        }
        SYS_TGKILL => {
            // tgkill(tgid, tid, sig)
            if a2 != 0 {
                raise_signal(vm, a2 as u32);
            }
            0
        }

        SYS_SET_TID_ADDRESS => {
            let slot = vm._tid_extra as usize;
            vm.thread_ctids[slot] = a0;
            vm.thread_tids[slot] as i64
        }
        SYS_SET_ROBUST_LIST => 0, // stub
        SYS_FUTEX => sys_futex(vm, a0, a1 as i32, a2 as u32, a3, a4),
        SYS_CLONE => sys_clone(vm, a0, a1, a2, a3, a4),
        SYS_EXECVE => {
            sys_execve(vm, a0, a1, a2);
            return;
        }
        SYS_WAIT4 => {
            sys_wait4(vm, a0, a1);
            return;
        }

        SYS_DUP => sys_dup(vm, a0 as i32),
        SYS_DUP3 => sys_dup3(vm, a0 as i32, a1 as i32, a2 as i32),
        SYS_FCNTL => sys_fcntl(vm, a0 as i32, a1 as i32, a2),
        SYS_IOCTL => sys_ioctl(vm, a0 as i32, a1),
        SYS_PIPE2 => sys_pipe2(vm, a0, a1 as i32),
        SYS_PPOLL => sys_ppoll(vm, a0, a1 as u32, a2),

        SYS_EPOLL_CREATE1 => sys_epoll_create1(vm, a0 as i32),
        SYS_EPOLL_CTL => sys_epoll_ctl(vm, a0 as i32, a1 as i32, a2 as i32, a3),
        SYS_EPOLL_PWAIT => sys_epoll_pwait(vm, a0 as i32, a1, a2 as i32, a3 as i32),
        SYS_EVENTFD2 => sys_eventfd2(vm, a0 as u32, a1 as i32),

        SYS_PRLIMIT64 => sys_prlimit64(vm, a0 as i32, a1 as i32, a2, a3),
        SYS_SYSINFO => sys_sysinfo(vm, a0),
        SYS_SYSLOG => 0,      // stub
        SYS_UMASK => 0o022,   // stub: return old mask
        SYS_CAPGET => sys_capget(vm, a0, a1),
        SYS_TIMES => 0,        // stub
        SYS_CLOCK_GETRES => sys_clock_getres(vm, a0 as i32, a1),
        SYS_PRCTL => 0,        // stub: always succeed
        SYS_TIMERFD_CREATE => sys_timerfd_create(vm, a1 as i32),
        SYS_TIMERFD_SETTIME => sys_timerfd_settime(vm, a0 as i32, a1 as i32, a2, a3),
        SYS_RSEQ => ENOSYS,       // not supported

        // Socket syscalls
        SYS_SOCKET => sys_socket(vm, a0 as i32, a1 as i32, a2 as i32),
        SYS_BIND => sys_bind(vm, a0 as i32, a1, a2 as u32),
        SYS_LISTEN => sys_listen(vm, a0 as i32, a1 as i32),
        SYS_ACCEPT | SYS_ACCEPT4 => sys_accept4(vm, a0 as i32, a1, a2, a3 as i32),
        SYS_CONNECT => sys_connect(vm, a0 as i32, a1, a2 as u32),
        SYS_GETSOCKNAME => sys_getsockname(vm, a0 as i32, a1, a2),
        SYS_GETPEERNAME => sys_getpeername(vm, a0 as i32, a1, a2),
        SYS_SETSOCKOPT => 0, // stub: always succeed
        SYS_GETSOCKOPT => sys_getsockopt(vm, a0 as i32, a1 as i32, a2 as i32, a3, a4),
        SYS_SHUTDOWN => sys_shutdown(vm, a0 as i32, a1 as i32),
        SYS_SENDTO => sys_sendto(vm, a0 as i32, a1, a2 as u32, a3 as i32),
        SYS_RECVFROM => sys_recvfrom(vm, a0 as i32, a1, a2 as u32, a3 as i32),
        SYS_SOCKETPAIR => ENOSYS, // not supported

        // Durability syscalls: the memfs lives in RAM, so there is nothing to
        // flush to stable storage — succeed. Without this, fsync/fdatasync fall
        // through to ENOSYS and SQLite's unix VFS reports SQLITE_IOERR_FSYNC
        // ("disk I/O error") on every commit, blocking all file-backed node:sqlite.
        SYS_SYNC | SYS_FSYNC | SYS_FDATASYNC | SYS_SYNCFS => 0,

        // RISC-V icache flush after JIT codegen — the interpreter re-reads guest
        // memory every step, so there is no separate icache to flush. Succeed.
        SYS_RISCV_FLUSH_ICACHE => 0,
        // io_uring probe at startup (node, V8). Intentionally unavailable so the
        // caller falls back to the thread-pool / epoll path. Acknowledged, ENOSYS.
        SYS_IO_URING_SETUP => ENOSYS,

        _ => {
            // Unknown syscall - return ENOSYS
            ENOSYS
        }
    };

    vm.x[10] = result as u64;
}

// --- Direct syscall implementations ---

// Per-region high-water marks for the brk and mmap bump allocators.
//
// WASM linear memory is zero-initialized by the engine, and these bump
// allocators never reuse address space within a run (munmap is a no-op), so
// any region at/above its allocator's high-water mark is virgin memory that is
// already zero — re-`memset`ing it is pure waste. Only space below the mark
// (reused after a _resetVM that rewinds the allocators) can hold stale bytes
// and must be zeroed. The marks persist across resets (the memory image does
// too), so reused space is correctly re-zeroed.
//
// NOTE: module-global like the block-cache stats — assumes one VM executes at
// a time (the cooperative model). Promote to Vm fields for multi-VM isolation.
static mut BRK_HWM: u64 = 0;
static mut MMAP_HWM: u64 = 0;

unsafe fn sys_brk(vm: &mut Vm, addr: u64) -> i64 {
    // brk_start == u64::MAX means uninitialized
    if vm.brk_start == u64::MAX {
        return 0;
    }
    if addr == 0 {
        return vm.brk_current as i64;
    }
    if addr < vm.brk_start {
        return vm.brk_current as i64;
    }
    // Align up to page
    let new_brk = (addr + PAGE_SIZE - 1) & PAGE_MASK;
    let old_brk = vm.brk_current;

    // Zero new memory if expanding — but only the part below the brk
    // high-water mark; memory above it is virgin (engine-zero) already.
    if new_brk > old_brk {
        if old_brk < BRK_HWM {
            let zero_end = core::cmp::min(new_brk, BRK_HWM);
            mem::zero_mem(vm.ram_base, old_brk, (zero_end - old_brk) as usize);
        }
        if new_brk > BRK_HWM {
            BRK_HWM = new_brk;
        }
    }

    vm.brk_current = new_brk;
    new_brk as i64
}

unsafe fn sys_mmap(
    vm: &mut Vm,
    addr: u64,
    length: u64,
    prot: u64,
    flags: u64,
    fd: i32,
    offset: u64,
) -> i64 {
    let _ = prot;
    if length == 0 || offset & (PAGE_SIZE - 1) != 0 {
        return EINVAL;
    }
    let len = (length + PAGE_SIZE - 1) & PAGE_MASK;

    // MAP_ANONYMOUS (0x20)
    let is_anon = flags & 0x20 != 0;
    // MAP_FIXED (0x10)
    let is_fixed = flags & 0x10 != 0;

    // File-backed mapping: only regular files can be mapped. Validate before
    // reserving address space so a failure can't leak a region.
    if !is_anon {
        if fd < 0 || fd >= MAX_FDS as i32 {
            return EBADF;
        }
        let fe = vm.fd_table[fd as usize];
        if fe.fd_type != FD_TYPE_FILE || fe.host_fd < 0 {
            return if fe.fd_type == FD_TYPE_NONE { EBADF } else { ENODEV };
        }
    }

    let ram_limit = vm.ram_size as u64;

    // True when this address came from the munmap free list (below the frontier,
    // holding stale bytes) → must be fully zeroed.
    let mut reused = false;
    let guest_addr = if is_fixed && addr != 0 {
        // MAP_FIXED: must use the exact address
        addr
    } else {
        // Anonymous requests first try to reuse a previously-freed region so a
        // long-running guest stays bounded to its working set; otherwise bump.
        if is_anon {
            if let Some(a) = take_free_region(len) {
                reused = true;
                a
            } else {
                let next = vm.mmap_next_addr;
                let end = next + len;
                if end > ram_limit {
                    host::debug_log(0x1E000000 | ((next >> 10) as i32 & 0xFFFFFF));
                    host::debug_log(0x1F000000 | ((len >> 10) as i32 & 0xFFFFFF));
                    return ENOMEM;
                }
                vm.mmap_next_addr = end;
                next
            }
        } else {
            // Bump allocator — check bounds BEFORE advancing pointer
            let next = vm.mmap_next_addr;
            let end = next + len;
            if end > ram_limit {
                // Log: next_addr in KB (fits in 24 bits up to 16GB)
                host::debug_log(0x1E000000 | ((next >> 10) as i32 & 0xFFFFFF));
                // Log: len in KB
                host::debug_log(0x1F000000 | ((len >> 10) as i32 & 0xFFFFFF));
                return ENOMEM;
            }
            vm.mmap_next_addr = end;
            next
        }
    };

    // Check bounds for MAP_FIXED
    let end = match guest_addr.checked_add(len) {
        Some(e) => e,
        None => return ENOMEM,
    };
    if end > ram_limit {
        return ENOMEM;
    }

    if is_fixed && addr != 0 {
        // A fixed mapping now owns [addr, end): it must never be handed out
        // again by the free list, and if it overlaps the bump frontier the
        // frontier moves past it so the next bump allocation can't alias it.
        free_list_remove(guest_addr, len);
        if guest_addr < vm.mmap_next_addr && end > vm.mmap_next_addr {
            vm.mmap_next_addr = end;
        }
    }

    // Zero the region (anonymous memory must read as zero; a file mapping's
    // tail past EOF must too). Mappings taken from the bump frontier at/above
    // the high-water mark are virgin (engine-zero) memory — skip the redundant
    // memset. MAP_FIXED and free-list reuse can land on dirty memory, so zero
    // those unconditionally.
    if reused {
        mem::zero_mem(vm.ram_base, guest_addr, len as usize);
    } else {
        let end_addr = guest_addr + len;
        let from_bump = !(is_fixed && addr != 0);
        if !(from_bump && guest_addr >= MMAP_HWM) {
            // MAP_FIXED, or a bump region rewound below the high-water mark
            // (post-reset reuse) — may hold stale bytes, so zero the dirty part.
            let zero_end = if from_bump { core::cmp::min(end_addr, MMAP_HWM) } else { end_addr };
            if zero_end > guest_addr {
                mem::zero_mem(vm.ram_base, guest_addr, (zero_end - guest_addr) as usize);
            }
        }
        // else: virgin bump frontier — already engine-zero, skip the memset.
        if from_bump && end_addr > MMAP_HWM {
            MMAP_HWM = end_addr;
        }
    }

    if !is_anon {
        // Populate the mapping from the file: the host preads up to `length`
        // bytes at `offset` into [guest_addr, …) and returns guest_addr in a0
        // (or -errno). This is a private snapshot of the file contents —
        // MAP_SHARED stores are NOT written back to the file.
        vm.fs_request.syscall_nr = SYS_MMAP as i32;
        vm.fs_request.fd = fd;
        vm.fs_request.buf_ptr = guest_addr as u32;
        vm.fs_request.buf_len = length.min(len) as u32;
        vm.fs_request.arg1 = guest_addr as i64;
        vm.fs_request.arg2 = offset as i64;
        vm.fs_request.arg3 = length as i64;
        vm.status = STATUS_FS_PENDING;
    }

    guest_addr as i64
}

unsafe fn sys_munmap(vm: &mut Vm, addr: u64, length: u64) -> i64 {
    if addr & (PAGE_SIZE - 1) != 0 || length == 0 {
        return EINVAL;
    }
    // Frontier reclaim: the mmap bump allocator normally never shrinks, so a
    // long-running guest (e.g. `opencode serve`, whose V8 GC churns tens of
    // thousands of mmap/munmap pairs) marches mmap_next_addr to the RAM limit
    // and OOMs. When a region reaches the frontier, pull the frontier back so
    // the space is reused — this reclaims LIFO-freed allocations (the common V8
    // page-pool pattern) with zero bookkeeping and no reuse hazard (only the
    // bump pointer moves; nothing stale is ever handed back live). Also absorb
    // any free-listed regions that are now adjacent to the frontier.
    if addr != 0 {
        let len = (length + PAGE_SIZE - 1) & PAGE_MASK;
        let end = addr.saturating_add(len);
        // Drop any overlap with ranges already on the free list first, so a
        // double munmap (or an overlapping one) can never list the same pages
        // twice and hand them out to two later mmaps.
        free_list_remove(addr, len);
        let front = vm.mmap_next_addr;
        if addr >= front {
            // Above the bump frontier (MAP_FIXED area / stack): not bump space,
            // never reused by the allocator.
            return 0;
        }
        if end >= front {
            vm.mmap_next_addr = addr;
            coalesce_free_frontier(vm);
            return 0;
        }
        // Below the frontier: record it for first-fit reuse (bounded list; a
        // full list just means that region stays un-reclaimed — degrades to the
        // old no-op, never corrupts).
        if MMAP_FREE_COUNT < MMAP_FREE_CAP {
            MMAP_FREE[MMAP_FREE_COUNT] = (addr, len);
            MMAP_FREE_COUNT += 1;
        }
    }
    0
}

// Bounded free list of non-frontier munmap'd regions, reused by later anonymous
// mmap (first-fit) so the guest address space stays bounded to the working set.
// Module-global (single guest, cooperative — like BRK_HWM/MMAP_HWM); cleared on
// program load via reset_mmap_free() so a new program never reuses stale ranges.
// Invariant: entries never overlap each other (sys_munmap / MAP_FIXED subtract
// a range before inserting or claiming it).
const MMAP_FREE_CAP: usize = 1024;
static mut MMAP_FREE: [(u64, u64); MMAP_FREE_CAP] = [(0, 0); MMAP_FREE_CAP];
static mut MMAP_FREE_COUNT: usize = 0;

/// Clear the mmap free list (call whenever the mmap frontier is reset — new ELF
/// load / snapshot restore — so freed ranges from a prior image aren't reused).
pub unsafe fn reset_mmap_free() {
    MMAP_FREE_COUNT = 0;
}

/// Subtract [addr, addr+len) from every free-list entry (splitting an entry
/// that strictly contains it). If the list is full when a split needs a second
/// slot, the right-hand remainder is dropped — it just stays un-reclaimed.
unsafe fn free_list_remove(addr: u64, len: u64) {
    let end = addr.saturating_add(len);
    let mut i = 0;
    while i < MMAP_FREE_COUNT {
        let (faddr, flen) = MMAP_FREE[i];
        let fend = faddr + flen;
        if fend <= addr || faddr >= end {
            i += 1;
            continue;
        }
        let left = if faddr < addr { Some((faddr, addr - faddr)) } else { None };
        let right = if fend > end { Some((end, fend - end)) } else { None };
        match (left, right) {
            (Some(l), Some(r)) => {
                MMAP_FREE[i] = l;
                if MMAP_FREE_COUNT < MMAP_FREE_CAP {
                    MMAP_FREE[MMAP_FREE_COUNT] = r;
                    MMAP_FREE_COUNT += 1;
                }
                i += 1;
            }
            (Some(l), None) => {
                MMAP_FREE[i] = l;
                i += 1;
            }
            (None, Some(r)) => {
                MMAP_FREE[i] = r;
                i += 1;
            }
            (None, None) => {
                // Fully covered: swap-remove and re-examine slot i.
                MMAP_FREE[i] = MMAP_FREE[MMAP_FREE_COUNT - 1];
                MMAP_FREE_COUNT -= 1;
            }
        }
    }
}

/// After the frontier moves back, absorb any free-listed region that now ends at
/// (or past) the frontier (repeatedly), turning scattered LIFO frees into one
/// contiguous reclaim.
unsafe fn coalesce_free_frontier(vm: &mut Vm) {
    let mut progress = true;
    while progress {
        progress = false;
        let mut i = 0;
        while i < MMAP_FREE_COUNT {
            let (faddr, flen) = MMAP_FREE[i];
            if faddr + flen >= vm.mmap_next_addr && faddr < vm.mmap_next_addr {
                vm.mmap_next_addr = faddr;
                MMAP_FREE[i] = MMAP_FREE[MMAP_FREE_COUNT - 1];
                MMAP_FREE_COUNT -= 1;
                progress = true;
            } else if faddr >= vm.mmap_next_addr {
                // Entirely at/above the frontier now — no longer free-list space.
                MMAP_FREE[i] = MMAP_FREE[MMAP_FREE_COUNT - 1];
                MMAP_FREE_COUNT -= 1;
            } else {
                i += 1;
            }
        }
    }
}

/// First-fit a freed region of at least `len` bytes; returns its address and
/// removes/splits it from the free list, or None. The caller must zero it
/// (MAP_ANONYMOUS memory must read as zero and a reused region isn't virgin).
unsafe fn take_free_region(len: u64) -> Option<u64> {
    let mut i = 0;
    while i < MMAP_FREE_COUNT {
        let (faddr, flen) = MMAP_FREE[i];
        if flen >= len {
            if flen == len {
                MMAP_FREE[i] = MMAP_FREE[MMAP_FREE_COUNT - 1];
                MMAP_FREE_COUNT -= 1;
            } else {
                MMAP_FREE[i] = (faddr + len, flen - len); // keep the remainder free
            }
            return Some(faddr);
        }
        i += 1;
    }
    None
}

/// mremap(old_addr, old_size, new_size, flags, [new_addr])
/// V8 uses this to grow heap segments. flags: MREMAP_MAYMOVE=1, MREMAP_FIXED=2
unsafe fn sys_mremap(vm: &mut Vm, old_addr: u64, old_size: u64, new_size: u64, flags: u64) -> i64 {
    let old_len = (old_size + PAGE_SIZE - 1) & PAGE_MASK;
    let new_len = (new_size + PAGE_SIZE - 1) & PAGE_MASK;
    let ram_limit = vm.ram_size as u64;

    // Shrink: just return old_addr (bump allocator doesn't free)
    if new_len <= old_len {
        return old_addr as i64;
    }

    let old_end = old_addr + old_len;
    let new_end = old_addr + new_len;

    // Try to grow in-place:
    // With a bump allocator, allocations are contiguous. In-place growth is only safe when:
    // 1. The region is at the bump frontier (old_end == mmap_next_addr)
    // 2. The region is above the bump pointer (e.g. MAP_FIXED or stack area)
    // 3. The region is below the mmap area (e.g. brk/heap growth before mmap starts)
    // For regions WITHIN the bump allocator range but not at the frontier,
    // growth would overlap the next allocation — return ENOMEM (matching Linux behavior).
    if old_end == vm.mmap_next_addr {
        // Case 1: region is at the bump frontier — extend it
        if new_end <= ram_limit {
            vm.mmap_next_addr = new_end;
            return old_addr as i64;
        }
    } else if old_end > vm.mmap_next_addr {
        // Case 2: region is above bump pointer (e.g. MAP_FIXED or stack area)
        // Allow in-place growth if within RAM, but do NOT advance bump pointer
        if new_end <= ram_limit {
            return old_addr as i64;
        }
    } else if old_end < vm.brk_current && new_end <= vm.brk_current {
        // Case 3: region is in brk area, growth stays within brk
        return old_addr as i64;
    }
    // All other cases: can't grow in-place (adjacent pages may be allocated)

    // MREMAP_MAYMOVE: allocate new space from bump allocator, copy data
    if flags & 1 != 0 {
        let new_addr = vm.mmap_next_addr;
        let move_end = new_addr + new_len;
        if move_end > ram_limit {
            return ENOMEM;
        }
        mem::copy_within(vm.ram_base, old_addr, new_addr, old_len as usize);
        vm.mmap_next_addr = move_end;
        return new_addr as i64;
    }

    ENOMEM
}

/// writev(fd, iov, iovcnt) - write from gather buffers
/// struct iovec { void *iov_base; size_t iov_len; }  (16 bytes each on RV64)
unsafe fn sys_writev(vm: &mut Vm, fd: i32, iov: u64, iovcnt: u32) -> i64 {
    let mut total: i64 = 0;
    let mut i: u32 = 0;
    while i < iovcnt {
        let iov_base = mem::read_u64(vm.ram_base, iov + (i as u64) * 16);
        let iov_len = mem::read_u64(vm.ram_base, iov + (i as u64) * 16 + 8) as u32;
        if iov_len > 0 {
            let ret = sys_write(vm, fd, iov_base, iov_len);
            if ret < 0 {
                return if total > 0 { total } else { ret };
            }
            total += ret;
            // If write triggered FS_PENDING, we need to stop
            if vm.status == STATUS_FS_PENDING {
                return total;
            }
        }
        i += 1;
    }
    total
}

/// readv(fd, iov, iovcnt) - read into scatter buffers
/// struct iovec { void *iov_base; size_t iov_len; }  (16 bytes each on RV64)
unsafe fn sys_readv(vm: &mut Vm, fd: i32, iov: u64, iovcnt: u32) -> i64 {
    let mut total: i64 = 0;
    let mut i: u32 = 0;
    while i < iovcnt {
        let iov_base = mem::read_u64(vm.ram_base, iov + (i as u64) * 16);
        let iov_len = mem::read_u64(vm.ram_base, iov + (i as u64) * 16 + 8) as u32;
        if iov_len > 0 {
            let ret = sys_read(vm, fd, iov_base, iov_len);
            if ret < 0 {
                return if total > 0 { total } else { ret };
            }
            total += ret;
            if vm.status == STATUS_FS_PENDING {
                return total;
            }
            // Short read: stop
            if ret < iov_len as i64 {
                break;
            }
        }
        i += 1;
    }
    total
}

/// pread64(fd, buf, count, offset) - read at explicit offset without updating FD cursor.
/// Used by Node.js v25's internalModuleReadJSON to read package.json files.
unsafe fn sys_pread64(vm: &mut Vm, fd: i32, buf: u64, count: u32, offset: u64) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    let fd_type = vm.fd_table[fd as usize].fd_type;

    match fd_type {
        FD_TYPE_FILE => {
            if !mem::range_ok(buf, count as u64) {
                return EFAULT;
            }
            // Delegate to host via FS protocol with SYS_PREAD64 marker
            // arg1 = count, arg2 = explicit offset
            vm.fs_request.syscall_nr = SYS_PREAD64 as i32;
            vm.fs_request.fd = fd;
            vm.fs_request.buf_ptr = buf as u32;
            vm.fs_request.buf_len = count;
            vm.fs_request.arg1 = count as i64;
            vm.fs_request.arg2 = offset as i64;
            vm.status = STATUS_FS_PENDING;
            0
        }
        FD_TYPE_DEVNULL => 0,
        _ => EBADF,
    }
}

/// preadv(fd, iov, iovcnt, offset) - read into scatter buffers at explicit offset.
/// For file FDs, dispatches each iovec buffer as an FS read with the given offset.
/// Does NOT update the file position (unlike readv).
// Positional write — the mirror of sys_pread64. Writes at an explicit offset
// without moving the FD cursor (node uses this heavily when emitting files).
unsafe fn sys_pwrite64(vm: &mut Vm, fd: i32, buf: u64, count: u32, offset: u64) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    let fd_type = vm.fd_table[fd as usize].fd_type;

    match fd_type {
        FD_TYPE_FILE => {
            if !mem::range_ok(buf, count as u64) {
                return EFAULT;
            }
            // Delegate to host via FS protocol with SYS_PWRITE64 marker.
            // arg1 = count, arg2 = explicit offset (the FD cursor is left alone).
            vm.fs_request.syscall_nr = SYS_PWRITE64 as i32;
            vm.fs_request.fd = fd;
            vm.fs_request.buf_ptr = buf as u32;
            vm.fs_request.buf_len = count;
            vm.fs_request.arg1 = count as i64;
            vm.fs_request.arg2 = offset as i64;
            vm.status = STATUS_FS_PENDING;
            0
        }
        FD_TYPE_DEVNULL => count as i64, // /dev/null: pretend the whole buffer was written
        _ => EBADF,
    }
}

// Positional vectored write — the mirror of sys_preadv (first non-empty iovec).
unsafe fn sys_pwritev(vm: &mut Vm, fd: i32, iov: u64, iovcnt: u32, offset: u64) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    let fd_type = vm.fd_table[fd as usize].fd_type;

    match fd_type {
        FD_TYPE_FILE => {
            let mut i: u32 = 0;
            while i < iovcnt {
                let iov_base = mem::read_u64(vm.ram_base, iov + (i as u64) * 16);
                let iov_len = mem::read_u64(vm.ram_base, iov + (i as u64) * 16 + 8) as u32;
                if iov_len > 0 {
                    if !mem::range_ok(iov_base, iov_len as u64) {
                        return EFAULT;
                    }
                    vm.fs_request.syscall_nr = SYS_PWRITEV as i32;
                    vm.fs_request.fd = fd;
                    vm.fs_request.buf_ptr = iov_base as u32;
                    vm.fs_request.buf_len = iov_len;
                    vm.fs_request.arg1 = iov_len as i64;
                    vm.fs_request.arg2 = offset as i64;
                    vm.status = STATUS_FS_PENDING;
                    return 0; // host fills the result
                }
                i += 1;
            }
            0
        }
        FD_TYPE_DEVNULL => 0,
        _ => EBADF,
    }
}

unsafe fn sys_preadv(vm: &mut Vm, fd: i32, iov: u64, iovcnt: u32, offset: u64) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    let fd_type = vm.fd_table[fd as usize].fd_type;

    match fd_type {
        FD_TYPE_FILE => {
            // Read the first iovec entry and dispatch as FS request with explicit offset.
            // Node.js's internalModuleReadJSON typically uses a single iovec.
            let mut total: i64 = 0;
            let mut cur_offset = offset;
            let mut i: u32 = 0;
            while i < iovcnt {
                let iov_base = mem::read_u64(vm.ram_base, iov + (i as u64) * 16);
                let iov_len = mem::read_u64(vm.ram_base, iov + (i as u64) * 16 + 8) as u32;
                if iov_len > 0 {
                    if !mem::range_ok(iov_base, iov_len as u64) {
                        return EFAULT;
                    }
                    // Dispatch FS request: use SYS_PREADV marker so JS host knows
                    // to use the explicit offset and not update the FD cursor
                    vm.fs_request.syscall_nr = SYS_PREADV as i32;
                    vm.fs_request.fd = fd;
                    vm.fs_request.buf_ptr = iov_base as u32;
                    vm.fs_request.buf_len = iov_len;
                    vm.fs_request.arg1 = iov_len as i64;
                    vm.fs_request.arg2 = cur_offset as i64;
                    vm.status = STATUS_FS_PENDING;
                    return total; // host will fill result
                }
                i += 1;
            }
            total
        }
        _ => EBADF,
    }
}

/// Scratch buffer for OPOST output translation (NL -> CR NL). Reused per write;
/// safe because `console_write` forwards synchronously to the term parser and
/// execution is single-threaded (same contract as tty::ECHO_BUF).
const OPOST_BUF_CAP: usize = 1024;
static mut OPOST_BUF: [u8; OPOST_BUF_CAP] = [0; OPOST_BUF_CAP];

/// Write guest bytes to the console with terminal output post-processing. With a
/// tty in OPOST|ONLCR mode (the cooked default), each NL becomes CR-NL — exactly
/// what the kernel's n_tty write path does. Without it a program's bare '\n'
/// line-feeds with no carriage return, producing the classic "staircase" where
/// every line starts under the end of the previous one. Raw mode (OPOST cleared)
/// and non-tty consoles pass through untouched.
unsafe fn console_write_tty(vm: &Vm, fd: i32, buf: u64, count: u32) {
    let onlcr = vm.tty_enabled != 0 && (vm.c_oflag & OPOST) != 0 && (vm.c_oflag & ONLCR) != 0;
    if !onlcr {
        let ptr = (vm.ram_base + buf as u32) as i32;
        host::console_write(fd, ptr, count as i32);
        return;
    }
    let mut out: usize = 0;
    let mut i: u32 = 0;
    while i < count {
        // Each iteration appends at most 2 bytes (CR NL); flush first if needed.
        if out + 2 > OPOST_BUF_CAP {
            host::console_write(fd, OPOST_BUF.as_ptr() as i32, out as i32);
            out = 0;
        }
        let b = mem::read_u8(vm.ram_base, buf + i as u64);
        if b == b'\n' {
            OPOST_BUF[out] = b'\r';
            OPOST_BUF[out + 1] = b'\n';
            out += 2;
        } else {
            OPOST_BUF[out] = b;
            out += 1;
        }
        i += 1;
    }
    if out > 0 {
        host::console_write(fd, OPOST_BUF.as_ptr() as i32, out as i32);
    }
}

unsafe fn sys_write(vm: &mut Vm, fd: i32, buf: u64, count: u32) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    let fd_type = vm.fd_table[fd as usize].fd_type;

    match fd_type {
        FD_TYPE_STDOUT | FD_TYPE_STDERR => {
            // The host reads [buf, buf+count) straight out of linear memory, so
            // it must lie inside guest RAM.
            if !mem::range_ok(buf, count as u64) {
                return EFAULT;
            }
            // Console output, with tty OPOST/ONLCR post-processing.
            console_write_tty(vm, fd, buf, count);
            count as i64
        }
        FD_TYPE_DEVNULL => count as i64,
        FD_TYPE_FILE | FD_TYPE_PIPE => {
            if !mem::range_ok(buf, count as u64) {
                return EFAULT;
            }
            // Delegate to host via FS protocol
            vm.fs_request.syscall_nr = SYS_WRITE as i32;
            vm.fs_request.fd = fd;
            vm.fs_request.buf_ptr = buf as u32;
            vm.fs_request.buf_len = count;
            vm.fs_request.arg1 = count as i64;
            vm.status = STATUS_FS_PENDING;
            return 0; // will be filled by host
        }
        FD_TYPE_EVENTFD => {
            // eventfd write: add the 8-byte value to the per-fd counter
            if count < 8 {
                return EINVAL;
            }
            let val = mem::read_u64(vm.ram_base, buf) as u32;
            let efd_slot = vm.fd_table[fd as usize].host_fd as usize;
            if efd_slot < MAX_EVENTFDS {
                EVENTFD_COUNTERS[efd_slot] = EVENTFD_COUNTERS[efd_slot].wrapping_add(val);
            }
            // Wake epoll-waiting threads (libuv uses eventfd for event loop wakeup)
            wake_epoll_threads(vm);
            8
        }
        FD_TYPE_SOCKET => sock_write(vm, fd, buf, count),
        _ => EBADF,
    }
}

unsafe fn sys_read(vm: &mut Vm, fd: i32, buf: u64, count: u32) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    let fd_type = vm.fd_table[fd as usize].fd_type;

    match fd_type {
        FD_TYPE_STDIN => {
            // stdin is owned by the in-VM tty ring (line discipline). Try to
            // satisfy the read now; if interactive and empty, park (FS_PENDING)
            // and let the host retry via vm_io_retry when input arrives.
            let r = crate::tty::try_read(vm, buf, count);
            if r == crate::tty::WAIT {
                vm.fs_request.syscall_nr = SYS_READ as i32;
                vm.fs_request.fd = fd;
                vm.fs_request.buf_ptr = buf as u32;
                vm.fs_request.buf_len = count;
                vm.fs_request.arg1 = count as i64;
                vm.status = STATUS_FS_PENDING;
                0
            } else {
                r
            }
        }
        FD_TYPE_FILE | FD_TYPE_PIPE => {
            if !mem::range_ok(buf, count as u64) {
                return EFAULT;
            }
            // Delegate to host via FS protocol
            vm.fs_request.syscall_nr = SYS_READ as i32;
            vm.fs_request.fd = fd;
            vm.fs_request.buf_ptr = buf as u32;
            vm.fs_request.buf_len = count;
            vm.fs_request.arg1 = count as i64;
            vm.status = STATUS_FS_PENDING;
            0
        }
        FD_TYPE_DEVNULL => 0,
        FD_TYPE_EVENTFD => {
            // Read eventfd per-fd counter
            if count < 8 {
                return EINVAL;
            }
            let efd_slot = vm.fd_table[fd as usize].host_fd as usize;
            let val = if efd_slot < MAX_EVENTFDS { EVENTFD_COUNTERS[efd_slot] as u64 } else { 0 };
            mem::write_u64(vm.ram_base, buf, val);
            if efd_slot < MAX_EVENTFDS {
                EVENTFD_COUNTERS[efd_slot] = 0;
            }
            8
        }
        FD_TYPE_TIMERFD => {
            // Read timerfd — returns u64 number of expirations
            if count < 8 {
                return EINVAL;
            }
            let tfd_slot = vm.fd_table[fd as usize].host_fd as usize;
            if tfd_slot < MAX_TIMERFDS {
                let expiry = TIMERFD_EXPIRY_MS[tfd_slot];
                if expiry > 0.0 {
                    let now = host::emscripten_date_now();
                    if now >= expiry {
                        // Timer has fired — return 1 expiration
                        mem::write_u64(vm.ram_base, buf, 1);
                        // Re-arm or disarm
                        let interval = TIMERFD_INTERVAL_MS[tfd_slot];
                        if interval > 0.0 {
                            TIMERFD_EXPIRY_MS[tfd_slot] = now + interval;
                        } else {
                            TIMERFD_EXPIRY_MS[tfd_slot] = 0.0;
                        }
                        return 8;
                    }
                }
                // Not yet expired — would block
                return -11; // EAGAIN
            }
            EINVAL
        }
        FD_TYPE_SOCKET => sock_read(vm, fd, buf, count),
        _ => EBADF,
    }
}

/// True when another guest fd (≠ `fd`) in this table is `fd_type` with `host_fd`.
unsafe fn other_fd_ref(vm: &Vm, fd: usize, fd_type: i32, host_fd: i32) -> bool {
    let mut i = 0;
    while i < MAX_FDS {
        if i != fd && vm.fd_table[i].fd_type == fd_type && vm.fd_table[i].host_fd == host_fd {
            return true;
        }
        i += 1;
    }
    fork_held(None, fd_type, host_fd)
}

// ---- Suspended fork parents' fd tables ----
//
// Fork is serialized: the host snapshots the parent and runs the child to exit
// first. The parent's fd table then lives only in the host's snapshot, so the
// "is this the last reference?" scan for VM-local objects (socket / eventfd /
// timerfd slots, epoll interest) must also see it — otherwise a forked child
// closing an inherited fd frees the object under the parent. (BusyBox httpd's
// per-connection child closes the listening socket: the server then answered
// one connection and was gone.) The host pushes the parent's table here at
// fork (vm_fork_hold) and pops it when the child exits (vm_fork_exit).
const FORK_MAX_DEPTH: usize = 32;
// All-zero so the tables cost no wasm data; only rows < FORK_DEPTH are read.
const ZERO_FD: FdEntry = FdEntry { fd_type: FD_TYPE_NONE, host_fd: 0, offset: 0, flags: 0, fd_flags: 0 };
static mut FORK_FD_TABLES: [[FdEntry; MAX_FDS]; FORK_MAX_DEPTH] = [[ZERO_FD; MAX_FDS]; FORK_MAX_DEPTH];
static mut FORK_DEPTH: usize = 0;

/// True when a suspended fork parent references (fd_type, host_fd) — at guest
/// fd `at` only (epoll interest is keyed by fd number), or at any fd (`None`).
unsafe fn fork_held(at: Option<usize>, fd_type: i32, host_fd: i32) -> bool {
    let mut d = 0;
    while d < FORK_DEPTH {
        let t = &*core::ptr::addr_of!(FORK_FD_TABLES[d]);
        let (mut i, end) = match at {
            Some(fd) => (fd, fd + 1),
            None => (0, MAX_FDS),
        };
        while i < end && i < MAX_FDS {
            if t[i].fd_type == fd_type && t[i].host_fd == host_fd {
                return true;
            }
            i += 1;
        }
        d += 1;
    }
    false
}

/// Drop guest fd `fd`'s epoll interest unless a suspended fork parent holds
/// the same object at the same fd number (its registration must survive).
unsafe fn epoll_forget_unheld(vm: &Vm, fd: usize) {
    let e = vm.fd_table[fd];
    if !fork_held(Some(fd), e.fd_type, e.host_fd) {
        epoll_forget_fd(fd as i32, e.fd_type == FD_TYPE_EPOLL);
    }
}

/// Fork: record the parent's fd table (the host snapshots the rest). Returns
/// 0, or -1 when nesting exceeds FORK_MAX_DEPTH (then nothing is recorded and
/// the caller must not call fork_exit for this frame).
pub unsafe fn fork_hold(vm: &Vm) -> i32 {
    if FORK_DEPTH >= FORK_MAX_DEPTH {
        return -1;
    }
    FORK_FD_TABLES[FORK_DEPTH] = vm.fd_table;
    FORK_DEPTH += 1;
    0
}

/// A forked child exited: release its VM-local fds (those the parent — or an
/// outer suspended ancestor — still holds survive), then forget the parent's
/// recorded table. Call before the host restores the parent's Vm struct.
pub unsafe fn fork_exit(vm: &mut Vm) {
    let mut fd = 0;
    while fd < MAX_FDS {
        let t = vm.fd_table[fd].fd_type;
        if t != FD_TYPE_NONE && !host_owned(t) {
            drop_fd_local(vm, fd);
        }
        fd += 1;
    }
    if FORK_DEPTH > 0 {
        FORK_DEPTH -= 1;
    }
}

/// Release the Rust-side resource behind guest fd `fd` (socket slot, eventfd /
/// timerfd slot, epoll interest entries) when this fd is its last reference in
/// the table, then clear the entry. FILE/DIR/PIPE resources are host-owned
/// (shared open-file descriptions / pipe buffers) — the caller notifies the
/// host for those. Returns the entry that was there.
unsafe fn drop_fd_local(vm: &mut Vm, fd: usize) -> FdEntry {
    let e = vm.fd_table[fd];
    epoll_forget_unheld(vm, fd);
    let last = !other_fd_ref(vm, fd, e.fd_type, e.host_fd);
    match e.fd_type {
        FD_TYPE_SOCKET if last => {
            let slot = e.host_fd as usize;
            if slot < MAX_SOCKETS {
                SOCKETS[slot].state = SOCK_FREE;
                SOCKETS[slot].guest_fd = -1;
                SOCKETS[slot].peer_idx = -1;
                SOCKETS[slot].recv_head = 0;
                SOCKETS[slot].recv_tail = 0;
                SOCKETS[slot].accept_head = 0;
                SOCKETS[slot].accept_tail = 0;
                // Peer will see EPOLLHUP — wake epoll threads
                wake_epoll_threads(vm);
            }
        }
        FD_TYPE_EVENTFD if last => {
            let slot = e.host_fd as usize;
            if slot < MAX_EVENTFDS {
                EVENTFD_COUNTERS[slot] = 0;
                EVENTFD_FREE |= 1 << slot;
            }
        }
        FD_TYPE_TIMERFD if last => {
            let slot = e.host_fd as usize;
            if slot < MAX_TIMERFDS {
                TIMERFD_EXPIRY_MS[slot] = 0.0;
                TIMERFD_INTERVAL_MS[slot] = 0.0;
                TIMERFD_FREE |= 1 << slot;
            }
        }
        _ => {}
    }
    vm.fd_table[fd] = FdEntry { fd_type: FD_TYPE_NONE, host_fd: -1, offset: 0, flags: 0, fd_flags: 0 };
    e
}

/// FILE/DIR/PIPE fds reference host-side shared state (an open-file description
/// in MemFS.openFiles, or a pipe buffer) that the host reference-counts across
/// every process's fd table.
#[inline(always)]
fn host_owned(fd_type: i32) -> bool {
    fd_type == FD_TYPE_FILE || fd_type == FD_TYPE_DIR || fd_type == FD_TYPE_PIPE
}

unsafe fn sys_close(vm: &mut Vm, fd: i32) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    let fd_type = vm.fd_table[fd as usize].fd_type;
    if fd_type == FD_TYPE_NONE {
        return EBADF;
    }

    if host_owned(fd_type) {
        // The host clears the entry and releases the shared open-file
        // description / pipe buffer only when no other fd — in this process or
        // a suspended fork parent — still references it. (Deciding that here
        // would miss the parent's references: a forked child closing an
        // inherited fd must not close the parent's file.)
        epoll_forget_unheld(vm, fd as usize);
        sys_fs_request(vm, SYS_CLOSE as i32, fd, 0, 0, 0);
        return 0; // status set by fs_request
    }

    drop_fd_local(vm, fd as usize);
    0
}

/// PATH_MAX: capacity (including the NUL) of the host-visible path buffers.
pub const PATH_CAP: usize = 4096;
static mut FS_PATH: [u8; PATH_CAP] = [0; PATH_CAP];
static mut FS_PATH2: [u8; PATH_CAP] = [0; PATH_CAP];

/// Linear-memory address of the full first / second FS request path.
pub unsafe fn fs_path_ptr() -> u32 {
    core::ptr::addr_of!(FS_PATH) as u32
}
pub unsafe fn fs_path2_ptr() -> u32 {
    core::ptr::addr_of!(FS_PATH2) as u32
}

/// Copy the guest path at `addr` into FS_PATH (or FS_PATH2 when `second`), plus
/// a legacy ≤255-byte copy into fs_request.path/path2 for older hosts. A NULL
/// pointer stages the empty path. Returns 0, or -ENAMETOOLONG / -EFAULT —
/// never a silently truncated path.
unsafe fn stage_path(vm: &mut Vm, addr: u64, second: bool) -> i64 {
    let full = if second {
        core::ptr::addr_of_mut!(FS_PATH2) as *mut u8
    } else {
        core::ptr::addr_of_mut!(FS_PATH) as *mut u8
    };
    let legacy = if second { vm.fs_request.path2.as_mut_ptr() } else { vm.fs_request.path.as_mut_ptr() };
    let n = if addr == 0 {
        *full = 0;
        0
    } else {
        let n = mem::copy_cstr(vm.ram_base, addr, full, PATH_CAP);
        if n < 0 {
            *legacy = 0;
            return n;
        }
        n as usize
    };
    let m = if n < 255 { n } else { 255 };
    core::ptr::copy_nonoverlapping(full, legacy, m);
    *legacy.add(m) = 0;
    0
}

/// Set up a FS request and switch to FS_PENDING status.
/// The JS host will process the request and resume. If the path can't be
/// staged (too long / bad pointer) the syscall fails immediately with that
/// errno in a0 and no request is issued.
unsafe fn sys_fs_request(
    vm: &mut Vm,
    syscall_nr: i32,
    fd: i32,
    path_addr: u64,
    arg1: i64,
    arg2: i64,
) {
    let r = stage_path(vm, path_addr, false);
    if r < 0 {
        vm.x[10] = r as u64;
        return;
    }
    vm.fs_request.syscall_nr = syscall_nr;
    vm.fs_request.fd = fd;
    vm.fs_request.arg1 = arg1;
    vm.fs_request.arg2 = arg2;
    vm.status = STATUS_FS_PENDING;
}

/// renameat2(olddirfd, oldpath, newdirfd, newpath, flags): fd = olddirfd,
/// arg1 = newdirfd, arg2 = flags; paths in FS_PATH / FS_PATH2.
unsafe fn sys_fs_request_rename(
    vm: &mut Vm,
    old_dirfd: i32,
    old_path_addr: u64,
    new_dirfd: i32,
    new_path_addr: u64,
    flags: i64,
) {
    let mut r = stage_path(vm, old_path_addr, false);
    if r == 0 {
        r = stage_path(vm, new_path_addr, true);
    }
    if r < 0 {
        vm.x[10] = r as u64;
        return;
    }
    vm.fs_request.syscall_nr = SYS_RENAMEAT2 as i32;
    vm.fs_request.fd = old_dirfd;
    vm.fs_request.arg1 = new_dirfd as i64;
    vm.fs_request.arg2 = flags;
    vm.status = STATUS_FS_PENDING;
}

unsafe fn sys_getcwd(vm: &mut Vm, buf: u64, size: u32) -> i64 {
    let mut len = 0;
    while len < 255 && vm.cwd[len] != 0 {
        len += 1;
    }
    if len + 1 > size as usize {
        return -34; // ERANGE
    }
    if !mem::range_ok(buf, (len + 1) as u64) {
        return EFAULT;
    }
    mem::write_bytes(vm.ram_base, buf, &vm.cwd[..len + 1]);
    buf as i64
}

unsafe fn sys_clock_gettime(vm: &mut Vm, _clk_id: i32, tp: u64) -> i64 {
    let ms = host::emscripten_date_now();
    let secs = (ms / 1000.0) as i64;
    let nsecs = ((ms % 1000.0) * 1_000_000.0) as i64;
    mem::write_u64(vm.ram_base, tp, secs as u64);
    mem::write_u64(vm.ram_base, tp + 8, nsecs as u64);
    0
}

unsafe fn sys_clock_getres(vm: &mut Vm, _clk_id: i32, res: u64) -> i64 {
    if res != 0 {
        // 1ms resolution
        mem::write_u64(vm.ram_base, res, 0);        // tv_sec
        mem::write_u64(vm.ram_base, res + 8, 1_000_000); // tv_nsec = 1ms
    }
    0
}

unsafe fn sys_nanosleep(vm: &mut Vm, req: u64) -> i64 {
    // Just read and ignore the timespec
    let _secs = mem::read_u64(vm.ram_base, req);
    let _nsecs = mem::read_u64(vm.ram_base, req + 8);
    0
}

/// uname: fills struct utsname (65-byte fields × 6)
unsafe fn sys_uname(vm: &mut Vm, buf: u64) -> i64 {
    // Zero the buffer (390 bytes = 6 * 65)
    mem::zero_mem(vm.ram_base, buf, 390);
    // sysname
    mem::write_bytes(vm.ram_base, buf, b"Linux\0");
    // nodename
    mem::write_bytes(vm.ram_base, buf + 65, b"nanovm\0");
    // release
    mem::write_bytes(vm.ram_base, buf + 130, b"6.1.0\0");
    // version
    mem::write_bytes(vm.ram_base, buf + 195, b"#1 NanoVM\0");
    // machine
    mem::write_bytes(vm.ram_base, buf + 260, b"riscv64\0");
    // domainname
    mem::write_bytes(vm.ram_base, buf + 325, b"(none)\0");
    0
}

unsafe fn sys_getrandom(vm: &mut Vm, buf: u64, count: u32) -> i64 {
    // Fill buffer with random bytes using emscripten_random
    let mut i = 0u32;
    while i < count {
        let r = host::emscripten_random();
        let bytes = r.to_bits().to_le_bytes();
        let remaining = count - i;
        let n = if remaining >= 4 { 4 } else { remaining };
        let mut j = 0u32;
        while j < n {
            mem::write_u8(vm.ram_base, buf + (i + j) as u64, bytes[j as usize]);
            j += 1;
        }
        i += n;
    }
    count as i64
}

unsafe fn sys_sigaltstack(vm: &mut Vm, ss: u64, old_ss: u64) -> i64 {
    if old_ss != 0 {
        mem::write_u64(vm.ram_base, old_ss, vm.sigaltstack_sp);
        mem::write_u32(vm.ram_base, old_ss + 8, vm.sigaltstack_flags as u32);
        mem::write_u64(vm.ram_base, old_ss + 16, vm.sigaltstack_size);
    }
    if ss != 0 {
        vm.sigaltstack_sp = mem::read_u64(vm.ram_base, ss);
        vm.sigaltstack_flags = mem::read_u32(vm.ram_base, ss + 8) as i32;
        vm.sigaltstack_size = mem::read_u64(vm.ram_base, ss + 16);
    }
    0
}

// ============================================================
// Cooperative threading (2-thread model)
//
// Thread context is saved in thread_area (6588 bytes at offset 3972).
// Layout per thread slot (544 bytes):
//   0..255   x[32]     (256 bytes)
//   256..263 pc        (8 bytes)
//   264..519 f[32]     (256 bytes)
//   520..523 fcsr      (4 bytes)
//   524..527 state     (4 bytes: 0=unused, 1=runnable, 2=futex_wait, 3=epoll_wait)
//   528..535 tls_base  (8 bytes)
//   536..543 futex_addr(8 bytes)  - address being waited on
// Total: 544 bytes per slot. Slot 0 at thread_area[0..544].
// ============================================================

const TCTX_SIZE: usize = 544;
const TCTX_X: usize = 0;
const TCTX_PC: usize = 256;
const TCTX_F: usize = 264;
const TCTX_FCSR: usize = 520;
const TCTX_STATE: usize = 524;
const TCTX_TLS: usize = 528;
const TCTX_FUTEX_ADDR: usize = 536;

const TSTATE_UNUSED: i32 = 0;
const TSTATE_RUNNABLE: i32 = 1;
const TSTATE_FUTEX_WAIT: i32 = 2;
const TSTATE_EPOLL_WAIT: i32 = 3;

const MAX_THREADS: usize = 16;

#[inline(always)]
unsafe fn tctx_ptr(vm: &mut Vm, slot: usize) -> *mut u8 {
    vm.thread_area.as_mut_ptr().add(slot * TCTX_SIZE)
}

/// Save current VM CPU state into a thread slot.
#[inline(always)]
unsafe fn save_thread(vm: &mut Vm, slot: usize) {
    let p = tctx_ptr(vm, slot);
    core::ptr::copy_nonoverlapping(vm.x.as_ptr() as *const u8, p.add(TCTX_X), 256);
    core::ptr::copy_nonoverlapping(&vm.pc as *const u64 as *const u8, p.add(TCTX_PC), 8);
    core::ptr::copy_nonoverlapping(vm.f.as_ptr() as *const u8, p.add(TCTX_F), 256);
    core::ptr::copy_nonoverlapping(&vm.fcsr as *const u32 as *const u8, p.add(TCTX_FCSR), 4);
    core::ptr::copy_nonoverlapping(&vm.tls_base as *const u64 as *const u8, p.add(TCTX_TLS), 8);
}

/// Load a thread slot into VM CPU state.
#[inline(always)]
unsafe fn load_thread(vm: &mut Vm, slot: usize) {
    let p = tctx_ptr(vm, slot);
    core::ptr::copy_nonoverlapping(p.add(TCTX_X), vm.x.as_mut_ptr() as *mut u8, 256);
    core::ptr::copy_nonoverlapping(p.add(TCTX_PC), &mut vm.pc as *mut u64 as *mut u8, 8);
    core::ptr::copy_nonoverlapping(p.add(TCTX_F), vm.f.as_mut_ptr() as *mut u8, 256);
    core::ptr::copy_nonoverlapping(p.add(TCTX_FCSR), &mut vm.fcsr as *mut u32 as *mut u8, 4);
    core::ptr::copy_nonoverlapping(p.add(TCTX_TLS), &mut vm.tls_base as *mut u64 as *mut u8, 8);
    // Sanity check: PC should never be 0 after loading a thread
    if vm.pc == 0 {
        host::debug_log(0x0D200000 | (slot as i32 & 0xFF));
    }
}

#[inline(always)]
unsafe fn get_tstate(vm: &Vm, slot: usize) -> i32 {
    let p = vm.thread_area.as_ptr().add(slot * TCTX_SIZE + TCTX_STATE);
    core::ptr::read_unaligned(p as *const i32)
}

#[inline(always)]
unsafe fn set_tstate(vm: &mut Vm, slot: usize, state: i32) {
    let p = vm.thread_area.as_mut_ptr().add(slot * TCTX_SIZE + TCTX_STATE);
    core::ptr::write_unaligned(p as *mut i32, state);
}

#[inline(always)]
unsafe fn get_futex_addr(vm: &Vm, slot: usize) -> u64 {
    let p = vm.thread_area.as_ptr().add(slot * TCTX_SIZE + TCTX_FUTEX_ADDR);
    core::ptr::read_unaligned(p as *const u64)
}

#[inline(always)]
unsafe fn set_futex_addr(vm: &mut Vm, slot: usize, addr: u64) {
    let p = vm.thread_area.as_mut_ptr().add(slot * TCTX_SIZE + TCTX_FUTEX_ADDR);
    core::ptr::write_unaligned(p as *mut u64, addr);
}

/// Find a runnable thread slot (not the current one). Returns slot or -1.
/// Find a thread to switch to. The first two passes return a thread that will
/// make real progress (RUNNABLE, or an EPOLL_WAIT thread whose fds are ready).
///
/// `allow_idle_epoll` controls the third pass, which returns an EPOLL_WAIT thread
/// that has *no* ready events. That is a spin hazard: node's event loop runs on
/// two idle EPOLL_WAIT threads, and letting one eventless epoll_pwait switch to
/// the other just ping-pongs between them at 100% CPU, never yielding to the
/// host. So `sys_epoll_pwait` passes `false` — an eventless wait with no
/// progressable peer yields STATUS_EPOLL_BLOCKED to the host instead. `sys_futex`
/// passes `true` (a blocked futex has genuinely nowhere else to go; the epoll
/// thread it wakes will itself park via the fixed epoll path).
unsafe fn find_runnable(vm: &Vm, exclude: usize, allow_idle_epoll: bool) -> i32 {
    let n = vm.thread_count as usize;
    // First pass: prefer RUNNABLE threads
    let mut i = 0;
    while i < n && i < MAX_THREADS {
        if i != exclude && get_tstate(vm, i) == TSTATE_RUNNABLE {
            return i as i32;
        }
        i += 1;
    }
    // Second pass: pick an EPOLL_WAIT thread that has events pending
    i = 0;
    while i < n && i < MAX_THREADS {
        if i != exclude && get_tstate(vm, i) == TSTATE_EPOLL_WAIT {
            if has_epoll_events(vm) {
                return i as i32;
            }
        }
        i += 1;
    }
    // Third pass (opt-in): any EPOLL_WAIT thread even without ready events.
    if allow_idle_epoll && (has_listening_socket() || EPOLL_FINITE_TIMEOUT_ACTIVE) {
        i = 0;
        while i < n && i < MAX_THREADS {
            if i != exclude && get_tstate(vm, i) == TSTATE_EPOLL_WAIT {
                return i as i32;
            }
            i += 1;
        }
    }
    -1
}

/// Check if any epoll-registered FD has ready events.
unsafe fn has_epoll_events(vm: &Vm) -> bool {
    let mut i = 0;
    while i < EPOLL_COUNT {
        let fd = EPOLL_ENTRIES[i].fd;
        let wanted = EPOLL_ENTRIES[i].events;
        if fd >= 0 && fd < MAX_FDS as i32 {
            let fd_type = vm.fd_table[fd as usize].fd_type;
            if fd_type == FD_TYPE_SOCKET {
                let slot = vm.fd_table[fd as usize].host_fd as usize;
                if slot < MAX_SOCKETS {
                    let s = &SOCKETS[slot];
                    if wanted & EPOLLIN != 0 {
                        if s.state == SOCK_LISTENING && s.accept_tail > s.accept_head {
                            return true;
                        }
                        if (s.state == SOCK_CONNECTED || s.state == SOCK_SHUTDOWN)
                            && s.recv_tail > s.recv_head {
                            return true;
                        }
                    }
                    if wanted & EPOLLOUT != 0 && s.state == SOCK_CONNECTED {
                        if s.peer_idx >= 0 && (s.peer_idx as usize) < MAX_SOCKETS {
                            let used = SOCKETS[s.peer_idx as usize].recv_tail
                                - SOCKETS[s.peer_idx as usize].recv_head;
                            if (used as usize) < SOCK_BUF_SIZE {
                                return true;
                            }
                        }
                    }
                }
            } else if fd_type == FD_TYPE_EVENTFD {
                let efd_slot = vm.fd_table[fd as usize].host_fd as usize;
                if wanted & EPOLLIN != 0 && efd_slot < MAX_EVENTFDS && EVENTFD_COUNTERS[efd_slot] > 0 {
                    return true;
                }
            } else if fd_type == FD_TYPE_TIMERFD {
                let tfd_slot = vm.fd_table[fd as usize].host_fd as usize;
                if wanted & EPOLLIN != 0 && tfd_slot < MAX_TIMERFDS {
                    let expiry = TIMERFD_EXPIRY_MS[tfd_slot];
                    if expiry > 0.0 && host::emscripten_date_now() >= expiry {
                        return true;
                    }
                }
            }
        }
        i += 1;
    }
    false
}

/// Wake all EPOLL_WAIT threads to RUNNABLE (called when socket state changes).
unsafe fn wake_epoll_threads(vm: &mut Vm) {
    let n = vm.thread_count as usize;
    let mut i = 0;
    while i < n && i < MAX_THREADS {
        if get_tstate(vm, i) == TSTATE_EPOLL_WAIT {
            set_tstate(vm, i, TSTATE_RUNNABLE);
        }
        i += 1;
    }
}

/// Log a context switch. Tag 0x0F: low byte = from, next byte = to, next byte = reason
#[inline(always)]
unsafe fn log_switch(from: usize, to: usize, reason: u8) {
    host::debug_log(0x0F000000 | (from as i32 & 0xFF) | ((to as i32 & 0xFF) << 8) | ((reason as i32) << 16));
}

/// Context-switch from current_thread to target slot.
/// The current thread's state must already be in vm.x/pc/f/etc (saved by exec before ecall).
/// After this function returns, vm.x/pc/f/etc contain the target thread's state.
unsafe fn context_switch(vm: &mut Vm, from: usize, to: usize) {
    save_thread(vm, from);
    load_thread(vm, to);
    // Update active thread index (stored in _tid_extra)
    vm._tid_extra = to as i32;
}

unsafe fn sys_futex(
    vm: &mut Vm,
    uaddr: u64,
    futex_op: i32,
    val: u32,
    _timeout: u64,
    _uaddr2: u64,
) -> i64 {
    let op = futex_op & 0x7F; // mask out FUTEX_PRIVATE_FLAG
    let current_slot = vm._tid_extra as usize;

    match op {
        0 => {
            // FUTEX_WAIT
            let current = mem::read_u32(vm.ram_base, uaddr);
            if current != val {
                return -11; // EAGAIN - value changed
            }

            // Would block. Try to switch to another runnable thread.
            let target = find_runnable(vm, current_slot, true);
            if target >= 0 {
                let target = target as usize;

                log_switch(current_slot, target, 1); // 1=futex_wait
                // Save current thread as futex-waiting
                save_thread(vm, current_slot);
                // The saved x[10] will be set to 0 when this thread
                // is woken (either by futex_wake or when switched back to).
                let p = tctx_ptr(vm, current_slot);
                core::ptr::write_unaligned(p.add(TCTX_X + 80) as *mut u64, 0u64);
                set_tstate(vm, current_slot, TSTATE_FUTEX_WAIT);
                set_futex_addr(vm, current_slot, uaddr);

                // Load target thread
                load_thread(vm, target);
                set_tstate(vm, target, TSTATE_UNUSED); // mark as "running" (state in vm)
                vm._tid_extra = target as i32;

                // Return the target thread's x[10] as the syscall result.
                // For a freshly-cloned child, x[10]=0 (clone returns 0).
                // For a woken futex-waiter, x[10] was set to 0 when saved.
                return vm.x[10] as i64;
            }

            // No other thread to run — all threads blocked. Return ETIMEDOUT.
            -110 // ETIMEDOUT
        }
        1 => {
            // FUTEX_WAKE - wake up to val threads waiting on uaddr
            let mut woken = 0u32;
            let n = vm.thread_count as usize;
            let mut i = 0;
            while i < n && i < MAX_THREADS && woken < val {
                if i != current_slot
                    && get_tstate(vm, i) == TSTATE_FUTEX_WAIT
                    && get_futex_addr(vm, i) == uaddr
                {
                    set_tstate(vm, i, TSTATE_RUNNABLE);
                    woken += 1;
                }
                i += 1;
            }
            woken as i64
        }
        3 => {
            // FUTEX_REQUEUE - wake up to val waiters on uaddr,
            // then move up to val2 remaining waiters to uaddr2
            let val2 = _timeout as u32; // val2 is passed in the timeout arg
            let uaddr2 = _uaddr2;
            let mut woken = 0u32;
            let mut requeued = 0u32;
            let n = vm.thread_count as usize;
            let mut i = 0;
            while i < n && i < MAX_THREADS {
                if i != current_slot
                    && get_tstate(vm, i) == TSTATE_FUTEX_WAIT
                    && get_futex_addr(vm, i) == uaddr
                {
                    if woken < val {
                        set_tstate(vm, i, TSTATE_RUNNABLE);
                        woken += 1;
                    } else if requeued < val2 {
                        set_futex_addr(vm, i, uaddr2);
                        requeued += 1;
                    } else {
                        break;
                    }
                }
                i += 1;
            }
            (woken + requeued) as i64
        }
        _ => 0,
    }
}

/// execve(path, argv, envp). Marshals the request to the host, which resolves the
/// path (busybox/node, following symlinks), reads the argv/envp pointer arrays from
/// guest memory, and reloads the process image in place (preserving fds and cwd).
/// On success the host replaces the image and execution resumes at the new entry;
/// on failure the host writes a negative errno to a0.
unsafe fn sys_execve(vm: &mut Vm, path_addr: u64, argv: u64, envp: u64) {
    // Copy the executable path into the FS path buffer (null-terminated).
    let r = stage_path(vm, path_addr, false);
    if r < 0 {
        vm.x[10] = r as u64;
        return;
    }

    vm.fs_request.syscall_nr = SYS_EXECVE as i32;
    vm.fs_request.fd = 0;
    vm.fs_request.arg1 = argv as i64; // guest ptr to argv[] (NULL-terminated)
    vm.fs_request.arg2 = envp as i64; // guest ptr to envp[] (NULL-terminated)
    vm.status = STATUS_FS_PENDING;
}

/// wait4(pid, wstatus, options, rusage). Marshals to the host, which holds the
/// serialized children's exit codes (zombies) and writes the wait status word.
unsafe fn sys_wait4(vm: &mut Vm, pid: u64, wstatus: u64) {
    vm.fs_request.syscall_nr = SYS_WAIT4 as i32;
    vm.fs_request.arg1 = pid as i64;
    vm.fs_request.arg2 = wstatus as i64;
    vm.status = STATUS_FS_PENDING;
}

unsafe fn sys_clone(
    vm: &mut Vm,
    flags: u64,
    stack: u64,
    ptid: u64,
    tls: u64,
    ctid: u64,
) -> i64 {
    const CLONE_VM: u64 = 0x00000100;
    const CLONE_PARENT_SETTID: u64 = 0x00100000;
    const CLONE_CHILD_SETTID: u64 = 0x01000000;
    const CLONE_CHILD_CLEARTID: u64 = 0x00200000;
    const CLONE_SETTLS: u64 = 0x00080000;
    const CLONE_VFORK: u64 = 0x00004000;

    let new_tid = vm.tid + 1;
    vm.tid = new_tid;

    // Write TID to parent_tidptr if CLONE_PARENT_SETTID
    if flags & CLONE_PARENT_SETTID != 0 && ptid != 0 {
        mem::write_u32(vm.ram_base, ptid, new_tid as u32);
    }
    // Write TID to child_tidptr if CLONE_CHILD_SETTID
    if flags & CLONE_CHILD_SETTID != 0 && ctid != 0 {
        mem::write_u32(vm.ram_base, ctid, new_tid as u32);
    }

    // fork (no CLONE_VM): serialized fork orchestrated by the host. The host
    // snapshots the parent, runs the child first (clone returns 0 to the child),
    // and on the child's exit restores the parent (clone returns the child pid).
    // The value returned here is a placeholder the host overwrites.
    //
    // vfork (CLONE_VM|CLONE_VFORK — musl's vfork() and posix_spawn()) takes the
    // same path: the parent is suspended until the child execs/exits either
    // way, and a vfork child may only exec or _exit, so running it on a
    // snapshot of the parent is indistinguishable from sharing its memory.
    // Treating it as a thread instead ran parent and child concurrently on one
    // address space and stack. `stack` (arg3) is the child's sp — posix_spawn
    // passes a separate child stack that __clone's child path reads fn/arg
    // from; the host installs it AFTER snapshotting the parent.
    if flags & CLONE_VM == 0 || flags & CLONE_VFORK != 0 {
        vm.fs_request.syscall_nr = SYS_CLONE as i32;
        vm.fs_request.arg1 = flags as i64;
        vm.fs_request.arg2 = ctid as i64;
        vm.fs_request.arg3 = stack as i64;
        vm.status = STATUS_FS_PENDING;
        return new_tid as i64;
    }

    if flags & CLONE_VM != 0 {
        // Thread creation: set up child context in a new thread slot
        let slot = vm.thread_count as usize;
        if slot >= MAX_THREADS {
            return -11; // EAGAIN - too many threads
        }
        vm.thread_count = slot as i32 + 1;

        // Save parent's current state as the child's starting state.
        // At this point, vm.x/pc/f/fcsr are the parent's state
        // (exec saved them before the ecall). vm.pc is already
        // post-ecall (the instruction AFTER the ecall).
        save_thread(vm, slot);

        // Patch child's registers:
        //   x[10] = 0 (clone returns 0 to child)
        //   x[2]  = child stack (if provided)
        //   tls_base = tls (if CLONE_SETTLS)
        let p = tctx_ptr(vm, slot);
        // x[10] at offset 10*8 = 80
        core::ptr::write_unaligned(p.add(TCTX_X + 80) as *mut u64, 0);
        // x[2] (sp) at offset 2*8 = 16
        if stack != 0 {
            core::ptr::write_unaligned(p.add(TCTX_X + 16) as *mut u64, stack);
        }
        if flags & CLONE_SETTLS != 0 {
            core::ptr::write_unaligned(p.add(TCTX_TLS) as *mut u64, tls);
            // Also set x[4] (tp) = tls for the child thread
            core::ptr::write_unaligned(p.add(TCTX_X + 32) as *mut u64, tls);
        }
        // Store the new thread's TID in per-thread tracking
        vm.thread_tids[slot] = new_tid;
        // Store ctid for CLONE_CHILD_CLEARTID
        if flags & CLONE_CHILD_CLEARTID != 0 && ctid != 0 {
            vm.thread_ctids[slot] = ctid;
        }
        set_tstate(vm, slot, TSTATE_RUNNABLE);
    }

    // Set TLS for parent if CLONE_SETTLS (fork-like only)
    if flags & CLONE_VM == 0 && flags & CLONE_SETTLS != 0 {
        vm.tls_base = tls;
    }

    new_tid as i64
}

/// Copy fd `old` into slot `new` (sharing the host open-file description /
/// socket / eventfd …), with a fresh descriptor-flag word (FD_CLOEXEC is
/// per-descriptor and never inherited by a dup).
#[inline(always)]
unsafe fn dup_into(vm: &mut Vm, old: usize, new: usize, cloexec: bool) {
    vm.fd_table[new] = vm.fd_table[old];
    vm.fd_table[new].fd_flags = if cloexec { FD_CLOEXEC } else { 0 };
}

/// Lowest free fd >= min, or -EMFILE.
unsafe fn lowest_free_fd(vm: &Vm, min: usize) -> i64 {
    let mut i = min;
    while i < MAX_FDS {
        if vm.fd_table[i].fd_type == FD_TYPE_NONE {
            return i as i64;
        }
        i += 1;
    }
    EMFILE
}

unsafe fn sys_dup(vm: &mut Vm, old_fd: i32) -> i64 {
    if old_fd < 0 || old_fd >= MAX_FDS as i32 {
        return EBADF;
    }
    if vm.fd_table[old_fd as usize].fd_type == FD_TYPE_NONE {
        return EBADF;
    }
    let n = lowest_free_fd(vm, 0);
    if n >= 0 {
        dup_into(vm, old_fd as usize, n as usize, false);
    }
    n
}

/// dup3(old, new, flags) — also musl's dup2 (which handles old == new itself).
/// Atomically closes whatever `new` held: Rust-side resources are released
/// here; a host-owned FILE/DIR/PIPE occupant is released by the host (SYS_DUP3
/// request: fd = new, arg1 = old occupant's type, arg2 = its host_fd), after
/// the table already holds the dup so the host's reference scan sees it.
unsafe fn sys_dup3(vm: &mut Vm, old_fd: i32, new_fd: i32, flags: i32) -> i64 {
    if old_fd < 0 || old_fd >= MAX_FDS as i32 || new_fd < 0 || new_fd >= MAX_FDS as i32 {
        return EBADF;
    }
    if vm.fd_table[old_fd as usize].fd_type == FD_TYPE_NONE {
        return EBADF;
    }
    if old_fd == new_fd || flags & !O_CLOEXEC != 0 {
        return EINVAL;
    }
    let mut prev = FdEntry { fd_type: FD_TYPE_NONE, host_fd: -1, offset: 0, flags: 0, fd_flags: 0 };
    if vm.fd_table[new_fd as usize].fd_type != FD_TYPE_NONE {
        prev = vm.fd_table[new_fd as usize];
        if host_owned(prev.fd_type) {
            epoll_forget_unheld(vm, new_fd as usize);
        } else {
            drop_fd_local(vm, new_fd as usize);
        }
    }
    dup_into(vm, old_fd as usize, new_fd as usize, flags & O_CLOEXEC != 0);
    if host_owned(prev.fd_type) {
        vm.fs_request.syscall_nr = SYS_DUP3 as i32;
        vm.fs_request.fd = new_fd;
        vm.fs_request.arg1 = prev.fd_type as i64;
        vm.fs_request.arg2 = prev.host_fd as i64;
        vm.status = STATUS_FS_PENDING; // host releases prev, returns new_fd
    }
    new_fd as i64
}

unsafe fn sys_fcntl(vm: &mut Vm, fd: i32, cmd: i32, arg: u64) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    if vm.fd_table[fd as usize].fd_type == FD_TYPE_NONE {
        return EBADF;
    }

    match cmd {
        // F_DUPFD (0) / F_DUPFD_CLOEXEC (1030): duplicate to the lowest free fd
        // >= arg (busybox sh relies on moving the script fd to a high number,
        // e.g. fcntl(fd, F_DUPFD, 10)). The CLOEXEC variant marks the new fd
        // close-on-exec, which execve honors.
        0 | 1030 => {
            if arg >= MAX_FDS as u64 {
                return EINVAL;
            }
            let n = lowest_free_fd(vm, arg as usize);
            if n >= 0 {
                dup_into(vm, fd as usize, n as usize, cmd == 1030);
            }
            n
        }
        1 => {
            // F_GETFD
            (vm.fd_table[fd as usize].fd_flags & FD_CLOEXEC) as i64
        }
        2 => {
            // F_SETFD
            vm.fd_table[fd as usize].fd_flags = arg as i32 & FD_CLOEXEC;
            0
        }
        3 => {
            // F_GETFL
            vm.fd_table[fd as usize].flags as i64
        }
        4 => {
            // F_SETFL: only the status bits are settable. They belong to the
            // open-file description, so update every fd in this table that
            // shares it — and, for host-owned files, the host's description
            // (SYS_FCNTL request; arg2 = new flags).
            let e = vm.fd_table[fd as usize];
            let nf = (e.flags & !SETFL_MASK) | (arg as i32 & SETFL_MASK);
            let mut i = 0;
            while i < MAX_FDS {
                if vm.fd_table[i].fd_type == e.fd_type && vm.fd_table[i].host_fd == e.host_fd {
                    vm.fd_table[i].flags = nf;
                }
                i += 1;
            }
            if e.fd_type == FD_TYPE_SOCKET && (e.host_fd as usize) < MAX_SOCKETS {
                SOCKETS[e.host_fd as usize].nonblock = if nf & O_NONBLOCK != 0 { 1 } else { 0 };
            }
            if (e.fd_type == FD_TYPE_FILE || e.fd_type == FD_TYPE_DIR) && e.host_fd >= 0 {
                vm.fs_request.syscall_nr = SYS_FCNTL as i32;
                vm.fs_request.fd = fd;
                vm.fs_request.arg1 = 4;
                vm.fs_request.arg2 = nf as i64;
                vm.status = STATUS_FS_PENDING;
            }
            0
        }
        // POSIX advisory record locks (F_GETLK=5, F_SETLK=6, F_SETLKW=7) and the
        // open-file-description variants (F_OFD_GETLK=36, F_OFD_SETLK=37,
        // F_OFD_SETLKW=38). The VM runs one guest process cooperatively, so these
        // locks never contend — grant every request. Without this, SQLite's unix
        // VFS gets a lock error on the first write to a file-backed DB and reports
        // SQLITE_IOERR_LOCK ("disk I/O error"), which blocks node:sqlite (e.g.
        // opencode's serve DB) entirely. For the GETLK queries, report the region
        // as unlocked so the caller proceeds: struct flock has `short l_type` at
        // offset 0; F_UNLCK = 2.
        5 | 36 => {
            if arg != 0 {
                mem::write_u16(vm.ram_base, arg, 2); // l_type = F_UNLCK
            }
            0
        }
        6 | 7 | 37 | 38 => 0,
        _ => EINVAL,
    }
}

unsafe fn sys_ioctl(vm: &mut Vm, fd: i32, request: u64) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }

    // A fd is a terminal only when the host has opted this VM into tty mode and
    // the fd is one of the std streams. Otherwise the tty ioctls return ENOTTY,
    // exactly as before — so isatty() stays false for files and for node/batch
    // runs that never enable tty mode (the V8 init-path workaround is preserved).
    let is_tty_fd = vm.tty_enabled != 0
        && matches!(
            vm.fd_table[fd as usize].fd_type,
            FD_TYPE_STDIN | FD_TYPE_STDOUT | FD_TYPE_STDERR
        );

    match request {
        TIOCGWINSZ => {
            if !is_tty_fd {
                return -25; // ENOTTY
            }
            // struct winsize { u16 ws_row, ws_col, ws_xpixel, ws_ypixel }
            let a2 = vm.x[12];
            mem::write_u16(vm.ram_base, a2, vm.ws_row);
            mem::write_u16(vm.ram_base, a2 + 2, vm.ws_col);
            mem::write_u16(vm.ram_base, a2 + 4, 0);
            mem::write_u16(vm.ram_base, a2 + 6, 0);
            0
        }
        TIOCSWINSZ => {
            if !is_tty_fd {
                return -25;
            }
            let a2 = vm.x[12];
            vm.ws_row = mem::read_u16(vm.ram_base, a2);
            vm.ws_col = mem::read_u16(vm.ram_base, a2 + 2);
            // SIGWINCH delivery is wired in the signal-delivery step.
            0
        }
        TCGETS => {
            if !is_tty_fd {
                return -25;
            }
            // struct termios { tcflag_t c_iflag,c_oflag,c_cflag,c_lflag;
            //                  cc_t c_line; cc_t c_cc[19]; }
            let a2 = vm.x[12];
            mem::write_u32(vm.ram_base, a2, vm.c_iflag);
            mem::write_u32(vm.ram_base, a2 + 4, vm.c_oflag);
            mem::write_u32(vm.ram_base, a2 + 8, vm.c_cflag);
            mem::write_u32(vm.ram_base, a2 + 12, vm.c_lflag);
            mem::write_u8(vm.ram_base, a2 + 16, vm.c_line);
            let mut i = 0;
            while i < 19 {
                mem::write_u8(vm.ram_base, a2 + 17 + i as u64, vm.c_cc[i]);
                i += 1;
            }
            0
        }
        TCSETS | TCSETSW | TCSETSF => {
            if !is_tty_fd {
                return -25;
            }
            let a2 = vm.x[12];
            vm.c_iflag = mem::read_u32(vm.ram_base, a2);
            vm.c_oflag = mem::read_u32(vm.ram_base, a2 + 4);
            vm.c_cflag = mem::read_u32(vm.ram_base, a2 + 8);
            vm.c_lflag = mem::read_u32(vm.ram_base, a2 + 12);
            vm.c_line = mem::read_u8(vm.ram_base, a2 + 16);
            let mut i = 0;
            while i < 19 {
                vm.c_cc[i] = mem::read_u8(vm.ram_base, a2 + 17 + i as u64);
                i += 1;
            }
            0
        }
        FIONREAD => {
            let a2 = vm.x[12];
            mem::write_u32(vm.ram_base, a2, 0);
            0
        }
        _ => -25, // ENOTTY
    }
}

unsafe fn sys_pipe2(vm: &mut Vm, pipefd: u64, flags: i32) -> i64 {
    if !mem::range_ok(pipefd, 8) {
        return EFAULT;
    }
    // Find two free FDs
    let mut fds = [0i32; 2];
    let mut found = 0;
    for i in 0..MAX_FDS {
        if vm.fd_table[i].fd_type == FD_TYPE_NONE {
            fds[found] = i as i32;
            found += 1;
            if found == 2 {
                break;
            }
        }
    }
    if found < 2 {
        return -24; // EMFILE
    }

    let fd0 = fds[0] as usize;
    let fd1 = fds[1] as usize;
    // Both ends share a host-buffer id so writes to the write end are visible to
    // reads on the read end (and survive dup/dup2 of either end).
    let id = PIPE_NEXT_ID;
    PIPE_NEXT_ID = PIPE_NEXT_ID.wrapping_add(1).max(1);
    let st = flags & O_NONBLOCK;
    let fdf = if flags & O_CLOEXEC != 0 { FD_CLOEXEC } else { 0 };
    vm.fd_table[fd0] = FdEntry { fd_type: FD_TYPE_PIPE, host_fd: id, offset: 0, flags: st, fd_flags: fdf }; // read end
    vm.fd_table[fd1] = FdEntry { fd_type: FD_TYPE_PIPE, host_fd: id, offset: 0, flags: st | 1, fd_flags: fdf }; // write end

    vm.pipe_read_fd = fds[0];
    vm.pipe_write_fd = fds[1];

    mem::write_u32(vm.ram_base, pipefd, fds[0] as u32);
    mem::write_u32(vm.ram_base, pipefd + 4, fds[1] as u32);
    0
}

const POLLIN: u16 = 0x0001;

unsafe fn sys_ppoll(vm: &mut Vm, fds: u64, nfds: u32, timeout: u64) -> i64 {
    // Clear revents and find a stdin fd polled for POLLIN.
    let mut stdin_idx: i64 = -1;
    let mut i = 0u32;
    while i < nfds {
        let pfd = fds + (i as u64) * 8; // struct pollfd { int fd; short events; short revents; }
        let gfd = mem::read_i32(vm.ram_base, pfd);
        let events = mem::read_u16(vm.ram_base, pfd + 4);
        mem::write_u16(vm.ram_base, pfd + 6, 0);
        if gfd >= 0
            && (gfd as usize) < MAX_FDS
            && vm.fd_table[gfd as usize].fd_type == FD_TYPE_STDIN
            && (events & POLLIN) != 0
        {
            stdin_idx = i as i64;
        }
        i += 1;
    }

    if stdin_idx < 0 {
        return 0; // nothing we model is ready — behave as a timeout
    }
    if crate::tty::pollin() {
        let pfd = fds + (stdin_idx as u64) * 8;
        mem::write_u16(vm.ram_base, pfd + 6, POLLIN);
        return 1;
    }
    // Not ready. A non-NULL timeout of {0,0} means "poll, don't block".
    if timeout != 0 {
        let sec = mem::read_i64(vm.ram_base, timeout);
        let nsec = mem::read_i64(vm.ram_base, timeout + 8);
        if sec == 0 && nsec == 0 {
            return 0;
        }
    }
    if !crate::tty::interactive() {
        return 0;
    }
    // Park until input; host retries via vm_io_retry (fd field = the stdin index).
    vm.fs_request.syscall_nr = SYS_PPOLL as i32;
    vm.fs_request.fd = stdin_idx as i32;
    vm.fs_request.buf_ptr = fds as u32;
    vm.fs_request.arg1 = nfds as i64;
    vm.status = STATUS_FS_PENDING;
    0
}

/// Re-attempt a parked stdin read/ppoll against the tty ring. Returns 1 when the
/// op completed (a0 + status already set), 0 while it must keep waiting. Called
/// by the host (`vm_io_retry`) each loop iteration while status is FS_PENDING.
pub unsafe fn io_retry(vm: &mut Vm) -> i32 {
    // A pending signal interrupts the blocked stdin op with EINTR, then the
    // signal is delivered (its handler runs, or a default-fatal signal
    // terminates the VM).
    if (vm.sig_pending & !vm.sig_mask) != 0 {
        vm.x[10] = (-4i64) as u64; // a0 = -EINTR
        vm.status = STATUS_OK;
        deliver_signals(vm);
        return 1;
    }
    match vm.fs_request.syscall_nr as u64 {
        SYS_READ => {
            let r = crate::tty::try_read(vm, vm.fs_request.buf_ptr as u64, vm.fs_request.buf_len);
            if r == crate::tty::WAIT {
                return 0;
            }
            vm.x[10] = r as u64;
            vm.status = STATUS_OK;
            1
        }
        SYS_PPOLL => {
            if crate::tty::pollin() {
                let pfd = vm.fs_request.buf_ptr as u64 + (vm.fs_request.fd as u64) * 8;
                mem::write_u16(vm.ram_base, pfd + 6, POLLIN);
                vm.x[10] = 1;
                vm.status = STATUS_OK;
                1
            } else {
                0
            }
        }
        _ => 1,
    }
}

unsafe fn sys_epoll_create1(vm: &mut Vm, flags: i32) -> i64 {
    let n = lowest_free_fd(vm, 0);
    if n >= 0 {
        let fdf = if flags & O_CLOEXEC != 0 { FD_CLOEXEC } else { 0 };
        vm.fd_table[n as usize] = FdEntry { fd_type: FD_TYPE_EPOLL, host_fd: -1, offset: 0, flags: 0, fd_flags: fdf };
    }
    n
}

/// Drop epoll interest entries that watch guest fd `fd` (it is being closed —
/// a stale entry would otherwise watch whatever is next allocated at that fd
/// number), and, if `fd` is itself an epoll instance, every entry it owns.
unsafe fn epoll_forget_fd(fd: i32, is_epoll: bool) {
    let mut i = 0;
    while i < EPOLL_COUNT {
        if EPOLL_ENTRIES[i].fd == fd || (is_epoll && EPOLL_ENTRIES[i].epfd == fd) {
            EPOLL_COUNT -= 1;
            EPOLL_ENTRIES[i] = EPOLL_ENTRIES[EPOLL_COUNT];
            EPOLL_ENTRIES[EPOLL_COUNT] = EMPTY_EPOLL;
        } else {
            i += 1;
        }
    }
}

/// Index of the interest entry (epfd, fd), or -1.
unsafe fn epoll_find(epfd: i32, fd: i32) -> i32 {
    let mut i = 0;
    while i < EPOLL_COUNT {
        if EPOLL_ENTRIES[i].epfd == epfd && EPOLL_ENTRIES[i].fd == fd {
            return i as i32;
        }
        i += 1;
    }
    -1
}

unsafe fn sys_epoll_ctl(
    vm: &mut Vm,
    epfd: i32,
    op: i32,
    fd: i32,
    event: u64,
) -> i64 {
    // Read epoll_event from guest memory
    // RISC-V: struct epoll_event is NOT packed (unlike x86_64)
    // Layout: { u32 events; u32 _pad; u64 data; } = 16 bytes
    let events = if event != 0 { mem::read_u32(vm.ram_base, event) } else { 0 };
    let data = if event != 0 { mem::read_u64(vm.ram_base, event + 8) } else { 0 };

    if epfd < 0 || epfd >= MAX_FDS as i32 || fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    if vm.fd_table[epfd as usize].fd_type != FD_TYPE_EPOLL {
        return if vm.fd_table[epfd as usize].fd_type == FD_TYPE_NONE { EBADF } else { EINVAL };
    }
    if vm.fd_table[fd as usize].fd_type == FD_TYPE_NONE {
        return EBADF;
    }
    if fd == epfd {
        return EINVAL;
    }
    let idx = epoll_find(epfd, fd);

    match op {
        1 => {
            // EPOLL_CTL_ADD
            if idx >= 0 {
                return EEXIST;
            }
            if EPOLL_COUNT >= MAX_EPOLL_ENTRIES {
                return ENOSPC;
            }
            EPOLL_ENTRIES[EPOLL_COUNT] = EpollEntry { epfd, fd, events, data };
            EPOLL_COUNT += 1;
            0
        }
        2 => {
            // EPOLL_CTL_DEL
            if idx < 0 {
                return ENOENT;
            }
            let i = idx as usize;
            EPOLL_COUNT -= 1;
            EPOLL_ENTRIES[i] = EPOLL_ENTRIES[EPOLL_COUNT];
            EPOLL_ENTRIES[EPOLL_COUNT] = EMPTY_EPOLL;
            0
        }
        3 => {
            // EPOLL_CTL_MOD
            if idx < 0 {
                return ENOENT;
            }
            EPOLL_ENTRIES[idx as usize].events = events;
            EPOLL_ENTRIES[idx as usize].data = data;
            0
        }
        _ => EINVAL,
    }
}

unsafe fn sys_epoll_pwait(
    vm: &mut Vm,
    epfd: i32,
    events_buf: u64,
    maxevents: i32,
    timeout: i32,
) -> i64 {
    // Check registered FDs for readiness, filtered by epoll instance
    let mut count = 0i32;
    let max = if maxevents > 0 { maxevents } else { 0 };

    let mut i = 0;
    while i < EPOLL_COUNT && count < max {
        // Only check entries belonging to this epoll instance
        if EPOLL_ENTRIES[i].epfd != epfd {
            i += 1;
            continue;
        }
        let fd = EPOLL_ENTRIES[i].fd;
        let wanted = EPOLL_ENTRIES[i].events;
        let data = EPOLL_ENTRIES[i].data;

        if fd >= 0 && fd < MAX_FDS as i32 {
            let fd_type = vm.fd_table[fd as usize].fd_type;

            if fd_type == FD_TYPE_SOCKET {
                let slot = vm.fd_table[fd as usize].host_fd as usize;
                if slot < MAX_SOCKETS {
                    let mut ready = 0u32;
                    let s = &SOCKETS[slot];

                    // EPOLLIN: data available or accept pending
                    if wanted & EPOLLIN != 0 {
                        if s.state == SOCK_LISTENING {
                            if s.accept_tail > s.accept_head {
                                ready |= EPOLLIN;
                            }
                        } else if s.state == SOCK_CONNECTED || s.state == SOCK_SHUTDOWN {
                            if s.recv_tail > s.recv_head {
                                ready |= EPOLLIN;
                            }
                            // Peer closed → readable (returns 0 = EOF)
                            if s.peer_idx >= 0 && (s.peer_idx as usize) < MAX_SOCKETS
                                && SOCKETS[s.peer_idx as usize].state == SOCK_FREE
                            {
                                ready |= EPOLLIN | EPOLLHUP;
                            }
                        }
                    }

                    // EPOLLOUT: can write (peer has buffer space)
                    if wanted & EPOLLOUT != 0 {
                        if s.state == SOCK_CONNECTED {
                            if s.peer_idx >= 0 && (s.peer_idx as usize) < MAX_SOCKETS {
                                let peer = &SOCKETS[s.peer_idx as usize];
                                let used = peer.recv_tail - peer.recv_head;
                                if (used as usize) < SOCK_BUF_SIZE {
                                    ready |= EPOLLOUT;
                                }
                            }
                        }
                    }

                    if ready != 0 {
                        // RISC-V epoll_event: 16 bytes { u32 events; u32 _pad; u64 data; }
                        let off = events_buf + (count as u64) * 16;
                        mem::write_u32(vm.ram_base, off, ready);
                        mem::write_u32(vm.ram_base, off + 4, 0); // padding
                        mem::write_u64(vm.ram_base, off + 8, data);
                        count += 1;
                    }
                }
            } else if fd_type == FD_TYPE_EVENTFD {
                // eventfd: readable when per-fd counter > 0
                let efd_slot = vm.fd_table[fd as usize].host_fd as usize;
                if wanted & EPOLLIN != 0 && efd_slot < MAX_EVENTFDS && EVENTFD_COUNTERS[efd_slot] > 0 {
                    let off = events_buf + (count as u64) * 16;
                    mem::write_u32(vm.ram_base, off, EPOLLIN);
                    mem::write_u32(vm.ram_base, off + 4, 0);
                    mem::write_u64(vm.ram_base, off + 8, data);
                    count += 1;
                }
            } else if fd_type == FD_TYPE_TIMERFD {
                // timerfd: readable when expiry time has passed
                let tfd_slot = vm.fd_table[fd as usize].host_fd as usize;
                if wanted & EPOLLIN != 0 && tfd_slot < MAX_TIMERFDS {
                    let expiry = TIMERFD_EXPIRY_MS[tfd_slot];
                    if expiry > 0.0 {
                        let now = host::emscripten_date_now();
                        if now >= expiry {
                            // Timer fired — report readable
                            let off = events_buf + (count as u64) * 16;
                            mem::write_u32(vm.ram_base, off, EPOLLIN);
                            mem::write_u32(vm.ram_base, off + 4, 0);
                            mem::write_u64(vm.ram_base, off + 8, data);
                            count += 1;

                            // Re-arm if interval, otherwise disarm
                            let interval = TIMERFD_INTERVAL_MS[tfd_slot];
                            if interval > 0.0 {
                                TIMERFD_EXPIRY_MS[tfd_slot] = now + interval;
                            } else {
                                TIMERFD_EXPIRY_MS[tfd_slot] = 0.0;
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }

    if count > 0 {
        return count as i64;
    }

    // No events found — context-switch to let other threads run.
    if timeout != 0 {
        let current_slot = vm._tid_extra as usize;
        // Only switch to a thread that can make progress (RUNNABLE or an
        // epoll thread with ready events) — NOT another eventless epoll thread
        // (that just ping-pongs node's two idle event-loop threads at 100% CPU).
        let target = find_runnable(vm, current_slot, false);
        if target >= 0 {
            let target = target as usize;
            log_switch(current_slot, target, 2); // 2=epoll_wait
            save_thread(vm, current_slot);
            let p = tctx_ptr(vm, current_slot);
            if timeout == -1 {
                // Infinite timeout: return -EINTR so libuv retries.
                // libuv's contract: nfds==0 not allowed for timeout==-1.
                let eintr = (-4i64) as u64;
                core::ptr::write_unaligned(p.add(TCTX_X + 80) as *mut u64, eintr);
            } else {
                // Finite timeout: return 0 (timeout expired).
                // This lets the event loop advance to process callbacks/timers.
                core::ptr::write_unaligned(p.add(TCTX_X + 80) as *mut u64, 0u64);
            }
            set_tstate(vm, current_slot, TSTATE_EPOLL_WAIT);
            if timeout > 0 {
                EPOLL_FINITE_TIMEOUT_ACTIVE = true;
            }

            load_thread(vm, target);
            if get_tstate(vm, target) == TSTATE_FUTEX_WAIT {
                vm.x[10] = 0;
            }
            set_tstate(vm, target, TSTATE_UNUSED);
            vm._tid_extra = target as i32;
            return vm.x[10] as i64;
        }
        // No thread can make progress: the whole VM is idle (every other thread
        // is futex-wait or eventless epoll-wait). Yield to the host so it parks
        // and real time advances (libuv timers) or a connection / stdin can wake
        // us. Park for ANY timeout, infinite included — spinning while everything
        // is blocked achieves nothing, and gating on this whole-VM-idle condition
        // is what avoids stalling V8 init: during init some thread is RUNNABLE, so
        // find_runnable returns it above and we switch instead of parking.
        EPOLL_BLOCKED_TIMEOUT_MS = timeout;
        vm.status = STATUS_EPOLL_BLOCKED;
        return 0; // host will set a0 to -EINTR before resuming
    }
    0 // Return 0 events
}

/// Take a slot from a (free-mask, high-water) slot allocator, or -1 if full.
unsafe fn alloc_slot(free: *mut u32, alloc: *mut usize, max: usize) -> i32 {
    if *free != 0 {
        let s = (*free).trailing_zeros();
        *free &= !(1 << s);
        return s as i32;
    }
    if *alloc >= max {
        return -1;
    }
    *alloc += 1;
    (*alloc - 1) as i32
}

unsafe fn sys_eventfd2(vm: &mut Vm, initval: u32, flags: i32) -> i64 {
    // Pick the fd first so a full fd table can't leak a counter slot.
    let fd = lowest_free_fd(vm, 0);
    if fd < 0 {
        return fd;
    }
    let slot = alloc_slot(
        core::ptr::addr_of_mut!(EVENTFD_FREE),
        core::ptr::addr_of_mut!(EVENTFD_ALLOC),
        MAX_EVENTFDS,
    );
    if slot < 0 {
        return EMFILE;
    }
    EVENTFD_COUNTERS[slot as usize] = initval;
    let fdf = if flags & O_CLOEXEC != 0 { FD_CLOEXEC } else { 0 };
    vm.fd_table[fd as usize] = FdEntry { fd_type: FD_TYPE_EVENTFD, host_fd: slot, offset: 0, flags: flags & O_NONBLOCK, fd_flags: fdf };
    fd
}

unsafe fn sys_prlimit64(
    vm: &mut Vm,
    _pid: i32,
    resource: i32,
    _new_limit: u64,
    old_limit: u64,
) -> i64 {
    if old_limit != 0 {
        // Return generous defaults
        match resource {
            7 => {
                // RLIMIT_NOFILE
                mem::write_u64(vm.ram_base, old_limit, 1024);
                mem::write_u64(vm.ram_base, old_limit + 8, 1024);
            }
            3 => {
                // RLIMIT_STACK
                mem::write_u64(vm.ram_base, old_limit, 8 * 1024 * 1024);
                mem::write_u64(vm.ram_base, old_limit + 8, u64::MAX);
            }
            _ => {
                mem::write_u64(vm.ram_base, old_limit, u64::MAX);
                mem::write_u64(vm.ram_base, old_limit + 8, u64::MAX);
            }
        }
    }
    0
}

unsafe fn sys_sysinfo(vm: &mut Vm, info: u64) -> i64 {
    // Zero the struct (112 bytes)
    mem::zero_mem(vm.ram_base, info, 112);
    // uptime
    let ms = host::emscripten_date_now();
    let uptime = (ms / 1000.0) as u64;
    mem::write_u64(vm.ram_base, info, uptime);
    // totalram - report actual RAM size
    mem::write_u64(vm.ram_base, info + 32, vm.ram_size as u64);
    // freeram - report ~half as free
    mem::write_u64(vm.ram_base, info + 40, (vm.ram_size / 2) as u64);
    // procs
    mem::write_u16(vm.ram_base, info + 86, 1);
    // mem_unit
    mem::write_u32(vm.ram_base, info + 88, 1);
    0
}

unsafe fn sys_timerfd_create(vm: &mut Vm, flags: i32) -> i64 {
    let fd = lowest_free_fd(vm, 0);
    if fd < 0 {
        return fd;
    }
    let slot = alloc_slot(
        core::ptr::addr_of_mut!(TIMERFD_FREE),
        core::ptr::addr_of_mut!(TIMERFD_ALLOC),
        MAX_TIMERFDS,
    );
    if slot < 0 {
        return EMFILE;
    }
    TIMERFD_EXPIRY_MS[slot as usize] = 0.0; // disarmed
    TIMERFD_INTERVAL_MS[slot as usize] = 0.0;
    let fdf = if flags & O_CLOEXEC != 0 { FD_CLOEXEC } else { 0 };
    vm.fd_table[fd as usize] = FdEntry { fd_type: FD_TYPE_TIMERFD, host_fd: slot, offset: 0, flags: flags & O_NONBLOCK, fd_flags: fdf };
    fd
}

unsafe fn sys_timerfd_settime(
    vm: &mut Vm,
    fd: i32,
    flags: i32,
    new_value: u64,
    _old_value: u64,
) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EINVAL;
    }
    if vm.fd_table[fd as usize].fd_type != FD_TYPE_TIMERFD {
        return EINVAL;
    }
    let tfd_slot = vm.fd_table[fd as usize].host_fd as usize;
    if tfd_slot >= MAX_TIMERFDS {
        return EINVAL;
    }

    // struct itimerspec { struct timespec it_interval; struct timespec it_value; }
    // Each timespec: { i64 tv_sec; i64 tv_nsec; } = 16 bytes
    // it_interval at offset 0, it_value at offset 16
    let interval_sec = mem::read_u64(vm.ram_base, new_value) as i64;
    let interval_nsec = mem::read_u64(vm.ram_base, new_value + 8) as i64;
    let value_sec = mem::read_u64(vm.ram_base, new_value + 16) as i64;
    let value_nsec = mem::read_u64(vm.ram_base, new_value + 24) as i64;

    let interval_ms = (interval_sec as f64) * 1000.0 + (interval_nsec as f64) / 1_000_000.0;
    let value_ms = (value_sec as f64) * 1000.0 + (value_nsec as f64) / 1_000_000.0;

    TIMERFD_INTERVAL_MS[tfd_slot] = interval_ms;

    if value_ms == 0.0 {
        // Disarm
        TIMERFD_EXPIRY_MS[tfd_slot] = 0.0;
    } else if flags & 1 != 0 {
        // TFD_TIMER_ABSTIME: value is absolute (CLOCK_MONOTONIC or CLOCK_REALTIME)
        // Convert seconds since epoch to ms
        TIMERFD_EXPIRY_MS[tfd_slot] = value_ms;
    } else {
        // Relative: expiry = now + value
        let now = host::emscripten_date_now();
        TIMERFD_EXPIRY_MS[tfd_slot] = now + value_ms;
    }

    0
}

unsafe fn sys_sched_getaffinity(vm: &mut Vm, cpusetsize: u32, mask: u64) -> i64 {
    if cpusetsize == 0 || mask == 0 {
        return EINVAL;
    }
    let size = if cpusetsize > 128 { 128 } else { cpusetsize };
    mem::zero_mem(vm.ram_base, mask, size as usize);
    // Single CPU: set bit 0
    mem::write_u8(vm.ram_base, mask, 1);
    8 // return number of bytes written
}

// ============================================================
// Socket syscall implementations
// ============================================================

unsafe fn find_free_socket() -> i32 {
    let mut i = 0;
    while i < MAX_SOCKETS {
        if SOCKETS[i].state == SOCK_FREE {
            return i as i32;
        }
        i += 1;
    }
    -1
}

unsafe fn find_free_fd(vm: &mut Vm) -> i32 {
    let mut i = 3; // skip stdin/stdout/stderr
    while i < MAX_FDS {
        if vm.fd_table[i].fd_type == FD_TYPE_NONE {
            return i as i32;
        }
        i += 1;
    }
    -24 // EMFILE
}

unsafe fn get_socket_slot(vm: &Vm, fd: i32) -> i32 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return -1;
    }
    if vm.fd_table[fd as usize].fd_type != FD_TYPE_SOCKET {
        return -1;
    }
    let slot = vm.fd_table[fd as usize].host_fd;
    if slot < 0 || slot >= MAX_SOCKETS as i32 {
        return -1;
    }
    slot
}

/// Check if any socket is in LISTENING state.
unsafe fn has_listening_socket() -> bool {
    let mut i = 0;
    while i < MAX_SOCKETS {
        if SOCKETS[i].state == SOCK_LISTENING {
            return true;
        }
        i += 1;
    }
    false
}



unsafe fn find_listener(port: u16) -> i32 {
    let mut i = 0;
    while i < MAX_SOCKETS {
        if SOCKETS[i].state == SOCK_LISTENING && SOCKETS[i].local_port == port {
            return i as i32;
        }
        i += 1;
    }
    -1
}

unsafe fn sys_socket(vm: &mut Vm, domain: i32, sock_type: i32, _proto: i32) -> i64 {
    // Only support AF_INET (2) and AF_INET6 (10)
    if domain != 2 && domain != 10 {
        return EAFNOSUPPORT;
    }

    let base_type = sock_type & 0xFF;
    let nonblock = (sock_type & 0x800) != 0; // SOCK_NONBLOCK

    // Only support SOCK_STREAM (1) and SOCK_DGRAM (2)
    if base_type != 1 && base_type != 2 {
        return ENOSYS;
    }

    let slot = find_free_socket();
    if slot < 0 {
        return ENOMEM;
    }
    let slot = slot as usize;

    let fd = find_free_fd(vm);
    if fd < 0 {
        return fd as i64;
    }

    SOCKETS[slot] = EMPTY_SOCKET;
    SOCKETS[slot].state = SOCK_CREATED;
    SOCKETS[slot].nonblock = if nonblock { 1 } else { 0 };
    SOCKETS[slot].guest_fd = fd;

    vm.fd_table[fd as usize].fd_type = FD_TYPE_SOCKET;
    vm.fd_table[fd as usize].host_fd = slot as i32;
    vm.fd_table[fd as usize].flags = if nonblock { 0x800 } else { 0 }; // O_NONBLOCK
    vm.fd_table[fd as usize].fd_flags = if sock_type & O_CLOEXEC != 0 { FD_CLOEXEC } else { 0 };

    fd as i64
}

unsafe fn sys_bind(vm: &mut Vm, fd: i32, addr: u64, _addrlen: u32) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }
    let slot = slot as usize;

    // Read sockaddr_in: family(2) + port(2, big-endian) + addr(4)
    let port_be = mem::read_u16(vm.ram_base, addr + 2);
    let port = ((port_be >> 8) & 0xFF) | ((port_be & 0xFF) << 8); // swap bytes

    SOCKETS[slot].local_port = port;
    SOCKETS[slot].state = SOCK_BOUND;
    0
}

unsafe fn sys_listen(vm: &mut Vm, fd: i32, _backlog: i32) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }

    SOCKETS[slot as usize].state = SOCK_LISTENING;
    0
}

unsafe fn sys_connect(vm: &mut Vm, fd: i32, addr: u64, _addrlen: u32) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }
    let slot = slot as usize;

    // Read target port from sockaddr_in
    let port_be = mem::read_u16(vm.ram_base, addr + 2);
    let port = ((port_be >> 8) & 0xFF) | ((port_be & 0xFF) << 8);

    // Find a listening socket on this port
    let listener = find_listener(port);
    if listener < 0 {
        return ECONNREFUSED;
    }
    let listener = listener as usize;

    // Create a server-side socket for this connection
    let server_slot = find_free_socket();
    if server_slot < 0 {
        return ENOMEM;
    }
    let server_slot = server_slot as usize;

    // Initialize server-side socket (no guest FD yet — accept4 assigns it)
    SOCKETS[server_slot] = EMPTY_SOCKET;
    SOCKETS[server_slot].state = SOCK_CONNECTED;
    SOCKETS[server_slot].peer_idx = slot as i32;
    SOCKETS[server_slot].local_port = port;
    SOCKETS[server_slot].guest_fd = -1;

    // Connect client to server
    SOCKETS[slot].state = SOCK_CONNECTED;
    SOCKETS[slot].peer_idx = server_slot as i32;

    // Add server-side socket to listener's accept queue
    let tail = SOCKETS[listener].accept_tail as usize;
    SOCKETS[listener].accept_queue[tail % ACCEPT_QUEUE_SIZE] = server_slot as i32;
    SOCKETS[listener].accept_tail += 1;

    // Wake epoll-waiting threads so they can see the new connection
    wake_epoll_threads(vm);

    // Non-blocking: return EINPROGRESS (libuv expects this for async connect)
    if SOCKETS[slot].nonblock != 0 {
        return EINPROGRESS;
    }
    0
}

unsafe fn sys_accept4(vm: &mut Vm, fd: i32, addr: u64, addrlen: u64, flags: i32) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }
    let slot = slot as usize;

    if SOCKETS[slot].state != SOCK_LISTENING {
        return EINVAL;
    }

    // Check accept queue
    if SOCKETS[slot].accept_head >= SOCKETS[slot].accept_tail {
        return EAGAIN; // no pending connections
    }

    // Pop from accept queue
    let head = SOCKETS[slot].accept_head as usize;
    let server_sock_idx = SOCKETS[slot].accept_queue[head % ACCEPT_QUEUE_SIZE] as usize;
    SOCKETS[slot].accept_head += 1;

    // Allocate guest FD for the accepted socket
    let new_fd = find_free_fd(vm);
    if new_fd < 0 {
        return new_fd as i64;
    }

    let nonblock = (flags & 0x800) != 0; // SOCK_NONBLOCK
    SOCKETS[server_sock_idx].guest_fd = new_fd;
    SOCKETS[server_sock_idx].nonblock = if nonblock { 1 } else { 0 };

    vm.fd_table[new_fd as usize].fd_type = FD_TYPE_SOCKET;
    vm.fd_table[new_fd as usize].host_fd = server_sock_idx as i32;
    vm.fd_table[new_fd as usize].flags = if nonblock { 0x800 } else { 0 };
    vm.fd_table[new_fd as usize].fd_flags = if flags & O_CLOEXEC != 0 { FD_CLOEXEC } else { 0 };

    // Write peer address if requested
    if addr != 0 {
        mem::write_u16(vm.ram_base, addr, 2); // AF_INET
        let port = SOCKETS[server_sock_idx].local_port;
        let port_be = ((port >> 8) & 0xFF) | ((port & 0xFF) << 8);
        mem::write_u16(vm.ram_base, addr + 2, port_be);
        mem::write_u32(vm.ram_base, addr + 4, 0x0100007Fu32); // 127.0.0.1 in network byte order
        mem::write_u64(vm.ram_base, addr + 8, 0); // sin_zero
        if addrlen != 0 {
            mem::write_u32(vm.ram_base, addrlen, 16);
        }
    }

    new_fd as i64
}

unsafe fn sys_getsockname(vm: &mut Vm, fd: i32, addr: u64, addrlen: u64) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }
    let slot = slot as usize;

    if addr != 0 {
        mem::write_u16(vm.ram_base, addr, 2); // AF_INET
        let port = SOCKETS[slot].local_port;
        let port_be = ((port >> 8) & 0xFF) | ((port & 0xFF) << 8);
        mem::write_u16(vm.ram_base, addr + 2, port_be);
        mem::write_u32(vm.ram_base, addr + 4, 0x0100007Fu32); // 127.0.0.1
        mem::write_u64(vm.ram_base, addr + 8, 0);
    }
    if addrlen != 0 {
        mem::write_u32(vm.ram_base, addrlen, 16);
    }
    0
}

unsafe fn sys_getpeername(vm: &mut Vm, fd: i32, addr: u64, addrlen: u64) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }
    let slot = slot as usize;

    if SOCKETS[slot].state != SOCK_CONNECTED {
        return ENOTCONN;
    }

    if addr != 0 {
        let peer = SOCKETS[slot].peer_idx as usize;
        let port = if peer < MAX_SOCKETS { SOCKETS[peer].local_port } else { 0 };
        mem::write_u16(vm.ram_base, addr, 2);
        let port_be = ((port >> 8) & 0xFF) | ((port & 0xFF) << 8);
        mem::write_u16(vm.ram_base, addr + 2, port_be);
        mem::write_u32(vm.ram_base, addr + 4, 0x0100007Fu32);
        mem::write_u64(vm.ram_base, addr + 8, 0);
    }
    if addrlen != 0 {
        mem::write_u32(vm.ram_base, addrlen, 16);
    }
    0
}

unsafe fn sys_getsockopt(vm: &mut Vm, fd: i32, _level: i32, optname: i32, optval: u64, optlen: u64) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }

    // SO_ERROR (4) — return 0 (no error, connection succeeded)
    if optname == 4 {
        if optval != 0 {
            mem::write_u32(vm.ram_base, optval, 0);
        }
        if optlen != 0 {
            mem::write_u32(vm.ram_base, optlen, 4);
        }
        return 0;
    }
    // Default: return 0 in optval
    if optval != 0 {
        mem::write_u32(vm.ram_base, optval, 0);
    }
    if optlen != 0 {
        mem::write_u32(vm.ram_base, optlen, 4);
    }
    0
}

unsafe fn sys_shutdown(vm: &mut Vm, fd: i32, _how: i32) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }
    SOCKETS[slot as usize].state = SOCK_SHUTDOWN;
    // Wake epoll threads so peer sees the shutdown
    wake_epoll_threads(vm);
    0
}

unsafe fn sys_sendto(vm: &mut Vm, fd: i32, buf: u64, count: u32, _flags: i32) -> i64 {
    sock_write(vm, fd, buf, count)
}

unsafe fn sys_recvfrom(vm: &mut Vm, fd: i32, buf: u64, count: u32, _flags: i32) -> i64 {
    sock_read(vm, fd, buf, count)
}

/// Read from socket recv buffer
unsafe fn sock_read(vm: &mut Vm, fd: i32, buf: u64, count: u32) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }
    let slot = slot as usize;

    if SOCKETS[slot].state != SOCK_CONNECTED && SOCKETS[slot].state != SOCK_SHUTDOWN {
        return ENOTCONN;
    }

    let available = (SOCKETS[slot].recv_tail - SOCKETS[slot].recv_head) as usize;
    if available == 0 {
        // Check if peer has closed
        let peer = SOCKETS[slot].peer_idx;
        if peer < 0 || (peer as usize) >= MAX_SOCKETS
            || SOCKETS[peer as usize].state == SOCK_FREE
            || SOCKETS[peer as usize].state == SOCK_SHUTDOWN
        {
            return 0; // EOF
        }
        if vm.fd_table[fd as usize].flags & 0x800 != 0 {
            return EAGAIN;
        }
        return 0; // no data, non-blocking returns EAGAIN, blocking returns 0
    }

    let to_read = if (count as usize) < available { count as usize } else { available };
    let head = SOCKETS[slot].recv_head as usize;
    let mut i = 0;
    while i < to_read {
        let idx = (head + i) % SOCK_BUF_SIZE;
        mem::write_u8(vm.ram_base, buf + i as u64, SOCKETS[slot].recv_buf[idx]);
        i += 1;
    }
    SOCKETS[slot].recv_head += to_read as u32;
    to_read as i64
}

/// Write to peer's recv buffer
unsafe fn sock_write(vm: &mut Vm, fd: i32, buf: u64, count: u32) -> i64 {
    let slot = get_socket_slot(vm, fd);
    if slot < 0 {
        return EBADF;
    }
    let slot = slot as usize;

    if SOCKETS[slot].state != SOCK_CONNECTED {
        return ENOTCONN;
    }

    let peer = SOCKETS[slot].peer_idx;
    if peer < 0 || (peer as usize) >= MAX_SOCKETS {
        return ENOTCONN;
    }
    let peer = peer as usize;

    let used = (SOCKETS[peer].recv_tail - SOCKETS[peer].recv_head) as usize;
    let space = SOCK_BUF_SIZE - used;
    if space == 0 {
        if vm.fd_table[fd as usize].flags & 0x800 != 0 {
            return EAGAIN;
        }
        return EAGAIN; // buffer full
    }

    let to_write = if (count as usize) < space { count as usize } else { space };
    let tail = SOCKETS[peer].recv_tail as usize;
    let mut i = 0;
    while i < to_write {
        let idx = (tail + i) % SOCK_BUF_SIZE;
        SOCKETS[peer].recv_buf[idx] = mem::read_u8(vm.ram_base, buf + i as u64);
        i += 1;
    }
    SOCKETS[peer].recv_tail += to_write as u32;

    // Wake epoll-waiting threads so they can see the new data
    wake_epoll_threads(vm);

    to_write as i64
}

/// capget(header_ptr, data_ptr) — return root capabilities
unsafe fn sys_capget(vm: &mut Vm, header: u64, data: u64) -> i64 {
    // struct __user_cap_header_struct { __u32 version; int pid; }
    // Version 3 (VFS_CAP_REVISION_2): _LINUX_CAPABILITY_VERSION_3 = 0x20080522
    if header != 0 {
        mem::write_u32(vm.ram_base, header, 0x20080522); // version
        // pid stays as-is
    }
    // struct __user_cap_data_struct { __u32 effective; __u32 permitted; __u32 inheritable; }
    // Version 3 has 2 data structs (64-bit capability sets)
    if data != 0 {
        // Grant all capabilities (running as root)
        mem::write_u32(vm.ram_base, data, 0xFFFFFFFF);      // effective[0]
        mem::write_u32(vm.ram_base, data + 4, 0xFFFFFFFF);   // permitted[0]
        mem::write_u32(vm.ram_base, data + 8, 0);             // inheritable[0]
        mem::write_u32(vm.ram_base, data + 12, 0xFFFFFFFF);   // effective[1]
        mem::write_u32(vm.ram_base, data + 16, 0xFFFFFFFF);   // permitted[1]
        mem::write_u32(vm.ram_base, data + 20, 0);             // inheritable[1]
    }
    0
}

// ============================================================
// Virtual Server — inject HTTP connections from JS host
// ============================================================

/// Inject a TCP connection to a listening socket on `port`.
/// `req_ptr` points to raw HTTP request bytes in WASM linear memory.
/// Returns a connection ID (client socket index) for reading the response,
/// or -1 on error.
pub unsafe fn inject_connection(vm: &mut Vm, port: u16, req_ptr: u32, req_len: u32) -> i32 {
    // Find the listening socket on this port
    let mut listen_idx: i32 = -1;
    let mut i = 0;
    while i < MAX_SOCKETS {
        if SOCKETS[i].state == SOCK_LISTENING && SOCKETS[i].local_port == port {
            listen_idx = i as i32;
            break;
        }
        i += 1;
    }
    if listen_idx < 0 {
        return -1; // no server listening on this port
    }

    // Allocate server-side socket (what accept() returns to the server)
    let server_idx = find_free_socket();
    if server_idx < 0 {
        return -2; // out of socket slots
    }
    let si = server_idx as usize;

    // Mark as non-FREE so the next find_free_socket() won't return the same slot
    SOCKETS[si].state = SOCK_CONNECTED;

    // Allocate client-side socket (our virtual client, for collecting the response)
    let client_idx = find_free_socket();
    if client_idx < 0 {
        SOCKETS[si].state = SOCK_FREE;
        return -2;
    }
    let ci = client_idx as usize;

    // Set up the connected pair
    SOCKETS[si].state = SOCK_CONNECTED;
    SOCKETS[si].peer_idx = client_idx;
    SOCKETS[si].local_port = port;
    SOCKETS[si].guest_fd = -1; // assigned by accept4

    SOCKETS[ci].state = SOCK_CONNECTED;
    SOCKETS[ci].peer_idx = server_idx;
    SOCKETS[ci].local_port = 0;
    SOCKETS[ci].guest_fd = -1;
    SOCKETS[ci].recv_head = 0;
    SOCKETS[ci].recv_tail = 0;

    // Write request bytes into server-side recv buffer
    // (this is what the server will read after accept())
    let len = if (req_len as usize) < SOCK_BUF_SIZE { req_len as usize } else { SOCK_BUF_SIZE };
    let src = req_ptr as *const u8;
    let mut j = 0;
    while j < len {
        SOCKETS[si].recv_buf[j] = *src.add(j);
        j += 1;
    }
    SOCKETS[si].recv_head = 0;
    SOCKETS[si].recv_tail = len as u32;

    // Push server_idx onto the listening socket's accept queue
    let li = listen_idx as usize;
    let qt = (SOCKETS[li].accept_tail as usize) % ACCEPT_QUEUE_SIZE;
    SOCKETS[li].accept_queue[qt] = server_idx;
    SOCKETS[li].accept_tail += 1;

    // Wake any thread blocked in epoll_pwait so it picks up the new connection
    wake_epoll_threads(vm);

    client_idx // return client socket index as connection ID
}

/// Read response bytes from a virtual connection.
/// `conn_id` is the value returned by `inject_connection`.
/// Copies response data from client-side recv buffer into `dst_ptr` in WASM memory.
/// Returns bytes copied, 0 if nothing yet, -1 if connection closed (response complete).
pub unsafe fn read_response(conn_id: i32, dst_ptr: u32, dst_len: u32) -> i32 {
    if conn_id < 0 || (conn_id as usize) >= MAX_SOCKETS {
        return -1;
    }
    let ci = conn_id as usize;
    if SOCKETS[ci].state == SOCK_FREE {
        return -1;
    }

    let available = (SOCKETS[ci].recv_tail - SOCKETS[ci].recv_head) as usize;
    if available == 0 {
        // Check if server has closed its end (response complete)
        let peer = SOCKETS[ci].peer_idx;
        if peer < 0 || (peer as usize) >= MAX_SOCKETS
            || SOCKETS[peer as usize].state == SOCK_FREE
            || SOCKETS[peer as usize].state == SOCK_SHUTDOWN
        {
            return -1; // done
        }
        return 0; // still waiting
    }

    let to_read = if (dst_len as usize) < available { dst_len as usize } else { available };
    let head = SOCKETS[ci].recv_head as usize;
    let dst = dst_ptr as *mut u8;
    let mut j = 0;
    while j < to_read {
        let idx = (head + j) % SOCK_BUF_SIZE;
        *dst.add(j) = SOCKETS[ci].recv_buf[idx];
        j += 1;
    }
    SOCKETS[ci].recv_head += to_read as u32;
    to_read as i32
}

/// Close the client side of a virtual connection and free both socket slots.
pub unsafe fn close_connection(conn_id: i32) {
    if conn_id < 0 || (conn_id as usize) >= MAX_SOCKETS {
        return;
    }
    let ci = conn_id as usize;
    let peer = SOCKETS[ci].peer_idx;

    // Mark client side as shutdown so server sees EOF on write
    SOCKETS[ci].state = SOCK_SHUTDOWN;

    // Also mark the server side so it sees EPOLLHUP
    if peer >= 0 && (peer as usize) < MAX_SOCKETS {
        if SOCKETS[peer as usize].state == SOCK_CONNECTED {
            SOCKETS[peer as usize].state = SOCK_SHUTDOWN;
        }
    }
}
