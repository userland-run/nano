# RISC-V 64-bit floating-point test suite for NanoVM
# Tests F extension (single) and D extension (double) operations
# Exercises cpu.rs FP instruction handling

    .section .text
    .global _start

_start:
    # ====== Test 1: Single-precision add/sub ======
    la      a1, t1_msg
    li      a2, 24
    jal     ra, print

    # 1.5 + 2.5 = 4.0
    la      t0, f_1_5
    flw     ft0, 0(t0)
    la      t0, f_2_5
    flw     ft1, 0(t0)
    fadd.s  ft2, ft0, ft1
    la      t0, f_4_0
    flw     ft3, 0(t0)
    feq.s   t1, ft2, ft3
    beqz    t1, fail

    # 4.0 - 1.5 = 2.5
    fsub.s  ft2, ft3, ft0
    feq.s   t1, ft2, ft1
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 2: Single-precision mul/div ======
    la      a1, t2_msg
    li      a2, 24
    jal     ra, print

    # 3.0 * 4.0 = 12.0
    la      t0, f_3_0
    flw     ft0, 0(t0)
    la      t0, f_4_0
    flw     ft1, 0(t0)
    fmul.s  ft2, ft0, ft1
    la      t0, f_12_0
    flw     ft3, 0(t0)
    feq.s   t1, ft2, ft3
    beqz    t1, fail

    # 12.0 / 3.0 = 4.0
    fdiv.s  ft2, ft3, ft0
    feq.s   t1, ft2, ft1
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 3: Double-precision add/sub ======
    la      a1, t3_msg
    li      a2, 24
    jal     ra, print

    # 1.5 + 2.5 = 4.0 (double)
    la      t0, d_1_5
    fld     ft0, 0(t0)
    la      t0, d_2_5
    fld     ft1, 0(t0)
    fadd.d  ft2, ft0, ft1
    la      t0, d_4_0
    fld     ft3, 0(t0)
    feq.d   t1, ft2, ft3
    beqz    t1, fail

    # 4.0 - 2.5 = 1.5
    fsub.d  ft2, ft3, ft1
    feq.d   t1, ft2, ft0
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 4: Double-precision mul/div ======
    la      a1, t4_msg
    li      a2, 24
    jal     ra, print

    # 3.0 * 4.0 = 12.0 (double)
    la      t0, d_3_0
    fld     ft0, 0(t0)
    la      t0, d_4_0
    fld     ft1, 0(t0)
    fmul.d  ft2, ft0, ft1
    la      t0, d_12_0
    fld     ft3, 0(t0)
    feq.d   t1, ft2, ft3
    beqz    t1, fail

    # 12.0 / 4.0 = 3.0
    fdiv.d  ft2, ft3, ft1
    feq.d   t1, ft2, ft0
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 5: Float comparisons (flt, fle, feq) ======
    la      a1, t5_msg
    li      a2, 24
    jal     ra, print

    la      t0, f_1_5
    flw     ft0, 0(t0)     # 1.5
    la      t0, f_3_0
    flw     ft1, 0(t0)     # 3.0

    # 1.5 < 3.0 = true
    flt.s   t1, ft0, ft1
    beqz    t1, fail

    # 3.0 < 1.5 = false
    flt.s   t1, ft1, ft0
    bnez    t1, fail

    # 1.5 <= 1.5 = true
    fle.s   t1, ft0, ft0
    beqz    t1, fail

    # 1.5 == 1.5 = true
    feq.s   t1, ft0, ft0
    beqz    t1, fail

    # 1.5 == 3.0 = false
    feq.s   t1, ft0, ft1
    bnez    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 6: Double comparisons ======
    la      a1, t6_msg
    li      a2, 24
    jal     ra, print

    la      t0, d_1_5
    fld     ft0, 0(t0)     # 1.5
    la      t0, d_3_0
    fld     ft1, 0(t0)     # 3.0

    # 1.5 < 3.0 = true
    flt.d   t1, ft0, ft1
    beqz    t1, fail

    # 3.0 < 1.5 = false
    flt.d   t1, ft1, ft0
    bnez    t1, fail

    # 1.5 <= 3.0 = true
    fle.d   t1, ft0, ft1
    beqz    t1, fail

    # feq double
    feq.d   t1, ft0, ft0
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 7: fcvt.w.s / fcvt.s.w (int<->float conversion) ======
    la      a1, t7_msg
    li      a2, 24
    jal     ra, print

    # Convert int 42 to float
    li      t0, 42
    fcvt.s.w ft0, t0
    la      t1, f_42_0
    flw     ft1, 0(t1)
    feq.s   t2, ft0, ft1
    beqz    t2, fail

    # Convert float 42.0 back to int
    fcvt.w.s t3, ft1, rtz   # round toward zero
    li      t4, 42
    bne     t3, t4, fail

    # Convert 3.7 to int (should truncate to 3)
    la      t0, f_3_7
    flw     ft0, 0(t0)
    fcvt.w.s t1, ft0, rtz
    li      t2, 3
    bne     t1, t2, fail

    # Convert negative: -2.9 to int (should truncate to -2)
    la      t0, f_neg_2_9
    flw     ft0, 0(t0)
    fcvt.w.s t1, ft0, rtz
    li      t2, -2
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 8: fcvt.d.s / fcvt.s.d (single<->double) ======
    la      a1, t8_msg
    li      a2, 24
    jal     ra, print

    # Single 1.5 -> double
    la      t0, f_1_5
    flw     ft0, 0(t0)
    fcvt.d.s ft1, ft0
    la      t0, d_1_5
    fld     ft2, 0(t0)
    feq.d   t1, ft1, ft2
    beqz    t1, fail

    # Double 3.0 -> single
    la      t0, d_3_0
    fld     ft0, 0(t0)
    fcvt.s.d ft1, ft0
    la      t0, f_3_0
    flw     ft2, 0(t0)
    feq.s   t1, ft1, ft2
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 9: fmin.s / fmax.s ======
    la      a1, t9_msg
    li      a2, 24
    jal     ra, print

    la      t0, f_1_5
    flw     ft0, 0(t0)     # 1.5
    la      t0, f_3_0
    flw     ft1, 0(t0)     # 3.0

    # min(1.5, 3.0) = 1.5
    fmin.s  ft2, ft0, ft1
    feq.s   t1, ft2, ft0
    beqz    t1, fail

    # max(1.5, 3.0) = 3.0
    fmax.s  ft2, ft0, ft1
    feq.s   t1, ft2, ft1
    beqz    t1, fail

    # min(3.0, 1.5) = 1.5 (commutative)
    fmin.s  ft2, ft1, ft0
    feq.s   t1, ft2, ft0
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 10: fmin.d / fmax.d ======
    la      a1, t10_msg
    li      a2, 24
    jal     ra, print

    la      t0, d_1_5
    fld     ft0, 0(t0)     # 1.5
    la      t0, d_3_0
    fld     ft1, 0(t0)     # 3.0

    fmin.d  ft2, ft0, ft1
    feq.d   t1, ft2, ft0
    beqz    t1, fail

    fmax.d  ft2, ft0, ft1
    feq.d   t1, ft2, ft1
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 11: fmv.x.w / fmv.w.x (bitwise move) ======
    la      a1, t11_msg
    li      a2, 24
    jal     ra, print

    # Move float bits to integer and back
    la      t0, f_1_5
    flw     ft0, 0(t0)         # 1.5f
    fmv.x.w t1, ft0            # get raw bits
    li      t2, 0x3FC00000     # IEEE 754 representation of 1.5f
    bne     t1, t2, fail

    # Move integer bits back to float
    fmv.w.x ft1, t1
    feq.s   t3, ft0, ft1
    beqz    t3, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 12: fsgnj / fsgnjn / fsgnjx (sign injection) ======
    la      a1, t12_msg
    li      a2, 24
    jal     ra, print

    la      t0, f_3_0
    flw     ft0, 0(t0)         # 3.0 (positive)
    la      t0, f_neg_2_9
    flw     ft1, 0(t0)         # -2.9 (negative)

    # fsgnj: copy sign of ft1 to ft0 -> -3.0
    fsgnj.s ft2, ft0, ft1
    la      t0, f_neg_3_0
    flw     ft3, 0(t0)
    feq.s   t1, ft2, ft3
    beqz    t1, fail

    # fsgnjn: negate sign of ft1 -> +3.0 (sign of ft1 is -, negated = +)
    fsgnjn.s ft2, ft0, ft1
    la      t0, f_3_0
    flw     ft3, 0(t0)
    feq.s   t1, ft2, ft3
    beqz    t1, fail

    # fsgnjx: XOR signs (+ XOR - = -) -> -3.0
    fsgnjx.s ft2, ft0, ft1
    la      t0, f_neg_3_0
    flw     ft3, 0(t0)
    feq.s   t1, ft2, ft3
    beqz    t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 13: fcvt.l.d / fcvt.d.l (64-bit int <-> double) ======
    la      a1, t13_msg
    li      a2, 24
    jal     ra, print

    # Convert large int to double
    li      t0, 1000000
    fcvt.d.l ft0, t0
    la      t1, d_1000000
    fld     ft1, 0(t1)
    feq.d   t2, ft0, ft1
    beqz    t2, fail

    # Convert back
    fcvt.l.d t3, ft1, rtz
    li      t4, 1000000
    bne     t3, t4, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 14: FP store/load round-trip ======
    la      a1, t14_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch

    # Single-precision store/load
    la      t1, f_3_7
    flw     ft0, 0(t1)
    fsw     ft0, 0(t0)
    flw     ft1, 0(t0)
    feq.s   t2, ft0, ft1
    beqz    t2, fail

    # Double-precision store/load
    la      t1, d_3_0
    fld     ft0, 0(t1)
    fsd     ft0, 8(t0)
    fld     ft1, 8(t0)
    feq.d   t2, ft0, ft1
    beqz    t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== All tests passed ======
    la      a1, pass_msg
    li      a2, 40
    jal     ra, print

    li      a7, 93
    li      a0, 0
    ecall

fail:
    la      a1, fail_msg
    li      a2, 7
    li      a7, 64
    li      a0, 2
    ecall
    li      a7, 93
    li      a0, 1
    ecall

# print(a1=buf, a2=len)
print:
    li      a7, 64
    li      a0, 1
    ecall
    jalr    zero, 0(ra)

    .section .rodata
t1_msg:   .ascii "Test 1:  fadd/fsub.s.. "
t2_msg:   .ascii "Test 2:  fmul/fdiv.s.. "
t3_msg:   .ascii "Test 3:  fadd/fsub.d.. "
t4_msg:   .ascii "Test 4:  fmul/fdiv.d.. "
t5_msg:   .ascii "Test 5:  fcmp single.. "
t6_msg:   .ascii "Test 6:  fcmp double.. "
t7_msg:   .ascii "Test 7:  fcvt int<>s.. "
t8_msg:   .ascii "Test 8:  fcvt s<>d.... "
t9_msg:   .ascii "Test 9:  fmin/fmax.s.. "
t10_msg:  .ascii "Test10:  fmin/fmax.d.. "
t11_msg:  .ascii "Test11:  fmv.x.w...... "
t12_msg:  .ascii "Test12:  fsgnj........ "
t13_msg:  .ascii "Test13:  fcvt l<>d.... "
t14_msg:  .ascii "Test14:  FP store/load. "
ok_msg:   .ascii "OK\n\0"
fail_msg: .ascii "FAIL!\n\0"
pass_msg: .ascii "\nAll 14 float tests passed!\n\n\0\0\0\0\0\0"

# Single-precision constants (IEEE 754 32-bit)
    .align 4
f_1_5:    .word 0x3FC00000    # 1.5f
f_2_5:    .word 0x40200000    # 2.5f
f_3_0:    .word 0x40400000    # 3.0f
f_3_7:    .word 0x406CCCCD    # 3.7f
f_4_0:    .word 0x40800000    # 4.0f
f_12_0:   .word 0x41400000    # 12.0f
f_42_0:   .word 0x42280000    # 42.0f
f_neg_2_9:.word 0xC0399999    # -2.9f (approx)
f_neg_3_0:.word 0xC0400000    # -3.0f

# Double-precision constants (IEEE 754 64-bit)
    .align 8
d_1_5:    .quad 0x3FF8000000000000    # 1.5
d_2_5:    .quad 0x4004000000000000    # 2.5
d_3_0:    .quad 0x4008000000000000    # 3.0
d_4_0:    .quad 0x4010000000000000    # 4.0
d_12_0:   .quad 0x4028000000000000    # 12.0
d_1000000:.quad 0x412E848000000000    # 1000000.0

    .section .bss
    .align 8
scratch:
    .space 256
