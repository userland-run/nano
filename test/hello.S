# Minimal RISC-V 64-bit Linux userland "Hello World"
# Uses raw Linux syscalls (RISC-V ABI: syscall nr in a7, args in a0-a5)

    .section .text
    .global _start

_start:
    # write(1, msg, 19)
    li      a7, 64          # SYS_write = 64 (RISC-V Linux)
    li      a0, 1           # fd = STDOUT
    la      a1, msg         # buf = address of message
    li      a2, 19          # count = 19
    ecall

    # write(1, msg2, 14)
    li      a7, 64
    li      a0, 1
    la      a1, msg2
    li      a2, 14
    ecall

    # exit(0)
    li      a7, 93          # SYS_exit = 93
    li      a0, 0           # exit code = 0
    ecall

    .section .rodata
msg:
    .ascii "Hello from NanoVM!\n"
msg2:
    .ascii "It works! :)\n\0"
