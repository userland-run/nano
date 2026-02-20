# RISC-V 64-bit compressed instruction (RVC) test suite for NanoVM
# Exercises decode.rs: all C-extension instruction forms
#
# RVC register constraints:
#   c.li/c.mv/c.add/c.slli: rd in x1-x31 (any except x0)
#   c.lw/c.ld/c.sw/c.sd/c.and/c.or/c.xor/c.sub etc: rd'/rs' in x8-x15 (s0,s1,a0-a5)
#   c.li immediate: 6-bit signed (-32..31)

    .section .text
    .global _start
    .option rvc

_start:
    # Set up stack pointer for SP-relative tests
    la      sp, stack_top

    # ====== Test 1: C.LI / C.MV / C.ADD ======
    la      a1, t1_msg
    li      a2, 24
    jal     ra, print

    # C.LI rd, imm (6-bit signed: -32..31)
    c.li    t0, 20
    li      t1, 20
    bne     t0, t1, fail

    c.li    t0, -1
    li      t1, -1
    bne     t0, t1, fail

    c.li    t0, -32         # minimum 6-bit signed
    li      t1, -32
    bne     t0, t1, fail

    c.li    t0, 31          # maximum 6-bit signed
    li      t1, 31
    bne     t0, t1, fail

    c.li    t0, 0
    bnez    t0, fail

    # C.MV rd, rs2
    li      t0, 0xDEAD
    c.mv    t1, t0
    bne     t0, t1, fail

    # C.ADD rd, rs2
    li      t0, 100
    li      t1, 200
    c.add   t0, t1          # t0 = 100 + 200 = 300
    li      t2, 300
    bne     t0, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 2: C.ADDI / C.ADDIW ======
    la      a1, t2_msg
    li      a2, 24
    jal     ra, print

    # C.ADDI rd, nzimm
    li      t0, 10
    c.addi  t0, 5           # 10 + 5 = 15
    li      t1, 15
    bne     t0, t1, fail

    li      t0, 10
    c.addi  t0, -3          # 10 + (-3) = 7
    li      t1, 7
    bne     t0, t1, fail

    # C.ADDIW rd, imm (sign-extends 32-bit result)
    li      t0, 0x7FFFFFFD
    c.addiw t0, 3           # 0x7FFFFFFD + 3 = 0x80000000 -> sign-ext to -2147483648
    li      t1, -2147483648
    bne     t0, t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 3: C.SLLI / C.SRLI / C.SRAI ======
    la      a1, t3_msg
    li      a2, 24
    jal     ra, print

    # C.SLLI rd, shamt (rd in x1-x31)
    li      s0, 1
    c.slli  s0, 10          # 1 << 10 = 1024
    li      t0, 1024
    bne     s0, t0, fail

    # C.SRLI rd', shamt (rd' in x8-x15)
    li      s0, 0x8000
    c.srli  s0, 4           # 0x8000 >> 4 = 0x800
    li      t0, 0x800
    bne     s0, t0, fail

    # C.SRAI rd', shamt (rd' in x8-x15)
    li      s0, -256
    c.srai  s0, 4           # -256 >> 4 = -16 (arithmetic)
    li      t0, -16
    bne     s0, t0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 4: C.AND / C.OR / C.XOR / C.SUB / C.ADDW / C.SUBW ======
    la      a1, t4_msg
    li      a2, 24
    jal     ra, print

    # C.AND (rd', rs2' both in x8-x15)
    li      s0, 0xFF0
    li      s1, 0x0FF
    c.and   s0, s1          # 0xFF0 & 0x0FF = 0x0F0
    li      t0, 0x0F0
    bne     s0, t0, fail

    # C.OR
    li      s0, 0xF00
    li      s1, 0x0F0
    c.or    s0, s1          # 0xF00 | 0x0F0 = 0xFF0
    li      t0, 0xFF0
    bne     s0, t0, fail

    # C.XOR
    li      s0, 0xFF
    li      s1, 0x0F
    c.xor   s0, s1          # 0xFF ^ 0x0F = 0xF0
    li      t0, 0xF0
    bne     s0, t0, fail

    # C.SUB
    li      s0, 100
    li      s1, 30
    c.sub   s0, s1          # 100 - 30 = 70
    li      t0, 70
    bne     s0, t0, fail

    # C.ADDW
    li      s0, 0x7FFFFFFF
    li      s1, 1
    c.addw  s0, s1          # overflow to -2147483648 (sign-ext 32-bit)
    li      t0, -2147483648
    bne     s0, t0, fail

    # C.SUBW
    li      s0, 10
    li      s1, 20
    c.subw  s0, s1          # 10 - 20 = -10 (sign-ext 32-bit)
    li      t0, -10
    bne     s0, t0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 5: C.BEQZ / C.BNEZ ======
    la      a1, t5_msg
    li      a2, 24
    jal     ra, print

    # C.BEQZ rs1' (rs1' in x8-x15)
    li      s0, 0
    c.beqz  s0, .beqz_ok
    j       fail
.beqz_ok:

    li      s0, 1
    c.beqz  s0, fail        # should NOT branch (s0 != 0)

    # C.BNEZ rs1'
    li      s0, 31
    c.bnez  s0, .bnez_ok
    j       fail
.bnez_ok:

    li      s0, 0
    c.bnez  s0, fail        # should NOT branch (s0 == 0)

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 6: C.J / C.JR / C.JALR ======
    la      a1, t6_msg
    li      a2, 24
    jal     ra, print

    # C.J offset
    c.j     .j_target
    j       fail
.j_target:

    # C.JR rs1 (indirect jump, no link)
    la      t0, .jr_target
    c.jr    t0
    j       fail
.jr_target:

    # C.JALR rs1 (indirect jump + link to ra)
    la      t0, .jalr_target
    c.jalr  t0
    j       .jalr_returned
.jalr_target:
    c.jr    ra              # return via ra
.jalr_returned:

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 7: C.LW / C.SW (register-offset, rd'/rs' in x8-x15) ======
    la      a1, t7_msg
    li      a2, 24
    jal     ra, print

    la      s0, scratch
    li      s1, 0x12345678
    c.sw    s1, 0(s0)       # store word
    c.lw    a0, 0(s0)       # load word into a0 (x10, in compressed set)
    bne     s1, a0, fail

    # Store at offset 4
    li      s1, 0x0ABCDEF0
    c.sw    s1, 4(s0)
    c.lw    a0, 4(s0)
    bne     s1, a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 8: C.LD / C.SD (register-offset, 64-bit) ======
    la      a1, t8_msg
    li      a2, 24
    jal     ra, print

    la      s0, scratch
    li      s1, 0x123456789ABCDEF0
    c.sd    s1, 0(s0)
    c.ld    a0, 0(s0)       # a0 in compressed set
    bne     s1, a0, fail

    li      s1, 0xFEDCBA9876543210
    c.sd    s1, 8(s0)
    c.ld    a0, 8(s0)
    bne     s1, a0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 9: C.LWSP / C.SWSP (SP-relative) ======
    la      a1, t9_msg
    li      a2, 24
    jal     ra, print

    li      t0, 0x42424242
    c.swsp  t0, 0(sp)
    c.lwsp  t1, 0(sp)
    bne     t0, t1, fail

    li      t0, 0x13131313
    c.swsp  t0, 4(sp)
    c.lwsp  t1, 4(sp)
    bne     t0, t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 10: C.LDSP / C.SDSP (SP-relative, 64-bit) ======
    la      a1, t10_msg
    li      a2, 24
    jal     ra, print

    li      t0, 0xAAAABBBBCCCCDDDD
    c.sdsp  t0, 0(sp)
    c.ldsp  t1, 0(sp)
    bne     t0, t1, fail

    li      t0, 0x1111222233334444
    c.sdsp  t0, 8(sp)
    c.ldsp  t1, 8(sp)
    bne     t0, t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 11: C.ADDI4SPN ======
    la      a1, t11_msg
    li      a2, 24
    jal     ra, print

    # C.ADDI4SPN rd', sp, nzuimm (rd' in x8-x15)
    c.addi4spn s0, sp, 16
    addi    t0, sp, 16
    bne     s0, t0, fail

    c.addi4spn s0, sp, 252  # near-max offset (multiple of 4)
    addi    t0, sp, 252
    bne     s0, t0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 12: C.ADDI16SP ======
    la      a1, t12_msg
    li      a2, 24
    jal     ra, print

    mv      t0, sp          # save sp
    c.addi16sp sp, 32       # sp += 32
    addi    t1, t0, 32
    bne     sp, t1, fail
    c.addi16sp sp, -32      # restore sp
    bne     sp, t0, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 13: C.LUI ======
    la      a1, t13_msg
    li      a2, 24
    jal     ra, print

    c.lui   t0, 1           # t0 = 1 << 12 = 0x1000
    li      t1, 0x1000
    bne     t0, t1, fail

    c.lui   t0, 31          # t0 = 31 << 12 = 0x1F000
    li      t1, 0x1F000
    bne     t0, t1, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== All tests passed ======
    la      a1, pass_msg
    li      a2, 36
    jal     ra, print

    li      a7, 93
    li      a0, 0
    ecall

fail:
    la      a1, fail_msg
    li      a2, 7
    li      a7, 64
    li      a0, 2           # stderr
    ecall
    li      a7, 93
    li      a0, 1
    ecall

# print(a1=buf, a2=len)
print:
    li      a7, 64          # SYS_write
    li      a0, 1           # stdout
    ecall
    jalr    zero, 0(ra)

    .section .rodata
t1_msg:   .ascii "Test 1:  C.LI/MV/ADD...  "
t2_msg:   .ascii "Test 2:  C.ADDI/ADDIW.. "
t3_msg:   .ascii "Test 3:  C.SxLI/SxRI... "
t4_msg:   .ascii "Test 4:  C.AND/OR/XOR.. "
t5_msg:   .ascii "Test 5:  C.BEQZ/BNEZ.. "
t6_msg:   .ascii "Test 6:  C.J/JR/JALR... "
t7_msg:   .ascii "Test 7:  C.LW/SW....... "
t8_msg:   .ascii "Test 8:  C.LD/SD....... "
t9_msg:   .ascii "Test 9:  C.LWSP/SWSP.. "
t10_msg:  .ascii "Test10:  C.LDSP/SDSP.. "
t11_msg:  .ascii "Test11:  C.ADDI4SPN... "
t12_msg:  .ascii "Test12:  C.ADDI16SP... "
t13_msg:  .ascii "Test13:  C.LUI......... "
ok_msg:   .ascii "OK\n\0"
fail_msg: .ascii "FAIL!\n\0"
pass_msg: .ascii "\nAll 13 RVC tests passed!\n\n\0\0\0\0\0\0"

    .section .bss
    .align 8
scratch:
    .space 512

    .align 4
stack_area:
    .space 4096
stack_top:
