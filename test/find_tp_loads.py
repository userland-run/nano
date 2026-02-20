#!/usr/bin/env python3
"""Find lw/ld instructions that use TP (x4) as base register,
followed by a conditional branch - potential AllowHeapAllocation CHECK sites."""
import struct, sys

data = open(sys.argv[1], 'rb').read()

# RISC-V I-type instruction layout (LW/LD):
# [31:20] imm  | [19:15] rs1 | [14:12] funct3 | [11:7] rd | [6:0] opcode
# opcode for LOAD = 0b0000011 (0x03)
# funct3 for LW = 0b010 (0x2)
# rs1 = tp = x4 = 0b00100

# For lw rd, imm(tp):
# bits [6:0] = 0000011
# bits [14:12] = 010
# bits [19:15] = 00100

# Mask for matching: bits [6:0] | [14:12] | [19:15]
# = 0x0000007F | (0x7 << 12) | (0x1F << 15)
# = 0x7F | 0x7000 | 0xF8000 = 0xFF7F...
# Actually let's compute properly

mask = 0x7F | (0x7 << 12) | (0x1F << 15)  # opcode + funct3 + rs1
lw_tp = 0x03 | (0x2 << 12) | (0x4 << 15)   # lw, funct3=2, rs1=4(tp)

# Text section: file offset 0 to ~0x3378d25
text_end = min(0x3378d25, len(data))

results = []
pos = 0
while pos < text_end - 8:
    # Read 4-byte instruction (could be 2-byte compressed, check alignment)
    if pos + 4 > len(data):
        break
    insn = struct.unpack('<I', data[pos:pos+4])[0]

    # Check if it's a 32-bit instruction (lowest 2 bits = 11)
    if (insn & 0x3) == 0x3:
        if (insn & mask) == lw_tp:
            rd = (insn >> 7) & 0x1F
            imm = (insn >> 20) & 0xFFF
            if imm >= 0x800:
                imm -= 0x1000  # sign extend
            va = pos + 0x10000  # file offset -> VA

            # Check if next instruction is a branch (conditional)
            # BEQ/BNE: opcode = 0b1100011 (0x63), funct3 = 000(BEQ) or 001(BNE)
            next_pos = pos + 4
            if next_pos + 4 <= len(data):
                next_insn = struct.unpack('<I', data[next_pos:next_pos+4])[0]
                next_op = next_insn & 0x7F
                # Also check 2-byte compressed instructions
                if next_pos + 2 <= len(data):
                    next_c = struct.unpack('<H', data[next_pos:next_pos+2])[0]

                is_branch = False
                # 32-bit branch: BEQ/BNE/BLT/BGE/BLTU/BGEU
                if next_op == 0x63:
                    is_branch = True
                # Compressed: C.BEQZ/C.BNEZ (funct3 = 110/111, op=01)
                elif (next_c & 0xE003) in (0xC001, 0xE001):
                    is_branch = True

                if is_branch:
                    rd_names = ['zero','ra','sp','gp','tp','t0','t1','t2','s0','s1',
                                'a0','a1','a2','a3','a4','a5','a6','a7',
                                's2','s3','s4','s5','s6','s7','s8','s9','s10','s11',
                                't3','t4','t5','t6']
                    rd_name = rd_names[rd] if rd < 32 else f'x{rd}'
                    results.append((va, rd_name, imm))
        pos += 4
    else:
        pos += 2  # compressed instruction

print(f"Found {len(results)} lw rd, imm(tp) followed by branch:")
for va, rd_name, imm in results:
    print(f"  VA 0x{va:x}: lw {rd_name}, {imm}(tp)")
