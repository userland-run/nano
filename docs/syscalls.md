# Syscall Reference

NanoVM implements a Linux RISC-V userland syscall interface. Syscalls are dispatched in `src/syscall.rs` when the guest executes an `ECALL` instruction. The syscall number is in `a7` (x17), arguments in `a0`-`a5` (x10-x15), and the return value goes in `a0` (x10).

## Handling Modes

Syscalls are handled in two ways:

- **Internal** — resolved entirely within the WASM module (memory, sockets, threads, time)
- **FS_PENDING** — deferred to the JS host via a shared-memory request/response protocol (file I/O)

## Implemented Syscalls

### File System (via FS_PENDING → JS MemFS)

| Nr | Name | Notes |
|----|------|-------|
| 56 | openat | O_CREAT, O_TRUNC, O_RDONLY/WRONLY/RDWR |
| 57 | close | Files, directories |
| 63 | read | Regular files, pipes, stdin |
| 64 | write | stdout/stderr → console_write; files via FS_PENDING |
| 65 | readv | Scatter read |
| 66 | writev | Gather write |
| 67 | pread64 | Positional read (does not change file offset) |
| 68 | pwrite64 | Positional write (does not change file offset) |
| 69 | preadv | Positional scatter read |
| 70 | pwritev | Positional gather write |
| 62 | lseek | SEEK_SET, SEEK_CUR, SEEK_END |
| 61 | getdents64 | Directory listing |
| 79 | newfstatat | File/directory stat |
| 80 | fstat | Stat by fd |
| 291 | statx | Extended stat |
| 78 | readlinkat | Symlink resolution |
| 34 | mkdirat | Create directory |
| 35 | unlinkat | Remove file or empty directory |
| 276 | renameat2 | Move/rename |
| 48 | faccessat | Access check |
| 88 | utimensat | Update timestamps |
| 17 | getcwd | Get working directory |
| 49 | chdir | Change working directory |

### Memory Management (internal)

| Nr | Name | Notes |
|----|------|-------|
| 214 | brk | Page-aligned bump within guest RAM (zeroes growth) |
| 222 | mmap | Anonymous + fixed mappings in guest VA space |
| 216 | mremap | Grows in place at the bump frontier, or moves with MREMAP_MAYMOVE (used by V8 heap growth) |
| 215 | munmap | Stub (no-op; bump allocator never frees) |
| 226 | mprotect | Stub (returns 0) |
| 233 | madvise | Stub (returns 0) |

### Process & Thread (internal)

| Nr | Name | Notes |
|----|------|-------|
| 220 | clone | Creates thread slots; supports CLONE_VM, CLONE_THREAD, CLONE_SETTLS |
| 93 | exit | Thread exit |
| 94 | exit_group | Process exit |
| 172 | getpid | Returns 1 |
| 173 | getppid | Returns 1 |
| 178 | gettid | Returns thread ID |
| 96 | set_tid_address | Sets clear_child_tid pointer |
| 98 | futex | FUTEX_WAIT, FUTEX_WAKE — cooperative thread switching |
| 124 | sched_yield | Yields to another runnable thread |
| 123 | sched_getaffinity | Reports 1 CPU |

### Signals (stubs)

| Nr | Name | Notes |
|----|------|-------|
| 134 | rt_sigaction | Stub (returns 0; handlers are never recorded or delivered) |
| 135 | rt_sigprocmask | Stub (returns 0; mask is not tracked) |
| 132 | sigaltstack | Records alternate stack |
| 129 | kill | No-op |
| 130 | tkill | No-op |
| 131 | tgkill | No-op |

### Time (internal)

| Nr | Name | Notes |
|----|------|-------|
| 113 | clock_gettime | Returns real wall-clock time via `Date.now()` |
| 114 | clock_getres | Reports 1ms resolution |
| 101 | nanosleep | Returns immediately (no-op) |

### Timerfd (internal)

| Nr | Name | Notes |
|----|------|-------|
| 85 | timerfd_create | Allocates a timer fd |
| 86 | timerfd_settime | Arms timer with absolute/relative expiry; supports intervals |

Timerfds integrate with epoll — `epoll_pwait` checks `Date.now()` against the expiry and reports `EPOLLIN` when fired. Reading a timerfd returns the expiration count.

### Epoll / Event (internal)

| Nr | Name | Notes |
|----|------|-------|
| 20 | epoll_create1 | Creates epoll instance |
| 21 | epoll_ctl | ADD, DEL, MOD operations |
| 22 | epoll_pwait | Polls sockets, eventfds, timerfds; context-switches on block |
| 19 | eventfd2 | Per-fd counter with epoll integration |
| 59 | pipe2 | Creates pipe pair |
| 73 | ppoll | Stub (returns 0) |

### Sockets (internal)

| Nr | Name | Notes |
|----|------|-------|
| 198 | socket | AF_INET / AF_INET6 only, SOCK_STREAM / SOCK_DGRAM (AF_UNIX → EAFNOSUPPORT) |
| 199 | socketpair | Not supported (ENOSYS) |
| 200 | bind | Associates socket with port |
| 201 | listen | Marks socket as listening |
| 202 | accept | Legacy accept (calls accept4) |
| 242 | accept4 | Accept with flags (SOCK_NONBLOCK); pops from accept queue |
| 203 | connect | Connects to peer socket by port |
| 206 | sendto | Write to peer's recv buffer |
| 207 | recvfrom | Read from own recv buffer |
| 204 | getsockname | Returns bound address |
| 205 | getpeername | Returns peer address |
| 208 | setsockopt | Stub (returns 0) |
| 209 | getsockopt | SO_ERROR returns 0 |
| 210 | shutdown | Marks socket as shutdown |

Sockets use 16KB ring buffers per slot. Connected sockets have peer indices — writing to a socket puts data in the peer's recv buffer.

### I/O Control (internal)

| Nr | Name | Notes |
|----|------|-------|
| 29 | ioctl | TIOCGWINSZ / TCGETS → ENOTTY (so `isatty()` is false — required for V8 init); FIONREAD → 0 |
| 25 | fcntl | F_GETFL, F_SETFL (O_NONBLOCK), F_GETFD, F_SETFD, F_DUPFD |
| 23 | dup | Duplicate fd |
| 24 | dup3 | Duplicate fd to specific number |

### Identity (internal)

| Nr | Name | Notes |
|----|------|-------|
| 174 | getuid | Returns 0 (root) |
| 175 | geteuid | Returns 0 |
| 176 | getgid | Returns 0 |
| 177 | getegid | Returns 0 |
| 166 | umask | Returns 0o22 |
| 160 | uname | Reports "Linux 6.1.0 riscv64" hostname "nanovm" |
| 179 | sysinfo | Reports RAM size |
| 261 | prlimit64 | RLIMIT_NOFILE=1024, RLIMIT_STACK=8MB |
| 90 | capget | Reports all capabilities (root) |
| 278 | getrandom | Uses host Math.random() via emscripten_random |
| 167 | prctl | Stub (returns 0) |
| 259 | riscv_flush_icache | No-op (the interpreter re-reads guest memory each step) |
| 425 | io_uring_setup | Intentionally unavailable (ENOSYS) — callers fall back to thread-pool/epoll |

## Virtual Server Exports

These WASM exports let the JS host inject HTTP connections into listening sockets:

| Export | Signature | Purpose |
|--------|-----------|---------|
| `vm_inject_connection` | `(vm_ptr, port, req_ptr, req_len) -> conn_id` | Injects HTTP request into server's accept queue |
| `vm_read_response` | `(vm_ptr, conn_id, dst_ptr, dst_len) -> n` | Reads response bytes (>0=data, 0=waiting, -1=done) |
| `vm_close_connection` | `(vm_ptr, conn_id)` | Closes both sides of the virtual connection |
