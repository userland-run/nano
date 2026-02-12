#!/usr/bin/env python3
"""Transform cpu.rs match guard patterns to literal | patterns for WASM br_table."""

import re
import sys

with open('src/cpu.rs', 'r') as f:
    content = f.read()

original = content

# ============================================================
# Type 5: Special MOVSXD — x if (x & 0xFF) == 0x63 && lane == LANE64
# Must be handled BEFORE simple equality to avoid partial match
# ============================================================
content = content.replace(
    'x if (x & 0xFF) == 0x63 && lane == LANE64 =>',
    '0x263 =>'
)

# ============================================================
# Type 4: ALU broad guards
# x if (x & 0xFF) <= 0x3F && ((x & 0xFF) & 7) == N =>
# ============================================================
for n in range(4):
    vals = [i * 8 + n for i in range(8)]  # 0x00+n, 0x08+n, 0x10+n, 0x18+n, 0x20+n, 0x28+n, 0x30+n, 0x38+n
    old = f'x if (x & 0xFF) <= 0x3F && ((x & 0xFF) & 7) == {n} =>'
    parts = []
    for v in vals:
        parts.append(f'0x{v:02X} | 0x{v+0x100:03X} | 0x{v+0x200:03X}')
    new = ' | '.join(parts) + ' =>'
    content = content.replace(old, new)

# ============================================================
# Type 3: OR patterns — multiple opcodes with ||
# x if (x & 0xFF) == 0xA || (x & 0xFF) == 0xB || (x & 0xFF) == 0xC =>
# ============================================================
def replace_or_pattern(m):
    full = m.group(0)
    # Only extract values after '== ', not from the '& 0xFF' mask
    vals_hex = re.findall(r'== (0x[0-9A-Fa-f]+)', full)
    vals = [int(h, 16) for h in vals_hex]
    parts = []
    for v in vals:
        parts.append(f'0x{v:02X} | 0x{v+0x100:03X} | 0x{v+0x200:03X}')
    return ' | '.join(parts) + ' =>'

content = re.sub(
    r'x if (?:\(x & 0xFF\) == 0x[0-9A-Fa-f]+ \|\| )*\(x & 0xFF\) == 0x[0-9A-Fa-f]+ =>',
    replace_or_pattern,
    content
)

# ============================================================
# Type 2: Range patterns
# x if (x & 0xFF) >= 0xNN && (x & 0xFF) <= 0xMM =>
# ============================================================
def replace_range(m):
    lo = int(m.group(1), 16)
    hi = int(m.group(2), 16)
    parts = []
    for v in range(lo, hi + 1):
        parts.append(f'0x{v:02X} | 0x{v+0x100:03X} | 0x{v+0x200:03X}')
    return ' | '.join(parts) + ' =>'

content = re.sub(
    r'x if \(x & 0xFF\) >= (0x[0-9A-Fa-f]+) && \(x & 0xFF\) <= (0x[0-9A-Fa-f]+) =>',
    replace_range,
    content
)

# ============================================================
# Type 1: Simple equality
# x if (x & 0xFF) == 0xNN =>
# ============================================================
def replace_simple(m):
    v = int(m.group(1), 16)
    return f'0x{v:02X} | 0x{v+0x100:03X} | 0x{v+0x200:03X} =>'

content = re.sub(
    r'x if \(x & 0xFF\) == (0x[0-9A-Fa-f]+) =>',
    replace_simple,
    content
)

# ============================================================
# Verify no guards remain in the main match
# ============================================================
remaining = re.findall(r'x if \(x & 0xFF\)', content)
if remaining:
    print(f"WARNING: {len(remaining)} guard patterns remaining!", file=sys.stderr)
    for r in remaining:
        print(f"  {r}", file=sys.stderr)

# Write output
with open('src/cpu.rs', 'w') as f:
    f.write(content)

# Stats
changes = sum(1 for a, b in zip(original, content) if a != b)
print(f"Done. File modified ({len(content)} bytes, ~{changes} chars changed)")
print(f"Remaining 'x if' guards: {len(remaining)}")
