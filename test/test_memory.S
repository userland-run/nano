# RISC-V 64-bit memory operation test suite for NanoVM
# Tests all load/store widths, sign extension, misalignment, and bulk operations
# Exercises mem.rs read/write functions

    .section .text
    .global _start

_start:
    # ====== Test 1: Byte loads - signed vs unsigned ======
    la      a1, t1_msg
    li      a2, 24
    jal     ra, print

    la      t0, test_bytes

    # Load unsigned byte (0x80 = 128)
    lbu     t1, 0(t0)
    li      t2, 0x80
    bne     t1, t2, fail

    # Load signed byte (0x80 = -128 sign-extended)
    lb      t1, 0(t0)
    li      t2, -128
    bne     t1, t2, fail

    # Load unsigned byte (0x7F = 127)
    lbu     t1, 1(t0)
    li      t2, 0x7F
    bne     t1, t2, fail

    # Load signed byte (0x7F = 127, no sign extension)
    lb      t1, 1(t0)
    li      t2, 127
    bne     t1, t2, fail

    # Load unsigned byte (0xFF = 255)
    lbu     t1, 2(t0)
    li      t2, 0xFF
    bne     t1, t2, fail

    # Load signed byte (0xFF = -1 sign-extended)
    lb      t1, 2(t0)
    li      t2, -1
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 2: Halfword loads - signed vs unsigned ======
    la      a1, t2_msg
    li      a2, 24
    jal     ra, print

    la      t0, test_halfs

    # Load unsigned halfword (0x8000 = 32768)
    lhu     t1, 0(t0)
    li      t2, 0x8000
    bne     t1, t2, fail

    # Load signed halfword (0x8000 = -32768 sign-extended)
    lh      t1, 0(t0)
    li      t2, -32768
    bne     t1, t2, fail

    # Load unsigned halfword (0x7FFF = 32767)
    lhu     t1, 2(t0)
    li      t2, 0x7FFF
    bne     t1, t2, fail

    # Load signed halfword (0x7FFF = 32767, positive)
    lh      t1, 2(t0)
    li      t2, 32767
    bne     t1, t2, fail

    # Load unsigned halfword (0xFFFF = 65535)
    lhu     t1, 4(t0)
    li      t2, 0xFFFF
    bne     t1, t2, fail

    # Load signed halfword (0xFFFF = -1 sign-extended)
    lh      t1, 4(t0)
    li      t2, -1
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 3: Word loads - signed (lw) vs unsigned (lwu) ======
    la      a1, t3_msg
    li      a2, 24
    jal     ra, print

    la      t0, test_words

    # lwu: unsigned word (0x80000000 = 2147483648)
    lwu     t1, 0(t0)
    li      t2, 0x80000000
    bne     t1, t2, fail

    # lw: signed word (0x80000000 = -2147483648 sign-extended to 64-bit)
    lw      t1, 0(t0)
    li      t2, -2147483648
    bne     t1, t2, fail

    # lwu: unsigned (0x7FFFFFFF)
    lwu     t1, 4(t0)
    li      t2, 0x7FFFFFFF
    bne     t1, t2, fail

    # lw: signed (0x7FFFFFFF = positive)
    lw      t1, 4(t0)
    li      t2, 0x7FFFFFFF
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 4: Doubleword load/store ======
    la      a1, t4_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch

    # 64-bit pattern
    li      t1, 0x123456789ABCDEF0
    sd      t1, 0(t0)
    ld      t2, 0(t0)
    bne     t1, t2, fail

    # All ones
    li      t1, -1
    sd      t1, 8(t0)
    ld      t2, 8(t0)
    bne     t1, t2, fail

    # Zero
    sd      zero, 16(t0)
    ld      t2, 16(t0)
    bnez    t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 5: Store byte / halfword / word and read back ======
    la      a1, t5_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch

    # Zero out 16 bytes
    sd      zero, 0(t0)
    sd      zero, 8(t0)

    # Store byte
    li      t1, 0xAB
    sb      t1, 0(t0)
    lbu     t2, 0(t0)
    bne     t1, t2, fail

    # Store halfword
    li      t1, 0xCDEF
    sh      t1, 2(t0)
    lhu     t2, 2(t0)
    bne     t1, t2, fail

    # Store word
    li      t1, 0x12345678
    sw      t1, 4(t0)
    lwu     t2, 4(t0)
    bne     t1, t2, fail

    # Verify byte at offset 0 wasn't overwritten
    lbu     t2, 0(t0)
    li      t3, 0xAB
    bne     t2, t3, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 6: Misaligned halfword access ======
    la      a1, t6_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch

    # Write a known pattern
    li      t1, 0xDDCCBBAA
    sw      t1, 0(t0)

    # Read halfword at offset 1 (misaligned)
    lhu     t2, 1(t0)
    # In little-endian: bytes are AA BB CC DD
    # Offset 1 reads bytes BB CC = 0xCCBB
    li      t3, 0xCCBB
    bne     t2, t3, fail

    # Write halfword at misaligned offset
    li      t1, 0x1234
    sh      t1, 1(t0)
    lhu     t2, 1(t0)
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 7: Misaligned word access ======
    la      a1, t7_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch

    # Write at offset 1 (misaligned word)
    li      t1, 0x11223344
    sw      t1, 1(t0)
    lwu     t2, 1(t0)
    bne     t1, t2, fail

    # Write at offset 2
    li      t1, 0xAABBCCDD
    sw      t1, 2(t0)
    lwu     t2, 2(t0)
    bne     t1, t2, fail

    # Write at offset 3
    li      t1, 0xDEADBEEF
    sw      t1, 3(t0)
    lwu     t2, 3(t0)
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 8: Misaligned doubleword access ======
    la      a1, t8_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch
    addi    t0, t0, 64      # use a clean area

    li      t1, 0xFEDCBA9876543210
    sd      t1, 1(t0)       # misaligned by 1
    ld      t2, 1(t0)
    bne     t1, t2, fail

    sd      t1, 3(t0)       # misaligned by 3
    ld      t2, 3(t0)
    bne     t1, t2, fail

    sd      t1, 5(t0)       # misaligned by 5
    ld      t2, 5(t0)
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 9: Sequential byte writes composing a word ======
    la      a1, t9_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch
    addi    t0, t0, 128     # clean area

    # Write 4 bytes individually (little-endian: 0x44332211)
    li      t1, 0x11
    sb      t1, 0(t0)
    li      t1, 0x22
    sb      t1, 1(t0)
    li      t1, 0x33
    sb      t1, 2(t0)
    li      t1, 0x44
    sb      t1, 3(t0)

    # Read as word
    lwu     t2, 0(t0)
    li      t3, 0x44332211
    bne     t2, t3, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 10: Large offset loads ======
    la      a1, t10_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch

    # Write at large offset (within scratch area)
    li      t1, 0xBEEFCAFE
    sw      t1, 256(t0)
    lwu     t2, 256(t0)
    bne     t1, t2, fail

    li      t1, 0x0BADC0DEDEADBEEF
    sd      t1, 384(t0)
    ld      t2, 384(t0)
    bne     t1, t2, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 11: Byte fill and verify ======
    la      a1, t11_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch
    addi    t0, t0, 192     # clean area

    # Fill 8 bytes with incrementing pattern
    li      t1, 0x10
    sb      t1, 0(t0)
    addi    t1, t1, 1
    sb      t1, 1(t0)
    addi    t1, t1, 1
    sb      t1, 2(t0)
    addi    t1, t1, 1
    sb      t1, 3(t0)
    addi    t1, t1, 1
    sb      t1, 4(t0)
    addi    t1, t1, 1
    sb      t1, 5(t0)
    addi    t1, t1, 1
    sb      t1, 6(t0)
    addi    t1, t1, 1
    sb      t1, 7(t0)

    # Verify as doubleword (little-endian: 0x1716151413121110)
    ld      t2, 0(t0)
    li      t3, 0x1716151413121110
    bne     t2, t3, fail

    la      a1, ok_msg
    li      a2, 4
    jal     ra, print

    # ====== Test 12: Negative immediate offsets ======
    la      a1, t12_msg
    li      a2, 24
    jal     ra, print

    la      t0, scratch
    addi    t0, t0, 256     # point to middle of scratch

    # Write at base
    li      t1, 0xAAAAAAAA
    sw      t1, 0(t0)

    # Write before base (negative offset)
    li      t1, 0xBBBBBBBB
    sw      t1, -4(t0)

    # Read back with negative offset
    lwu     t2, -4(t0)
    li      t3, 0xBBBBBBBB
    bne     t2, t3, fail

    # Verify base wasn't corrupted
    lwu     t2, 0(t0)
    li      t3, 0xAAAAAAAA
    bne     t2, t3, fail

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
t1_msg:   .ascii "Test 1:  lb/lbu........ "
t2_msg:   .ascii "Test 2:  lh/lhu........ "
t3_msg:   .ascii "Test 3:  lw/lwu........ "
t4_msg:   .ascii "Test 4:  ld/sd......... "
t5_msg:   .ascii "Test 5:  sb/sh/sw...... "
t6_msg:   .ascii "Test 6:  misalign half. "
t7_msg:   .ascii "Test 7:  misalign word. "
t8_msg:   .ascii "Test 8:  misalign dword "
t9_msg:   .ascii "Test 9:  byte compose.. "
t10_msg:  .ascii "Test10:  large offset.. "
t11_msg:  .ascii "Test11:  byte fill..... "
t12_msg:  .ascii "Test12:  neg offset.... "
ok_msg:   .ascii "OK\n\0"
fail_msg: .ascii "FAIL!\n\0"
pass_msg: .ascii "\nAll 12 memory tests passed!\n\n\0\0\0\0\0"

# Test data for sign-extension verification
test_bytes:
    .byte 0x80, 0x7F, 0xFF, 0x00

    .align 2
test_halfs:
    .half 0x8000, 0x7FFF, 0xFFFF

    .align 4
test_words:
    .word 0x80000000, 0x7FFFFFFF

    .section .bss
    .align 8
scratch:
    .space 512
