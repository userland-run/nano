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
TIMEOUT=120

if [ ! -f "$NODE_ELF" ]; then
  echo "ERROR: $NODE_ELF not found (need the RISC-V Node.js binary)"
  exit 1
fi

# Extract ms from "NNNms" at end of BENCH line
extract_ms() {
  echo "$1" | grep 'BENCH:' | sed 's/.*[[:space:]]//' | sed 's/ms$//'
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
printf "  %-20s %12s %12s %10s\n" "Benchmark" "Native(ms)" "NanoVM(ms)" "Slowdown"
printf "  %-20s %12s %12s %10s\n" "───────────────────" "──────────" "──────────" "────────"

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
  nano_out=$(timeout "$TIMEOUT" node "$RUN_MJS" "$NODE_ELF" \
    --load "$bench:/bench/$name.js" \
    --cmd node "/bench/$name.js" 2>/dev/null || true)
  nano_ms=$(extract_ms "$nano_out")
  nano_ms=${nano_ms:-0}

  # Calculate slowdown
  if [ "$native_ms" -gt 0 ] 2>/dev/null; then
    slowdown=$(awk "BEGIN { printf \"%.0fx\", $nano_ms / $native_ms }")
  elif [ "$nano_ms" -gt 0 ] 2>/dev/null; then
    slowdown="∞"
  else
    slowdown="n/a"
  fi

  printf "  %-20s %12s %12s %10s\n" "$name" "${native_ms}" "${nano_ms}" "$slowdown"

  total_native=$((total_native + native_ms))
  total_nano=$((total_nano + nano_ms))
  count=$((count + 1))
done

# Summary
printf "  %-20s %12s %12s %10s\n" "───────────────────" "──────────" "──────────" "────────"
if [ "$total_native" -gt 0 ] 2>/dev/null; then
  total_slow=$(awk "BEGIN { printf \"%.0fx\", $total_nano / $total_native }")
  avg_slow=$(awk "BEGIN { printf \"%.0fx\", $total_nano / $total_native }")
else
  total_slow="n/a"
  avg_slow="n/a"
fi
printf "  %-20s %12s %12s %10s\n" "TOTAL" "$total_native" "$total_nano" "$total_slow"
printf "\n"
