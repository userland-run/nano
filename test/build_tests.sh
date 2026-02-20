#!/bin/bash
# Build RISC-V test ELF binaries from assembly sources.
# Requires: riscv64-linux-gnu-as and riscv64-linux-gnu-ld (or riscv64-unknown-elf-*)
#
# Usage: bash test/build_tests.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect cross-compiler prefix
if command -v riscv64-linux-gnu-as &>/dev/null; then
    AS=riscv64-linux-gnu-as
    LD=riscv64-linux-gnu-ld
elif command -v riscv64-unknown-elf-as &>/dev/null; then
    AS=riscv64-unknown-elf-as
    LD=riscv64-unknown-elf-ld
elif command -v riscv64-elf-as &>/dev/null; then
    AS=riscv64-elf-as
    LD=riscv64-elf-ld
else
    echo "ERROR: No RISC-V cross-assembler found."
    echo "Install one of:"
    echo "  - riscv64-linux-gnu-binutils (Debian/Ubuntu: apt install binutils-riscv64-linux-gnu)"
    echo "  - riscv64-unknown-elf-binutils (macOS: brew install riscv64-elf-binutils)"
    exit 1
fi

echo "Using assembler: $AS"
echo "Using linker:    $LD"
echo ""

# Assembly files to build
TESTS=(
    hello
    test_suite
    test_rvc
    test_memory
    test_syscalls
    test_float
)

BUILT=0
FAILED=0

for name in "${TESTS[@]}"; do
    src="$SCRIPT_DIR/${name}.S"
    obj="$SCRIPT_DIR/${name}.o"
    elf="$SCRIPT_DIR/${name}.elf"

    if [ ! -f "$src" ]; then
        echo "SKIP: $src (not found)"
        continue
    fi

    echo -n "Building ${name}.elf ... "
    if $AS -march=rv64gc -mabi=lp64d "$src" -o "$obj" 2>/dev/null && \
       $LD "$obj" -o "$elf" 2>/dev/null; then
        rm -f "$obj"
        echo "OK ($(wc -c < "$elf" | tr -d ' ') bytes)"
        BUILT=$((BUILT + 1))
    else
        rm -f "$obj"
        echo "FAILED"
        FAILED=$((FAILED + 1))
    fi
done

echo ""
echo "Built: $BUILT  Failed: $FAILED"
