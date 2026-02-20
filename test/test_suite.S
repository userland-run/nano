# RISC-V 64-bit test suite for NanoVM
# Tests: arithmetic, memory, branches, compressed insns, syscalls

    .section .text
    .global _start

_start:
    # ====== Test 1: Basic ALU ======
    la      a1, t1_msg
    li      a2, 17
    jal     ra, print

    li      t0, 42
    li      t1, 58
    add     t2, t0, t1          # 42 + 58 = 100
    li      t3, 100
    bne     t2, t3, fail

    li      t0, 200
    li      t1, 50
    sub     t2, t0, t1          # 200 - 50 = 150
    li      t3, 150
    bne     t2, t3, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 2: Shifts & Logic ======
    la      a1, t2_msg
    li      a2, 22
    jal     ra, print

    li      t0, 1
    slli    t1, t0, 10          # 1 << 10 = 1024
    li      t2, 1024
    bne     t1, t2, fail

    li      t0, 0xFF00
    li      t1, 0x0FF0
    and     t2, t0, t1          # 0xFF00 & 0x0FF0 = 0x0F00
    li      t3, 0x0F00
    bne     t2, t3, fail

    or      t2, t0, t1          # 0xFF00 | 0x0FF0 = 0xFFF0
    li      t3, 0xFFF0
    bne     t2, t3, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 3: Memory Load/Store ======
    la      a1, t3_msg
    li      a2, 22
    jal     ra, print

    la      t0, scratch
    li      t1, 0x12345678      # bit31=0, so lw sign-ext is identity
    sw      t1, 0(t0)           # store word
    lw      t2, 0(t0)           # load word
    bne     t1, t2, fail

    li      t1, 0x1234567890ABCDEF
    sd      t1, 8(t0)           # store doubleword
    ld      t2, 8(t0)           # load doubleword
    bne     t1, t2, fail

    li      t1, 0x42
    sb      t1, 16(t0)          # store byte
    lbu     t2, 16(t0)          # load byte unsigned
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 4: Branches ======
    la      a1, t4_msg
    li      a2, 16
    jal     ra, print

    li      t0, 5
    li      t1, 10
    blt     t0, t1, .br_ok1
    j       fail
.br_ok1:
    bge     t1, t0, .br_ok2
    j       fail
.br_ok2:
    li      t0, -1
    bgez    t1, .br_ok3         # 10 >= 0? yes (pseudo: bge t1, x0)
    j       fail
.br_ok3:
    bltz    t0, .br_ok4         # -1 < 0? yes (pseudo: blt t0, x0)
    j       fail
.br_ok4:
    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 5: MUL/DIV (M extension) ======
    la      a1, t5_msg
    li      a2, 15
    jal     ra, print

    li      t0, 7
    li      t1, 13
    mul     t2, t0, t1          # 7 * 13 = 91
    li      t3, 91
    bne     t2, t3, fail

    li      t0, 100
    li      t1, 7
    div     t2, t0, t1          # 100 / 7 = 14
    li      t3, 14
    bne     t2, t3, fail

    rem     t2, t0, t1          # 100 % 7 = 2
    li      t3, 2
    bne     t2, t3, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 6: 32-bit ops (W suffix) ======
    la      a1, t6_msg
    li      a2, 17
    jal     ra, print

    li      t0, 0x7FFFFFFF      # max signed 32-bit
    addiw   t1, t0, 1           # overflow to -2147483648
    li      t2, -2147483648
    bne     t1, t2, fail

    li      t0, 100
    li      t1, 3
    divw    t2, t0, t1          # 100 / 3 = 33
    li      t3, 33
    bne     t2, t3, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 7: JAL/JALR ======
    la      a1, t7_msg
    li      a2, 14
    jal     ra, print

    jal     t0, .jal_target     # jump, save return in t0
    j       .jal_returned
.jal_target:
    jalr    zero, 0(t0)         # return via t0
.jal_returned:

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 8: brk syscall ======
    la      a1, t8_msg
    li      a2, 14
    jal     ra, print

    li      a7, 214             # SYS_brk
    li      a0, 0               # query current brk
    ecall
    # a0 should be some address (our brk_start or brk_current)
    # Just check it didn't return negative
    bltz    a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 9: uname syscall ======
    la      a1, t9_msg
    li      a2, 16
    jal     ra, print

    li      a7, 160             # SYS_uname
    la      a0, scratch         # buffer
    ecall
    # Check result == 0
    bnez    a0, fail
    # Check first bytes = "Linux"
    la      t0, scratch
    lbu     t1, 0(t0)
    li      t2, 0x4C            # 'L'
    bne     t1, t2, fail
    lbu     t1, 1(t0)
    li      t2, 0x69            # 'i'
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 10: clock_gettime ======
    la      a1, t10_msg
    li      a2, 21
    jal     ra, print

    li      a7, 113             # SYS_clock_gettime
    li      a0, 0               # CLOCK_REALTIME
    la      a1, scratch
    ecall
    # a0 should be 0
    bnez    a0, fail
    # seconds should be > 0
    la      t0, scratch
    ld      t1, 0(t0)
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== All tests passed ======
    la      a1, pass_msg
    li      a2, 28
    jal     ra, print

    # exit(0)
    li      a7, 93
    li      a0, 0
    ecall

fail:
    la      a1, fail_msg
    li      a2, 7
    li      a7, 64
    li      a0, 2               # stderr
    ecall
    li      a7, 93
    li      a0, 1
    ecall

# print(a1=buf, a2=len) -> uses write syscall
print:
    li      a7, 64              # SYS_write
    li      a0, 1               # fd=stdout
    ecall
    jalr    zero, 0(ra)

    .section .rodata
t1_msg:   .ascii "Test 1: ALU ops..  "
t2_msg:   .ascii "Test 2: Shift/Logic.. "
t3_msg:   .ascii "Test 3: Load/Store... "
t4_msg:   .ascii "Test 4: Branch.. "
t5_msg:   .ascii "Test 5: Mul/Div. "
t6_msg:   .ascii "Test 6: W-suffix. "
t7_msg:   .ascii "Test 7: JAL/JALR "
t8_msg:   .ascii "Test 8: brk... "
t9_msg:   .ascii "Test 9: uname... "
t10_msg:  .ascii "Test10: clock_gettime "
ok_msg:   .ascii "OK\n\0"
fail_msg: .ascii "FAIL!\n\0"
pass_msg: .ascii "\nAll 10 tests passed!\n\n\0\0\0\0"

    .section .bss
    .align 8
scratch:
    .space 512
