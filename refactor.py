#!/usr/bin/env python3
"""Refactor cpu.rs: split monolithic exec() match into paged dispatch functions.

This script:
1. Reads src/cpu.rs
2. Extracts the match arms from the main dispatch and 0F sub-dispatch
3. Groups them by page (opcode >> 4)
4. Generates page functions with try_or_fault_page! and return true
5. Writes the refactored file
"""

import re
import sys

def read_file(path):
    with open(path, 'r') as f:
        return f.readlines()

def extract_idx_values(pattern):
    """Extract all hex literal values from a match pattern like '0x90 | 0x190 | 0x290'.
    Also handles range patterns like '0x80..=0x8F' by expanding them."""
    # First handle range patterns like 0x80..=0x8F
    result = []
    range_pat = re.compile(r'(0x[0-9a-fA-F]+)\.\.\=(0x[0-9a-fA-F]+)')
    remaining = pattern
    for m in range_pat.finditer(pattern):
        lo = int(m.group(1), 16)
        hi = int(m.group(2), 16)
        result.extend(range(lo, hi + 1))
        remaining = remaining.replace(m.group(0), '')
    # Then handle individual values
    for x in re.findall(r'0x[0-9a-fA-F]+', remaining):
        result.append(int(x.strip(), 16))
    return result

def idx_to_opcode(idx_val):
    """Convert an idx value (opcode + lane) to the base opcode."""
    return idx_val & 0xFF

def opcode_to_page(opcode):
    """Get the page number (0-15) for an opcode."""
    return opcode >> 4

def parse_match_arms(lines, start_line, end_line):
    """Parse match arms from lines[start_line:end_line].

    Returns list of (pattern, body_lines, line_start, line_end) tuples.
    The pattern is the raw text before '=>'.
    body_lines are the lines of the arm body (inside the braces).
    """
    arms = []
    i = start_line

    while i < end_line:
        line = lines[i]
        stripped = line.strip()

        # Skip empty lines and comment-only lines
        if not stripped or stripped.startswith('//'):
            i += 1
            continue

        # Check if this line contains a match arm pattern with =>
        if '=>' in stripped and not stripped.startswith('//'):
            # Find the => in the actual line
            arrow_idx = line.index('=>')
            pattern = line[:arrow_idx].strip()
            after_arrow = line[arrow_idx+2:].strip()

            if after_arrow == '{':
                # Multi-line body - count braces to find the end
                brace_depth = 1
                body_start = i + 1
                j = body_start
                while j < end_line and brace_depth > 0:
                    for ch in lines[j]:
                        if ch == '{':
                            brace_depth += 1
                        elif ch == '}':
                            brace_depth -= 1
                    if brace_depth > 0:
                        j += 1
                    else:
                        break
                # lines[body_start:j] are the body lines (j is the closing } line)
                body = lines[body_start:j]
                arms.append((pattern, body, i, j + 1))
                i = j + 1
            elif after_arrow.startswith('{') and after_arrow.endswith('}'):
                # Single-line body like { cpu.rflags &= !DF; }
                body_content = after_arrow[1:-1].strip()
                arms.append((pattern, ['                ' + body_content + '\n'] if body_content else [], i, i + 1))
                i += 1
            else:
                # Expression arm (rare in this code)
                arms.append((pattern, ['                ' + after_arrow + '\n'], i, i + 1))
                i += 1
        else:
            i += 1

    return arms

def get_opcodes_for_arm(pattern):
    """Get the set of base opcodes from a match pattern."""
    idx_values = extract_idx_values(pattern)
    opcodes = set()
    for v in idx_values:
        opcodes.add(idx_to_opcode(v))
    return opcodes

def get_pages_for_arm(pattern):
    """Get the set of pages this arm spans."""
    opcodes = get_opcodes_for_arm(pattern)
    return set(opcode_to_page(op) for op in opcodes)

def filter_pattern_for_page(pattern, page):
    """Filter a match pattern to only include idx values for the given page."""
    idx_values = extract_idx_values(pattern)
    kept = [v for v in idx_values if opcode_to_page(idx_to_opcode(v)) == page]
    if not kept:
        return None
    return ' | '.join(f'0x{v:X}' for v in kept)

def transform_body_for_page(body_lines):
    """Transform match arm body for use in a page function.

    - try_or_fault!(cpu, ...) -> try_or_fault_page!(cpu, ...)
    - continue; -> return true;
    - return budget; -> { cpu.halted = true; return false; }  (for HLT)
    """
    result = []
    for line in body_lines:
        # Replace try_or_fault! with try_or_fault_page!
        line = line.replace('try_or_fault!(', 'try_or_fault_page!(')
        # Replace 'continue;' with 'return true;'
        # Be careful to only replace standalone continue, not in comments
        line = re.sub(r'\bcontinue\s*;', 'return true;', line)
        # Replace 'return budget;' with halted pattern
        line = line.replace('return budget;', '{ cpu.halted = true; return false; }')
        result.append(line)
    return result

def make_opcode_pattern(opcodes, arm_pattern):
    """Create a match pattern using opcode values (not idx values).

    For a set of base opcodes, create a pattern like '0x90 | 0x91 | 0x92'.
    Uses ranges where possible.
    """
    sorted_ops = sorted(set(opcodes))
    # Check if it's a contiguous range (2+ elements)
    if len(sorted_ops) >= 2 and sorted_ops == list(range(sorted_ops[0], sorted_ops[-1] + 1)):
        return f'0x{sorted_ops[0]:02X}..=0x{sorted_ops[-1]:02X}'
    return ' | '.join(f'0x{op:02X}' for op in sorted_ops)

def generate_page_function(page_num, arms_for_page, is_0f=False):
    """Generate a page function for the given page.

    arms_for_page: list of (original_pattern, body_lines, opcodes_in_this_page)
    """
    if is_0f:
        fn_name = f'exec_0f_page_{page_num:x}'
        param_name = 'op2'
        fn_sig = f'unsafe fn {fn_name}(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, {param_name}: u8, lane: u32) -> bool'
    else:
        fn_name = f'exec_page_{page_num:x}'
        param_name = 'opcode'
        fn_sig = f'unsafe fn {fn_name}(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, {param_name}: u8, lane: u32) -> bool'

    result = []
    result.append(f'#[allow(unused_variables, unreachable_code)]\n')
    result.append(f'{fn_sig} {{\n')
    result.append(f'    match {param_name} {{\n')

    for (original_pattern, body_lines, opcodes) in arms_for_page:
        # Create opcode-based pattern
        pattern = make_opcode_pattern(opcodes, original_pattern)
        transformed_body = transform_body_for_page(body_lines)

        if not transformed_body or (len(transformed_body) == 1 and not transformed_body[0].strip()):
            result.append(f'        {pattern} => {{}}\n')
        else:
            result.append(f'        {pattern} => {{\n')
            for bline in transformed_body:
                result.append(bline)
            result.append(f'        }}\n')

    # Default arm
    result.append(f'        _ => {{ raise_exception(cpu, EXC_UD, 0); return true; }}\n')
    result.append(f'    }}\n')
    result.append(f'    false\n')
    result.append(f'}}\n')

    return result

def find_0f_match_range(lines, of_arm_start):
    """Find the inner 'match op2 { ... }' range within the 0x0F arm."""
    # Search for 'match op2 {' starting from the 0F arm
    match_start = None
    for i in range(of_arm_start, len(lines)):
        if 'match op2 {' in lines[i]:
            match_start = i
            break

    if match_start is None:
        return None, None

    # Find matching closing brace
    brace_depth = 1
    j = match_start + 1
    while j < len(lines) and brace_depth > 0:
        for ch in lines[j]:
            if ch == '{':
                brace_depth += 1
            elif ch == '}':
                brace_depth -= 1
        if brace_depth > 0:
            j += 1
        else:
            break

    return match_start, j

def main():
    lines = read_file('src/cpu.rs')

    # Find key line numbers (0-indexed)
    exec_fn_line = None
    match_idx_line = None

    for i, line in enumerate(lines):
        if 'pub unsafe fn exec(' in line:
            exec_fn_line = i
        if '        match idx {' in line and exec_fn_line is not None and match_idx_line is None:
            match_idx_line = i

    if match_idx_line is None:
        print("ERROR: Could not find 'match idx {' in exec()", file=sys.stderr)
        sys.exit(1)

    # Find the end of the match idx block
    brace_depth = 1
    match_end_line = match_idx_line + 1
    while match_end_line < len(lines) and brace_depth > 0:
        for ch in lines[match_end_line]:
            if ch == '{':
                brace_depth += 1
            elif ch == '}':
                brace_depth -= 1
        if brace_depth > 0:
            match_end_line += 1
        else:
            break

    # Find the end of exec() - two more closing braces (loop and fn)
    exec_end_line = match_end_line + 1
    brace_count = 0
    while exec_end_line < len(lines):
        s = lines[exec_end_line].strip()
        if s == '}':
            brace_count += 1
            if brace_count >= 2:
                exec_end_line += 1
                break
        exec_end_line += 1

    print(f"exec() function: lines {exec_fn_line+1}-{exec_end_line}", file=sys.stderr)
    print(f"match idx: lines {match_idx_line+1}-{match_end_line+1}", file=sys.stderr)

    # Parse main dispatch arms
    main_arms = parse_match_arms(lines, match_idx_line + 1, match_end_line)
    print(f"Found {len(main_arms)} main dispatch arms", file=sys.stderr)

    # Find the 0F arm and parse its sub-dispatch
    of_arm = None
    of_arm_idx = None
    for idx, (pattern, body, start, end) in enumerate(main_arms):
        opcodes = get_opcodes_for_arm(pattern)
        if 0x0F in opcodes and len(opcodes) == 1:
            of_arm = (pattern, body, start, end)
            of_arm_idx = idx
            break

    of_sub_arms = []
    if of_arm:
        # Find 'match op2 {' within the 0F arm body
        of_body_start = of_arm[2] + 1  # Line after the 0F arm pattern
        of_body_end = of_arm[3] - 1    # Line before closing }

        # Search for match op2 within the body
        match_op2_line = None
        for i in range(of_body_start, of_body_end + 1):
            if 'match op2 {' in lines[i]:
                match_op2_line = i
                break

        if match_op2_line is not None:
            # Find end of match op2
            bd = 1
            match_op2_end = match_op2_line + 1
            while match_op2_end < of_body_end + 1 and bd > 0:
                for ch in lines[match_op2_end]:
                    if ch == '{':
                        bd += 1
                    elif ch == '}':
                        bd -= 1
                if bd > 0:
                    match_op2_end += 1
                else:
                    break

            # Parse 0F sub-arms
            of_sub_arms = parse_match_arms(lines, match_op2_line + 1, match_op2_end)
            print(f"Found {len(of_sub_arms)} 0F sub-dispatch arms", file=sys.stderr)

    # Group main arms by page
    main_pages = {i: [] for i in range(16)}
    for (pattern, body, start, end) in main_arms:
        if of_arm and start == of_arm[2]:
            # Skip the 0F arm - we handle it specially
            continue

        opcodes = get_opcodes_for_arm(pattern)
        pages = set(opcode_to_page(op) for op in opcodes)

        for page in pages:
            page_opcodes = sorted(op for op in opcodes if opcode_to_page(op) == page)
            main_pages[page].append((pattern, body, page_opcodes))

    # Group 0F arms by page (using op2 values)
    of_pages = {i: [] for i in range(16)}
    for (pattern, body, start, end) in of_sub_arms:
        # For 0F arms, the pattern values ARE the op2 values directly
        op2_values = extract_idx_values(pattern)
        pages = set(v >> 4 for v in op2_values)

        for page in pages:
            page_op2s = sorted(v for v in op2_values if (v >> 4) == page)
            of_pages[page].append((pattern, body, page_op2s))

    # ===== Now generate the output =====
    output = []

    # 1. Header through try_or_fault! macro (up to and including its closing brace)
    # Find end of try_or_fault! macro using brace-depth counting
    macro_end = None
    for i, line in enumerate(lines):
        if 'macro_rules! try_or_fault' in line and 'try_or_fault_page' not in line:
            brace_depth = 0
            for j in range(i, len(lines)):
                for ch in lines[j]:
                    if ch == '{':
                        brace_depth += 1
                    elif ch == '}':
                        brace_depth -= 1
                if brace_depth == 0 and j > i:
                    macro_end = j + 1
                    break
            break

    # Insert #[allow(unused_macros)] before the try_or_fault! macro
    for line in lines[:macro_end]:
        if 'macro_rules! try_or_fault' in line and 'try_or_fault_page' not in line:
            output.append('#[allow(unused_macros)]\n')
        output.append(line)

    # 2. Add try_or_fault_page! macro
    output.append('\n')
    output.append('/// Try-or-fault for page functions: returns true (fault) instead of continue.\n')
    output.append('macro_rules! try_or_fault_page {\n')
    output.append('    ($cpu:expr, $expr:expr) => {\n')
    output.append('        match $expr {\n')
    output.append('            Ok(v) => v,\n')
    output.append('            Err(e) => {\n')
    output.append('                match e {\n')
    output.append('                    mem::MemFault::PageFault { vaddr, error_code } => {\n')
    output.append('                        $cpu.cr2 = vaddr;\n')
    output.append('                        raise_exception($cpu, EXC_PF, error_code);\n')
    output.append('                    }\n')
    output.append('                    mem::MemFault::DeviceAccess { .. } => {\n')
    output.append('                        raise_exception($cpu, EXC_GP, 0);\n')
    output.append('                    }\n')
    output.append('                }\n')
    output.append('                return true;\n')
    output.append('            }\n')
    output.append('        }\n')
    output.append('    };\n')
    output.append('}\n')

    # 3. exec() function with new dispatch
    # Copy from after the macro to the match line, but skip the 'let idx =' line (no longer needed)
    for line in lines[macro_end:match_idx_line]:
        if 'let idx = opcode as u32 + lane;' in line:
            continue
        if line.strip() == '// === Main dispatch ===' :
            continue
        output.append(line)

    # Replace match body with two-level dispatch
    output.append('        // === Main dispatch (paged by opcode high nibble) ===\n')
    output.append('        let page = opcode >> 4;\n')
    output.append('        let fault = match page {\n')
    for p in range(16):
        output.append(f'            0x{p:X} => exec_page_{p:x}(cpu, ram, ram_size, opcode, lane),\n')
    output.append('            _ => unreachable!(),\n')
    output.append('        };\n')
    output.append('        if cpu.halted { return budget; }\n')
    output.append('        if fault { continue; }\n')
    output.append('    }\n')  # close loop
    output.append('}\n')     # close exec
    output.append('\n')

    # 4. Generate main page functions
    for page in range(16):
        arms = main_pages[page]

        output.append(f'// ============================================================\n')
        output.append(f'// Page {page:X}: opcodes 0x{page*16:02X}-0x{page*16+15:02X}\n')
        output.append(f'// ============================================================\n')

        if page == 0:
            # Special: page 0 also handles the 0F prefix dispatch
            output.append(f'#[allow(unused_variables, unreachable_code)]\n')
            output.append(f'unsafe fn exec_page_0(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, opcode: u8, lane: u32) -> bool {{\n')
            output.append(f'    match opcode {{\n')

            # Regular arms for page 0
            for (orig_pat, body, opcodes) in arms:
                pattern = make_opcode_pattern(opcodes, orig_pat)
                transformed = transform_body_for_page(body)
                if not transformed or (len(transformed) == 1 and not transformed[0].strip()):
                    output.append(f'        {pattern} => {{}}\n')
                else:
                    output.append(f'        {pattern} => {{\n')
                    for bline in transformed:
                        output.append(bline)
                    output.append(f'        }}\n')

            # 0F prefix arm
            output.append(f'        0x0F => {{\n')
            output.append(f'            let op2 = try_or_fault_page!(cpu, fetch_imm8(cpu, ram, ram_size));\n')
            output.append(f'            let page2 = op2 >> 4;\n')
            output.append(f'            return match page2 {{\n')
            for p in range(16):
                output.append(f'                0x{p:X} => exec_0f_page_{p:x}(cpu, ram, ram_size, op2, lane),\n')
            output.append(f'                _ => unreachable!(),\n')
            output.append(f'            }};\n')
            output.append(f'        }}\n')

            output.append(f'        _ => {{ raise_exception(cpu, EXC_UD, 0); return true; }}\n')
            output.append(f'    }}\n')
            output.append(f'    false\n')
            output.append(f'}}\n\n')
        else:
            output.extend(generate_page_function(page, arms))
            output.append('\n')

    # 5. Generate 0F page functions
    for page in range(16):
        arms = of_pages[page]

        output.append(f'// ============================================================\n')
        output.append(f'// 0F Page {page:X}: op2 0x{page*16:02X}-0x{page*16+15:02X}\n')
        output.append(f'// ============================================================\n')
        output.extend(generate_page_function(page, arms, is_0f=True))
        output.append('\n')

    # 6. Helper functions (everything after exec())
    # Find where helpers start (after exec end)
    output.extend(lines[exec_end_line:])

    # Write output
    with open('src/cpu.rs', 'w') as f:
        f.writelines(output)

    total_lines = len(output)
    print(f"Written {total_lines} lines to src/cpu.rs", file=sys.stderr)

if __name__ == '__main__':
    main()
