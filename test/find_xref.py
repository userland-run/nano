#!/usr/bin/env python3
import struct, sys

data = open(sys.argv[1], 'rb').read()

# ELF LOAD segment: file offset 0 -> VA 0x10000
# String at file offset 0x28cde08 -> VA = 0x28cde08 + 0x10000 = 0x28dde08
target = 0x28dde08  # VA of the string

low12 = target & 0xFFF
if low12 >= 0x800:
    upper20 = ((target >> 12) + 1) & 0xFFFFF
    low12_signed = low12 - 0x1000
else:
    upper20 = (target >> 12) & 0xFFFFF
    low12_signed = low12

print(f"Target VA: 0x{target:08x}")
print(f"Upper20: 0x{upper20:05x}, Low12: 0x{low12:03x} (signed: {low12_signed})")

# Search for lui instructions in text section (file offsets 0 to ~0x3378d25)
text_end = 0x3378d25

for rd_num in range(32):
    lui_val = (upper20 << 12) | (rd_num << 7) | 0x37
    pattern = struct.pack('<I', lui_val)
    pos = 0
    while True:
        pos = data.find(pattern, pos, text_end)
        if pos == -1:
            break
        rd_names = ['zero','ra','sp','gp','tp','t0','t1','t2','s0','s1',
                     'a0','a1','a2','a3','a4','a5','a6','a7',
                     's2','s3','s4','s5','s6','s7','s8','s9','s10','s11',
                     't3','t4','t5','t6']
        name = rd_names[rd_num] if rd_num < len(rd_names) else f'x{rd_num}'
        va = pos + 0x10000

        # Check next instruction for addi
        if pos + 8 <= len(data):
            next_instr = struct.unpack('<I', data[pos+4:pos+8])[0]
            if (next_instr & 0x707F) == 0x13:  # addi
                rs1 = (next_instr >> 15) & 0x1F
                rd2 = (next_instr >> 7) & 0x1F
                imm = (next_instr >> 20) & 0xFFF
                if imm >= 0x800:
                    imm -= 0x1000
                if rs1 == rd_num and imm == low12_signed:
                    print(f"MATCH: lui+addi {name},0x{target:08x} at VA 0x{va:x}")

        # Also check for C.LUI (compressed): different encoding
        pos += 2  # 2-byte alignment for RVC
