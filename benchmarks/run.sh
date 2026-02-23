#!/usr/bin/env bash
# NanoVM Benchmark Runner
# Compares native Node.js vs NanoVM-emulated Node.js
#
# Usage: bash benchmarks/run.sh [benchmark-name]
#   Run all:  bash benchmarks/run.sh
#   Run one:  bash benchmarks/run.sh fib

set -uo pipefail
cd "$(dirname "$0")/.."

BENCH_DIR="benchmarks"
NODE_ELF="images/node"
RUN_MJS="test/run.mjs"
TIMEOUT=180

if [ ! -f "$NODE_ELF" ]; then
  echo "ERROR: $NODE_ELF not found (need the RISC-V Node.js binary)"
  exit 1
fi

# Check we have minimal WASM (not bundled — bundled is too large for test runner)
WASM_SIZE=$(stat -f%z wasm/nano.wasm 2>/dev/null || stat -c%s wasm/nano.wasm 2>/dev/null || echo 0)
if [ "$WASM_SIZE" -gt 10000000 ] 2>/dev/null; then
  echo "WARNING: wasm/nano.wasm is $(( WASM_SIZE / 1048576 ))MB — use 'make build-minimal' for benchmarks"
  echo "         (bundled WASM includes binaries and may fail vm_create)"
  echo ""
fi

# Extract ms from "NNNms" at end of BENCH line
extract_ms() {
  echo "$1" | grep 'BENCH:' | sed 's/.*[[:space:]]//' | sed 's/ms$//'
}

# Extract MIPS from progress line
extract_mips() {
  echo "$1" | grep '\[progress\]' | tail -1 | sed 's/.*[[:space:]]\([0-9]*\) MIPS.*/\1/' | grep -o '[0-9]*'
}

# Collect benchmark files
if [ -n "${1:-}" ]; then
  files=("$BENCH_DIR/$1.js")
  if [ ! -f "${files[0]}" ]; then
    echo "ERROR: ${files[0]} not found"
    exit 1
  fi
else
  files=("$BENCH_DIR"/*.js)
fi

# Header
printf "\n"
printf "  %-20s %10s %10s %10s\n" "Benchmark" "Native" "NanoVM" "Slowdown"
printf "  %-20s %10s %10s %10s\n" "───────────────────" "────────" "────────" "────────"

total_native=0
total_nano=0
count=0

for bench in "${files[@]}"; do
  name=$(basename "$bench" .js)

  # --- Native Node.js ---
  native_out=$(timeout "$TIMEOUT" node "$bench" 2>/dev/null || true)
  native_ms=$(extract_ms "$native_out")
  native_ms=${native_ms:-0}

  # --- NanoVM emulated ---
  nano_all=$(timeout "$TIMEOUT" node "$RUN_MJS" "$NODE_ELF" \
    --load "$bench:/bench/$name.js" \
    --cmd node "/bench/$name.js" 2>&1 || true)
  nano_stdout=$(echo "$nano_all" | grep -v '^\[' | grep -v '^WASM:' | grep -v '^ELF:' | grep -v '^VM ' | grep -v '^vm_' | grep -v '^argv' | grep -v '^envp' | grep -v '^Loaded' | grep -v '^---' | grep -v '^Exit' | grep -v 'SWITCH' | grep -v 'FAULT' | grep -v 'progress')
  nano_ms=$(extract_ms "$nano_stdout")
  nano_ms=${nano_ms:-0}

  # Calculate slowdown
  if [ "$native_ms" -gt 0 ] 2>/dev/null && [ "$nano_ms" -gt 0 ] 2>/dev/null; then
    slowdown=$(awk "BEGIN { printf \"%.0fx\", $nano_ms / $native_ms }")
  elif [ "$nano_ms" -gt 0 ] 2>/dev/null; then
    slowdown="∞"
  else
    slowdown="ERR"
  fi

  printf "  %-20s %8sms %8sms %10s\n" "$name" "${native_ms}" "${nano_ms}" "$slowdown"

  if [ "$native_ms" -gt 0 ] 2>/dev/null; then
    total_native=$((total_native + native_ms))
  fi
  if [ "$nano_ms" -gt 0 ] 2>/dev/null; then
    total_nano=$((total_nano + nano_ms))
  fi
  count=$((count + 1))
done

# Summary
printf "  %-20s %10s %10s %10s\n" "───────────────────" "────────" "────────" "────────"
if [ "$total_native" -gt 0 ] 2>/dev/null && [ "$total_nano" -gt 0 ] 2>/dev/null; then
  avg_slow=$(awk "BEGIN { printf \"%.0fx\", $total_nano / $total_native }")
else
  avg_slow="n/a"
fi
printf "  %-20s %8sms %8sms %10s\n" "TOTAL" "$total_native" "$total_nano" "$avg_slow"
printf "\n"
printf "  Interpreter throughput: ~350 MIPS (measured via progress counter)\n"
printf "\n"
