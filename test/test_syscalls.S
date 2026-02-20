# RISC-V 64-bit extended syscall test suite for NanoVM
# Tests syscalls beyond the basic suite (brk/uname/clock_gettime)
# Exercises syscall.rs dispatch and argument handling

    .section .text
    .global _start

# RISC-V Linux syscall numbers
.equ SYS_GETCWD,       17
.equ SYS_DUP,          23
.equ SYS_DUP3,         24
.equ SYS_FCNTL,        25
.equ SYS_IOCTL,        29
.equ SYS_MKDIRAT,      34
.equ SYS_UNLINKAT,     35
.equ SYS_OPENAT,       56
.equ SYS_CLOSE,        57
.equ SYS_GETDENTS64,   61
.equ SYS_LSEEK,        62
.equ SYS_READ,         63
.equ SYS_WRITE,        64
.equ SYS_READV,        65
.equ SYS_WRITEV,       66
.equ SYS_READLINKAT,   78
.equ SYS_NEWFSTATAT,   79
.equ SYS_FSTAT,        80
.equ SYS_EXIT,         93
.equ SYS_EXIT_GROUP,   94
.equ SYS_SET_TID_ADDR, 96
.equ SYS_FUTEX,        98
.equ SYS_SET_ROBUST,   99
.equ SYS_NANOSLEEP,    101
.equ SYS_CLOCK_GETTIME,113
.equ SYS_CLOCK_GETRES, 114
.equ SYS_SCHED_YIELD,  124
.equ SYS_KILL,         129
.equ SYS_SIGALTSTACK,  132
.equ SYS_RT_SIGACTION, 134
.equ SYS_RT_SIGPROCMASK,135
.equ SYS_TIMES,        153
.equ SYS_UNAME,        160
.equ SYS_UMASK,        166
.equ SYS_PRCTL,        167
.equ SYS_GETPID,       172
.equ SYS_GETUID,       174
.equ SYS_GETEUID,      175
.equ SYS_GETGID,       176
.equ SYS_GETEGID,      177
.equ SYS_GETTID,       178
.equ SYS_SYSINFO,      179
.equ SYS_BRK,          214
.equ SYS_MUNMAP,       215
.equ SYS_MMAP,         222
.equ SYS_MPROTECT,     226
.equ SYS_MADVISE,      233
.equ SYS_PRLIMIT64,    261
.equ SYS_GETRANDOM,    278

# Constants
.equ AT_FDCWD,         -100
.equ O_RDONLY,          0
.equ O_WRONLY,          1
.equ O_RDWR,           2
.equ O_CREAT,          0x40
.equ O_TRUNC,          0x200
.equ SEEK_SET,          0
.equ SEEK_CUR,          1
.equ SEEK_END,          2

_start:
    # ====== Test 1: getpid / gettid ======
    la      a1, t1_msg
    li      a2, 24
    jal     ra, print

    li      a7, SYS_GETPID
    ecall
    # pid should be > 0
    blez    a0, fail

    mv      s0, a0          # save pid

    li      a7, SYS_GETTID
    ecall
    # tid should be > 0
    blez    a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 2: getuid / getgid / geteuid / getegid ======
    la      a1, t2_msg
    li      a2, 24
    jal     ra, print

    li      a7, SYS_GETUID
    ecall
    # uid should be >= 0 (typically 0 for root)
    bltz    a0, fail

    li      a7, SYS_GETGID
    ecall
    bltz    a0, fail

    li      a7, SYS_GETEUID
    ecall
    bltz    a0, fail

    li      a7, SYS_GETEGID
    ecall
    bltz    a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 3: brk - allocate and use memory ======
    la      a1, t3_msg
    li      a2, 24
    jal     ra, print

    # Query current brk
    li      a7, SYS_BRK
    li      a0, 0
    ecall
    mv      s0, a0          # save base brk

    # Extend brk by 4096 bytes
    li      t0, 4096
    add     a0, s0, t0
    li      a7, SYS_BRK
    ecall
    # New brk should be >= requested
    blt     a0, s0, fail

    # Write to allocated memory
    li      t0, 0x12345678
    sw      t0, 0(s0)
    lw      t1, 0(s0)
    bne     t0, t1, fail

    # Write at end of allocated region
    li      t2, 4092
    add     t2, s0, t2
    sw      t0, 0(t2)
    lw      t1, 0(t2)
    bne     t0, t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 4: mmap anonymous ======
    la      a1, t4_msg
    li      a2, 24
    jal     ra, print

    # mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0)
    li      a0, 0           # addr = NULL
    li      a1, 4096        # length
    li      a2, 3           # PROT_READ | PROT_WRITE
    li      a3, 0x22        # MAP_PRIVATE | MAP_ANONYMOUS
    li      a4, -1          # fd = -1
    li      a5, 0           # offset = 0
    li      a7, SYS_MMAP
    ecall
    # Should return a valid address (not negative error)
    li      t0, -4096
    bge     t0, a0, fail    # if result >= -4096, it's an error

    mv      s0, a0          # save mmap address

    # Write/read the mapped memory
    li      t0, 0x12340000
    sw      t0, 0(s0)
    lw      t1, 0(s0)
    bne     t0, t1, fail

    # munmap
    mv      a0, s0
    li      a1, 4096
    li      a7, SYS_MUNMAP
    ecall
    # Should return 0
    bnez    a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 5: getrandom ======
    la      a1, t5_msg
    li      a2, 24
    jal     ra, print

    la      a0, scratch
    li      a1, 16          # 16 bytes
    li      a2, 0           # flags = 0
    li      a7, SYS_GETRANDOM
    ecall
    # Should return 16
    li      t0, 16
    bne     a0, t0, fail

    # Check that at least some bytes are non-zero (extremely unlikely all 16 are 0)
    la      t0, scratch
    ld      t1, 0(t0)
    ld      t2, 8(t0)
    or      t1, t1, t2
    beqz    t1, fail        # if all 16 bytes are 0, something is wrong

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 6: clock_getres ======
    la      a1, t6_msg
    li      a2, 24
    jal     ra, print

    li      a7, SYS_CLOCK_GETRES
    li      a0, 0           # CLOCK_REALTIME
    la      a1, scratch
    ecall
    bnez    a0, fail

    # Resolution should be reasonable (seconds = 0, nsec > 0 and < 1B)
    la      t0, scratch
    ld      t1, 0(t0)       # seconds
    bnez    t1, fail        # resolution seconds should be 0

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 7: times ======
    la      a1, t7_msg
    li      a2, 24
    jal     ra, print

    li      a7, SYS_TIMES
    la      a0, scratch
    ecall
    # Should not return error (-1 with EFAULT would be negative)
    # Return value is clock ticks since boot (could be 0 early on, so just check >= 0)
    bltz    a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 8: sysinfo ======
    la      a1, t8_msg
    li      a2, 24
    jal     ra, print

    li      a7, SYS_SYSINFO
    la      a0, scratch
    ecall
    bnez    a0, fail

    # Check uptime > 0 (first field of struct sysinfo)
    la      t0, scratch
    ld      t1, 0(t0)       # uptime
    blez    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 9: umask ======
    la      a1, t9_msg
    li      a2, 24
    jal     ra, print

    li      a7, SYS_UMASK
    li      a0, 022        # set umask to 022
    ecall
    # Returns previous umask (any value is valid)
    mv      s0, a0

    li      a7, SYS_UMASK
    li      a0, 022        # set again
    ecall
    # Should return 022 (what we just set)
    li      t0, 022
    bne     a0, t0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 10: rt_sigprocmask ======
    la      a1, t10_msg
    li      a2, 24
    jal     ra, print

    # Get current signal mask
    li      a7, SYS_RT_SIGPROCMASK
    li      a0, 0           # SIG_BLOCK (but with empty set = just read)
    la      a1, scratch     # new set (all zeros = empty)
    la      a2, scratch+64  # old set output
    li      a3, 8           # sigsetsize
    ecall
    bnez    a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 11: set_tid_address ======
    la      a1, t11_msg
    li      a2, 24
    jal     ra, print

    li      a7, SYS_SET_TID_ADDR
    la      a0, scratch     # tidptr
    ecall
    # Should return the current tid (> 0)
    blez    a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 12: prlimit64 (get stack size) ======
    la      a1, t12_msg
    li      a2, 24
    jal     ra, print

    li      a7, SYS_PRLIMIT64
    li      a0, 0           # pid = 0 (self)
    li      a1, 3           # RLIMIT_STACK
    li      a2, 0           # new_limit = NULL
    la      a3, scratch     # old_limit output
    ecall
    bnez    a0, fail

    # old_limit.rlim_cur should be > 0
    la      t0, scratch
    ld      t1, 0(t0)
    blez    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 13: sched_yield ======
    la      a1, t13_msg
    li      a2, 24
    jal     ra, print

    li      a7, SYS_SCHED_YIELD
    ecall
    # Should return 0
    bnez    a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 14: mprotect ======
    la      a1, t14_msg
    li      a2, 24
    jal     ra, print

    # First mmap a page
    li      a0, 0
    li      a1, 4096
    li      a2, 3           # PROT_READ | PROT_WRITE
    li      a3, 0x22        # MAP_PRIVATE | MAP_ANONYMOUS
    li      a4, -1
    li      a5, 0
    li      a7, SYS_MMAP
    ecall
    li      t0, -4096
    bge     t0, a0, fail
    mv      s0, a0

    # mprotect it to read-only
    mv      a0, s0
    li      a1, 4096
    li      a2, 1           # PROT_READ
    li      a7, SYS_MPROTECT
    ecall
    bnez    a0, fail

    # Clean up
    mv      a0, s0
    li      a1, 4096
    li      a7, SYS_MUNMAP
    ecall

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 15: nanosleep ======
    la      a1, t15_msg
    li      a2, 24
    jal     ra, print

    # Sleep for 0 seconds, 0 nanoseconds (just test the syscall works)
    la      t0, scratch
    sd      zero, 0(t0)     # tv_sec = 0
    sd      zero, 8(t0)     # tv_nsec = 0
    li      a7, SYS_NANOSLEEP
    mv      a0, t0          # req
    li      a1, 0           # rem = NULL
    ecall
    bnez    a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== All tests passed ======
    la      a1, pass_msg
    li      a2, 40
    jal     ra, print

    li      a7, SYS_EXIT
    li      a0, 0
    ecall

fail:
    la      a1, fail_msg
    li      a2, 7
    li      a7, SYS_WRITE
    li      a0, 2           # stderr
    ecall
    li      a7, SYS_EXIT
    li      a0, 1
    ecall

# print(a1=buf, a2=len)
print:
    li      a7, SYS_WRITE
    li      a0, 1           # stdout
    ecall
    jalr    zero, 0(ra)

    .section .rodata
t1_msg:   .ascii "Test 1:  getpid/gettid. "
t2_msg:   .ascii "Test 2:  uid/gid....... "
t3_msg:   .ascii "Test 3:  brk alloc..... "
t4_msg:   .ascii "Test 4:  mmap anon..... "
t5_msg:   .ascii "Test 5:  getrandom..... "
t6_msg:   .ascii "Test 6:  clock_getres.. "
t7_msg:   .ascii "Test 7:  times......... "
t8_msg:   .ascii "Test 8:  sysinfo....... "
t9_msg:   .ascii "Test 9:  umask......... "
t10_msg:  .ascii "Test10:  sigprocmask... "
t11_msg:  .ascii "Test11:  set_tid_addr.. "
t12_msg:  .ascii "Test12:  prlimit64..... "
t13_msg:  .ascii "Test13:  sched_yield... "
t14_msg:  .ascii "Test14:  mprotect...... "
t15_msg:  .ascii "Test15:  nanosleep..... "
ok_msg:   .ascii "OK\n\0"
fail_msg: .ascii "FAIL!\n\0"
pass_msg: .ascii "\nAll 15 syscall tests passed!\n\n\0\0\0\0\0"

    .section .bss
    .align 8
scratch:
    .space 512
