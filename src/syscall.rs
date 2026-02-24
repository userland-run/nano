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

// ============================================================
// Timerfd state — stores expiry time in ms (from emscripten_date_now)
// ============================================================

const MAX_TIMERFDS: usize = 16;
/// Absolute expiry time in ms (0.0 = disarmed)
static mut TIMERFD_EXPIRY_MS: [f64; MAX_TIMERFDS] = [0.0; MAX_TIMERFDS];
/// Interval in ms for repeating timers (0.0 = one-shot)
static mut TIMERFD_INTERVAL_MS: [f64; MAX_TIMERFDS] = [0.0; MAX_TIMERFDS];
static mut TIMERFD_ALLOC: usize = 0;

/// Hint for find_runnable: set when any thread enters EPOLL_WAIT with a
/// finite positive timeout (e.g. libuv timer). Tells find_runnable to wake
/// epoll_wait threads so the event loop can yield to the host for real time
/// to advance.
static mut EPOLL_FINITE_TIMEOUT_ACTIVE: bool = false;

// ioctl constants
const TIOCGWINSZ: u64 = 0x5413;
const TCGETS: u64 = 0x5401;
const FIONREAD: u64 = 0x541B;

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
    EPOLL_FINITE_TIMEOUT_ACTIVE = false;
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
            sys_fs_request_rename(vm, a0 as i32, a1, a2 as i32, a3);
            return;
        }
        SYS_STATX => {
            sys_fs_request(vm, SYS_STATX as i32, a0 as i32, a1, a2 as i64, a4 as i64);
            return;
        }

        SYS_GETCWD => sys_getcwd(vm, a0, a1 as u32),
        SYS_CHDIR => sys_chdir(vm, a0),

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

        SYS_RT_SIGACTION => 0,   // stub
        SYS_RT_SIGPROCMASK => 0, // stub
        SYS_SIGALTSTACK => sys_sigaltstack(vm, a0, a1),
        SYS_KILL | SYS_TKILL | SYS_TGKILL => 0, // stub: signals ignored

        SYS_SET_TID_ADDRESS => {
            let slot = vm._tid_extra as usize;
            vm.thread_ctids[slot] = a0;
            vm.thread_tids[slot] as i64
        }
        SYS_SET_ROBUST_LIST => 0, // stub
        SYS_FUTEX => sys_futex(vm, a0, a1 as i32, a2 as u32, a3, a4),
        SYS_CLONE => sys_clone(vm, a0, a1, a2, a3, a4),

        SYS_DUP => sys_dup(vm, a0 as i32),
        SYS_DUP3 => sys_dup3(vm, a0 as i32, a1 as i32),
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
        SYS_TIMERFD_CREATE => sys_timerfd_create(vm),
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

        _ => {
            // Unknown syscall - return ENOSYS
            ENOSYS
        }
    };

    vm.x[10] = result as u64;
}

// --- Direct syscall implementations ---

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

    // Zero new memory if expanding
    if new_brk > old_brk {
        mem::zero_mem(vm.ram_base, old_brk, (new_brk - old_brk) as usize);
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
    let len = (length + PAGE_SIZE - 1) & PAGE_MASK;

    // MAP_ANONYMOUS (0x20)
    let is_anon = flags & 0x20 != 0;
    // MAP_FIXED (0x10)
    let is_fixed = flags & 0x10 != 0;

    let ram_limit = vm.ram_size as u64;

    let guest_addr = if is_fixed && addr != 0 {
        // MAP_FIXED: must use the exact address
        addr
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
    };

    // Check bounds for MAP_FIXED
    let end = guest_addr + len;
    if end > ram_limit {
        return ENOMEM;
    }

    // Zero the region for anonymous mappings
    if is_anon {
        mem::zero_mem(vm.ram_base, guest_addr, len as usize);
    }

    // Record in mmap table
    let idx = vm.mmap_count as usize;
    if idx < MAX_MMAP_REGIONS {
        vm.mmap_entries[idx] = MmapEntry {
            guest_addr,
            length: len,
            prot: prot as i32,
            flags: flags as i32,
            offset,
        };
        vm.mmap_count += 1;
    }

    guest_addr as i64
}

unsafe fn sys_munmap(vm: &mut Vm, _addr: u64, _length: u64) -> i64 {
    // Stub: we don't actually free memory in the bump allocator
    0
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

unsafe fn sys_write(vm: &mut Vm, fd: i32, buf: u64, count: u32) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    let fd_type = vm.fd_table[fd as usize].fd_type;

    match fd_type {
        FD_TYPE_STDOUT | FD_TYPE_STDERR => {
            // Write directly to console
            let ptr = (vm.ram_base + buf as u32) as i32;
            host::console_write(fd, ptr, count as i32);
            count as i64
        }
        FD_TYPE_DEVNULL => count as i64,
        FD_TYPE_FILE | FD_TYPE_PIPE => {
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
        FD_TYPE_STDIN | FD_TYPE_FILE | FD_TYPE_PIPE => {
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

unsafe fn sys_close(vm: &mut Vm, fd: i32) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }
    let fd_type = vm.fd_table[fd as usize].fd_type;
    if fd_type == FD_TYPE_NONE {
        return EBADF;
    }

    // For file-backed FDs, notify host
    if fd_type == FD_TYPE_FILE || fd_type == FD_TYPE_DIR {
        sys_fs_request(vm, SYS_CLOSE as i32, fd, 0, 0, 0);
        return 0; // status set by fs_request
    }

    // For sockets, clean up socket slot
    if fd_type == FD_TYPE_SOCKET {
        let slot = vm.fd_table[fd as usize].host_fd as usize;
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

    vm.fd_table[fd as usize].fd_type = FD_TYPE_NONE;
    vm.fd_table[fd as usize].host_fd = -1;
    0
}

/// Set up a FS request and switch to FS_PENDING status.
/// The JS host will process the request and resume.
unsafe fn sys_fs_request(
    vm: &mut Vm,
    syscall_nr: i32,
    fd: i32,
    path_addr: u64,
    arg1: i64,
    arg2: i64,
) {
    vm.fs_request.syscall_nr = syscall_nr;
    vm.fs_request.fd = fd;
    vm.fs_request.arg1 = arg1;
    vm.fs_request.arg2 = arg2;

    // Copy path if provided (use raw pointer to avoid borrow conflict)
    if path_addr != 0 {
        let base = vm.ram_base;
        let src = (base + path_addr as u32) as *const u8;
        let dst = vm.fs_request.path.as_mut_ptr();
        let max = vm.fs_request.path.len() - 1;
        let mut i = 0;
        while i < max {
            let b = src.add(i).read();
            if b == 0 { break; }
            dst.add(i).write(b);
            i += 1;
        }
        dst.add(i).write(0);
    } else {
        vm.fs_request.path[0] = 0;
    }

    vm.status = STATUS_FS_PENDING;
}

unsafe fn sys_fs_request_rename(
    vm: &mut Vm,
    old_dirfd: i32,
    old_path_addr: u64,
    _new_dirfd: i32,
    new_path_addr: u64,
) {
    vm.fs_request.syscall_nr = SYS_RENAMEAT2 as i32;
    vm.fs_request.fd = old_dirfd;

    let base = vm.ram_base;

    // Copy old path
    if old_path_addr != 0 {
        let src = (base + old_path_addr as u32) as *const u8;
        let dst = vm.fs_request.path.as_mut_ptr();
        let max = vm.fs_request.path.len() - 1;
        let mut i = 0;
        while i < max {
            let b = src.add(i).read();
            if b == 0 { break; }
            dst.add(i).write(b);
            i += 1;
        }
        dst.add(i).write(0);
    }
    // Copy new path
    if new_path_addr != 0 {
        let src = (base + new_path_addr as u32) as *const u8;
        let dst = vm.fs_request.path2.as_mut_ptr();
        let max = vm.fs_request.path2.len() - 1;
        let mut i = 0;
        while i < max {
            let b = src.add(i).read();
            if b == 0 { break; }
            dst.add(i).write(b);
            i += 1;
        }
        dst.add(i).write(0);
    }

    vm.status = STATUS_FS_PENDING;
}

unsafe fn sys_getcwd(vm: &mut Vm, buf: u64, size: u32) -> i64 {
    let mut len = 0;
    while len < 255 && vm.cwd[len] != 0 {
        len += 1;
    }
    if len + 1 > size as usize {
        return EINVAL;
    }
    mem::write_bytes(vm.ram_base, buf, &vm.cwd[..len + 1]);
    buf as i64
}

unsafe fn sys_chdir(vm: &mut Vm, path_addr: u64) -> i64 {
    let mut buf = [0u8; 256];
    let len = mem::read_cstr(vm.ram_base, path_addr, &mut buf);
    if len >= 256 {
        return EINVAL;
    }
    vm.cwd[..len + 1].copy_from_slice(&buf[..len + 1]);
    0
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
unsafe fn find_runnable(vm: &Vm, exclude: usize) -> i32 {
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
    // Third pass: pick any EPOLL_WAIT thread if there's a listening socket
    // or an active timer wait. This wakes the event loop thread so it can
    // yield to the host for real time to advance (timers) or to accept
    // incoming connections (servers).
    if has_listening_socket() || EPOLL_FINITE_TIMEOUT_ACTIVE {
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
            let target = find_runnable(vm, current_slot);
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

unsafe fn sys_dup(vm: &mut Vm, old_fd: i32) -> i64 {
    if old_fd < 0 || old_fd >= MAX_FDS as i32 {
        return EBADF;
    }
    if vm.fd_table[old_fd as usize].fd_type == FD_TYPE_NONE {
        return EBADF;
    }

    // Find first free fd
    for i in 0..MAX_FDS {
        if vm.fd_table[i].fd_type == FD_TYPE_NONE {
            vm.fd_table[i] = vm.fd_table[old_fd as usize];
            return i as i64;
        }
    }
    -24 // EMFILE
}

unsafe fn sys_dup3(vm: &mut Vm, old_fd: i32, new_fd: i32) -> i64 {
    if old_fd < 0 || old_fd >= MAX_FDS as i32 || new_fd < 0 || new_fd >= MAX_FDS as i32 {
        return EBADF;
    }
    if vm.fd_table[old_fd as usize].fd_type == FD_TYPE_NONE {
        return EBADF;
    }
    vm.fd_table[new_fd as usize] = vm.fd_table[old_fd as usize];
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
        0 => sys_dup(vm, fd),          // F_DUPFD
        1 => {
            // F_GETFD
            vm.fd_table[fd as usize].flags as i64 & 1
        }
        2 => {
            // F_SETFD
            vm.fd_table[fd as usize].flags =
                (vm.fd_table[fd as usize].flags & !1) | (arg as i32 & 1);
            0
        }
        3 => {
            // F_GETFL
            vm.fd_table[fd as usize].flags as i64
        }
        4 => {
            // F_SETFL
            vm.fd_table[fd as usize].flags = arg as i32;
            0
        }
        _ => EINVAL,
    }
}

unsafe fn sys_ioctl(vm: &mut Vm, fd: i32, request: u64) -> i64 {
    if fd < 0 || fd >= MAX_FDS as i32 {
        return EBADF;
    }

    match request {
        TIOCGWINSZ | TCGETS => {
            // Return ENOTTY - our virtual fds are not real terminals.
            // This matches qemu-riscv64 behavior and is critical for V8:
            // when isatty()=true, Node/V8 takes a different init path that crashes.
            -25 // ENOTTY
        }
        FIONREAD => {
            let a2 = vm.x[12];
            mem::write_u32(vm.ram_base, a2, 0);
            0
        }
        _ => -25, // ENOTTY
    }
}

unsafe fn sys_pipe2(vm: &mut Vm, pipefd: u64, _flags: i32) -> i64 {
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
    // Safety: fd0/fd1 come from 0..MAX_FDS loop, guaranteed in bounds
    vm.fd_table.get_unchecked_mut(fd0).fd_type = FD_TYPE_PIPE;
    vm.fd_table.get_unchecked_mut(fd0).host_fd = fds[1]; // read end points to write end
    vm.fd_table.get_unchecked_mut(fd1).fd_type = FD_TYPE_PIPE;
    vm.fd_table.get_unchecked_mut(fd1).host_fd = fds[0]; // write end points to read end

    vm.pipe_read_fd = fds[0];
    vm.pipe_write_fd = fds[1];

    mem::write_u32(vm.ram_base, pipefd, fds[0] as u32);
    mem::write_u32(vm.ram_base, pipefd + 4, fds[1] as u32);
    0
}

unsafe fn sys_ppoll(vm: &mut Vm, _fds: u64, _nfds: u32, _timeout: u64) -> i64 {
    // Stub: return 0 (timeout)
    0
}

unsafe fn sys_epoll_create1(vm: &mut Vm, _flags: i32) -> i64 {
    // Find free fd
    for i in 0..MAX_FDS {
        if vm.fd_table[i].fd_type == FD_TYPE_NONE {
            vm.fd_table[i].fd_type = FD_TYPE_EPOLL;
            return i as i64;
        }
    }
    -24 // EMFILE
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

    match op {
        1 => {
            // EPOLL_CTL_ADD
            if EPOLL_COUNT < MAX_EPOLL_ENTRIES {
                EPOLL_ENTRIES[EPOLL_COUNT] = EpollEntry { epfd, fd, events, data };
                EPOLL_COUNT += 1;
            }
            0
        }
        2 => {
            // EPOLL_CTL_DEL
            let mut i = 0;
            while i < EPOLL_COUNT {
                if EPOLL_ENTRIES[i].epfd == epfd && EPOLL_ENTRIES[i].fd == fd {
                    EPOLL_COUNT -= 1;
                    EPOLL_ENTRIES[i] = EPOLL_ENTRIES[EPOLL_COUNT];
                    EPOLL_ENTRIES[EPOLL_COUNT] = EMPTY_EPOLL;
                    break;
                }
                i += 1;
            }
            0
        }
        3 => {
            // EPOLL_CTL_MOD
            let mut i = 0;
            while i < EPOLL_COUNT {
                if EPOLL_ENTRIES[i].epfd == epfd && EPOLL_ENTRIES[i].fd == fd {
                    EPOLL_ENTRIES[i].events = events;
                    EPOLL_ENTRIES[i].data = data;
                    break;
                }
                i += 1;
            }
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
        let target = find_runnable(vm, current_slot);
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
        // No other thread to switch to — all threads are deadlocked.
        // Yield to the host when:
        // - there's a listening socket (server waiting for connections), OR
        // - timeout > 0 (finite wait, e.g. libuv timer — real time must advance)
        // We do NOT yield for timeout == -1 without a listening socket, as that
        // would slow down V8 init where worker threads block with infinite waits.
        if has_listening_socket() || timeout > 0 {
            vm.status = STATUS_EPOLL_BLOCKED;
            return 0; // host will set a0 to -EINTR before resuming
        }
        // No listening socket and infinite timeout: return 0 (timeout expired).
    }
    0 // Return 0 events
}

unsafe fn sys_eventfd2(vm: &mut Vm, initval: u32, _flags: i32) -> i64 {
    if EVENTFD_ALLOC >= MAX_EVENTFDS {
        return -24; // EMFILE
    }
    let efd_slot = EVENTFD_ALLOC;
    EVENTFD_ALLOC += 1;
    EVENTFD_COUNTERS[efd_slot] = initval;

    for i in 0..MAX_FDS {
        if vm.fd_table[i].fd_type == FD_TYPE_NONE {
            vm.fd_table[i].fd_type = FD_TYPE_EVENTFD;
            vm.fd_table[i].host_fd = efd_slot as i32;
            return i as i64;
        }
    }
    -24 // EMFILE
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

unsafe fn sys_timerfd_create(vm: &mut Vm) -> i64 {
    if TIMERFD_ALLOC >= MAX_TIMERFDS {
        return -24; // EMFILE
    }
    let tfd_slot = TIMERFD_ALLOC;
    TIMERFD_ALLOC += 1;
    TIMERFD_EXPIRY_MS[tfd_slot] = 0.0; // disarmed
    TIMERFD_INTERVAL_MS[tfd_slot] = 0.0;

    for i in 0..MAX_FDS {
        if vm.fd_table[i].fd_type == FD_TYPE_NONE {
            vm.fd_table[i].fd_type = FD_TYPE_TIMERFD;
            vm.fd_table[i].host_fd = tfd_slot as i32;
            return i as i64;
        }
    }
    -24 // EMFILE
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
