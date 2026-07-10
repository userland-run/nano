#!/bin/bash
# NanoVM comprehensive test runner
# Runs all available test suites and reports results.
#
# Usage: bash test/run_tests.sh [--build] [--verbose] [--devenv]
#   --build   Build test ELFs before running (requires cross-compiler)
#   --verbose Pass --verbose to ELF runner for instruction tracing
#   --devenv  Include devenv tool tests (requires bundled WASM from 'make build')

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM="$PROJECT_ROOT/wasm/nano.wasm"
RUNNER="$SCRIPT_DIR/run.mjs"

BUILD=0
VERBOSE=""
DEVENV=0
for arg in "$@"; do
    case "$arg" in
        --build)   BUILD=1 ;;
        --verbose) VERBOSE="--verbose" ;;
        --devenv)  DEVENV=1 ;;
    esac
done

PASS=0
FAIL=0
SKIP=0

# For bundled builds (--devenv), the WASM data section is ~137MB.
# Reduce RAM to avoid exceeding the 2GB WASM memory limit.
if [ "$DEVENV" -eq 1 ]; then
    export NANOVM_RAM_MB=1800
fi

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# When RESULTS_NDJSON is set, append one JSON line per assertion so
# tools/harness-ledger-to-results.mjs can map it to a registry feature and
# publish a `node-harness` suite to the userland.run status hub.
record() { [ -n "${RESULTS_NDJSON:-}" ] && printf '{"name":"%s","status":"%s"}\n' "$1" "$2" >> "$RESULTS_NDJSON"; }
ok()   { echo -e "  ${GREEN}PASS${NC}: $1"; PASS=$((PASS + 1)); record "$1" passed; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; FAIL=$((FAIL + 1)); record "$1" failed; }
skip() { echo -e "  ${YELLOW}SKIP${NC}: $1 ($2)"; SKIP=$((SKIP + 1)); record "$1" skipped; }

# ============================================================
# Phase 0: Prerequisites
# ============================================================

echo "============================================"
echo "  NanoVM Test Suite"
echo "============================================"
echo ""

if [ ! -f "$WASM" ]; then
    echo "ERROR: $WASM not found. Run 'make build' first."
    exit 1
fi

echo "WASM: $WASM ($(wc -c < "$WASM" | tr -d ' ') bytes)"
echo ""

# ============================================================
# Phase 1: Build test ELFs (optional)
# ============================================================

if [ "$BUILD" -eq 1 ]; then
    echo "--- Building test ELFs ---"
    bash "$SCRIPT_DIR/build_tests.sh"
    echo ""
fi

# ============================================================
# Phase 2: MemFS unit tests (pure JS, no WASM needed)
# ============================================================

echo "--- MemFS Unit Tests ---"
if node "$SCRIPT_DIR/test_memfs.mjs" 2>/dev/null; then
    ok "MemFS unit tests"
else
    fail "MemFS unit tests"
fi
echo ""

# ============================================================
# Phase 2b: Net bridge streaming unit tests (pure JS, no WASM needed)
# ============================================================

echo "--- Net Bridge Unit Tests ---"
if node "$SCRIPT_DIR/test_net.mjs" 2>/dev/null; then
    ok "Net bridge streaming unit tests"
else
    fail "Net bridge streaming unit tests"
fi
echo ""

# ============================================================
# Phase 2c: Kernel unit tests (pure JS, no WASM needed)
# ============================================================

echo "--- Kernel Unit Tests ---"
for kt in "$SCRIPT_DIR"/kernel/test_*.mjs; do
    [ -f "$kt" ] || continue
    kt_name="kernel/$(basename "$kt" .mjs)"
    if node "$kt" 2>/dev/null; then
        ok "$kt_name"
    else
        fail "$kt_name"
    fi
done
echo ""

# ============================================================
# Phase 2d: nodert host-engine tier (worker + Kernel bus; no VM needed)
# ============================================================

echo "--- nodert Tier (host engine) ---"
NODERT_DIR="$PROJECT_ROOT/nodert"
if [ -f "$NODERT_DIR/vendor/node-lib/index.json" ]; then
    if node "$NODERT_DIR/test/smoke.mjs" 2>/dev/null; then
        ok "nodert smoke (14 programs run on the host engine)"
    else
        fail "nodert smoke"
    fi
    # Differential vs host Node (pure-JS fidelity); --vm mode is @heavy (needs images/node)
    if node "$NODERT_DIR/test/differential.mjs" 2>/dev/null; then
        ok "nodert differential (vs host-node oracle)"
    else
        fail "nodert differential"
    fi
    # Cross-tier spawn (nodert → nodert child_process, §12)
    if node "$NODERT_DIR/test/cross-tier.mjs" 2>/dev/null; then
        ok "nodert cross-tier spawn (child_process)"
    else
        fail "nodert cross-tier spawn"
    fi
else
    skip "nodert tier" "vendored node-lib bundle missing - run 'node nodert/tools/vendor-node-lib.mjs'"
fi
echo ""

# ============================================================
# Phase 3: ELF execution tests
# ============================================================

echo "--- ELF Execution Tests ---"

# Test ELFs: name|expected_output
run_elf_test() {
    local name="$1" expected="$2"
    local elf="$SCRIPT_DIR/${name}.elf"

    if [ ! -f "$elf" ]; then
        skip "$name" "ELF not found - run with --build"
        return
    fi

    local output exit_code
    output=$(timeout 10 node "$RUNNER" "$elf" $VERBOSE 2>/dev/null)
    exit_code=$?

    if echo "$output" | grep -q "$expected"; then
        ok "$name"
    elif [ $exit_code -eq 124 ]; then
        fail "$name (TIMEOUT)"
    else
        fail "$name (expected: '$expected')"
        echo "$output" | head -5 | sed 's/^/    /'
    fi
}

run_elf_test hello           "Hello from NanoVM"
run_elf_test test_suite      "All 10 tests passed"
run_elf_test test_rvc        "All 13 RVC tests passed"
run_elf_test test_memory     "All 12 memory tests passed"
run_elf_test test_syscalls   "All 15 syscall tests passed"
run_elf_test test_float      "All 14 float tests passed"

echo ""

# ============================================================
# Phase 4: BusyBox smoke tests (if busybox binary exists)
# ============================================================

echo "--- BusyBox Smoke Tests ---"
BUSYBOX="$PROJECT_ROOT/images/busybox"

if [ ! -f "$BUSYBOX" ]; then
    skip "BusyBox smoke tests" "busybox binary not found"
else
    run_bb_test() {
        local name="$1" expected="$2" check="$3"
        shift 3
        # remaining args are the command

        local output exit_code
        output=$(timeout 5 node "$RUNNER" "$BUSYBOX" --cmd "$@" 2>/dev/null)
        exit_code=$?

        if [ "$check" = "exit0" ]; then
            [ $exit_code -eq 0 ] && ok "busybox $name" || fail "busybox $name (exit $exit_code)"
        elif [ "$check" = "exitnon0" ]; then
            [ $exit_code -ne 0 ] && ok "busybox $name" || fail "busybox $name (expected non-zero)"
        elif echo "$output" | grep -q "$expected"; then
            ok "busybox $name"
        elif [ $exit_code -eq 124 ]; then
            fail "busybox $name (TIMEOUT)"
        else
            fail "busybox $name"
        fi
    }

    # Simple applets (no pipes needed)
    run_bb_test echo       "Hello"       grep   echo Hello
    run_bb_test true       ""            exit0  true
    run_bb_test false      ""            exitnon0 false
    run_bb_test uname      "Linux"       grep   uname -a
    run_bb_test basename   "bar.txt"     grep   basename /foo/bar.txt
    run_bb_test dirname    "/foo"        grep   dirname /foo/bar.txt
    run_bb_test cat        "Hello from"  grep   cat /test/hello.txt
    run_bb_test head       "1"           grep   head -1 /test/nums.txt
    run_bb_test tail       "5"           grep   tail -1 /test/nums.txt
    run_bb_test sort       "1"           grep   sort /test/nums.txt
    run_bb_test id         "uid="        grep   id
    run_bb_test pwd        "/"           grep   pwd
    run_bb_test env        "PATH="       grep   env
    run_bb_test whoami     "root"        grep   whoami
    run_bb_test hostname   "nanovm"      grep   hostname
    run_bb_test printf     "42"          grep   printf '%d\n' 42
    run_bb_test seq        "1"           grep   seq 1 3
fi

echo ""

# ============================================================
# Phase 5: Devenv tool tests (requires bundled WASM + node binary)
# ============================================================

echo "--- Devenv Tool Tests ---"
NODE_BIN="$PROJECT_ROOT/images/node"

# Devenv tests need: bundled WASM (>1MB) + node binary + --devenv flag
WASM_SIZE=$(wc -c < "$WASM" | tr -d ' ')
HAS_BUNDLED=0
if [ "$DEVENV" -eq 1 ] && [ "$WASM_SIZE" -gt 1000000 ]; then
    HAS_BUNDLED=1
fi

if [ "$HAS_BUNDLED" -eq 0 ]; then
    skip "Devenv tool tests" "no bundled WASM - run 'make build' then use --devenv"
elif [ ! -f "$NODE_BIN" ]; then
    skip "Devenv tool tests" "images/node binary not found"
else
    # Run a devenv tool via: node <js_path> --version
    run_devenv_tool() {
        local name="$1" js_path="$2" expected="$3"
        local timeout_secs="${4:-120}"

        local output exit_code
        output=$(NANOVM_WASM="$WASM" NANOVM_RAM_MB=1800 timeout "$timeout_secs" node "$RUNNER" "$NODE_BIN" --cmd node "$js_path" --version 2>/dev/null)
        exit_code=$?

        if [ $exit_code -eq 124 ]; then
            fail "devenv $name (TIMEOUT ${timeout_secs}s)"
        elif echo "$output" | grep -qE "$expected"; then
            ok "devenv $name"
        else
            fail "devenv $name"
            echo "$output" | tail -3 | sed 's/^/    /'
        fi
    }

    # Run a devenv test via: node -e "<script>"
    run_devenv_eval() {
        local name="$1" script="$2" expected="$3"
        local timeout_secs="${4:-120}"

        local output exit_code
        output=$(NANOVM_WASM="$WASM" NANOVM_RAM_MB=1800 timeout "$timeout_secs" node "$RUNNER" "$NODE_BIN" --cmd node -e "$script" 2>/dev/null)
        exit_code=$?

        if [ $exit_code -eq 124 ]; then
            fail "devenv $name (TIMEOUT ${timeout_secs}s)"
        elif echo "$output" | grep -qE "$expected"; then
            ok "devenv $name"
        else
            fail "devenv $name"
            echo "$output" | tail -3 | sed 's/^/    /'
        fi
    }

    # Tier 0: Node.js runtime
    run_devenv_tool "node --version"  "--version" "^v[0-9]+"  60

    # Tier 1: Tools with direct JS entry points (use lib/ paths, not bin/ shell wrappers)
    run_devenv_tool tsc       "/usr/local/lib/node_modules/typescript/lib/tsc.js"   "Version"    120
    run_devenv_tool npm       "/usr/local/lib/node_modules/npm/bin/npm-cli.js"      "^[0-9]+\."  180

    # Tier 2: Tools loaded via node -e with absolute paths
    run_devenv_eval "tsc (version)" \
        "const ts=require('/usr/local/lib/node_modules/typescript/lib/typescript.js');console.log(ts.version)" \
        "^[0-9]+\."  120
    run_devenv_eval "eslint (version)" \
        "const e=require('/usr/local/lib/node_modules/eslint');console.log(e.Linter.version)" \
        "^[0-9]+\."  180
    run_devenv_eval "prettier (version)" \
        "const p=require('/usr/local/lib/node_modules/prettier');console.log(p.version)" \
        "^[0-9]+\."  180
fi

echo ""

# ============================================================
# Phase: Scripting layer (Boa / boa.wasm)
# ============================================================
echo "Phase: Scripting layer (Boa)"
BOA_WASM="$PROJECT_ROOT/wasm/boa.wasm"
if [ ! -f "$BOA_WASM" ]; then
    skip "scripting tests" "wasm/boa.wasm not found (run 'make build-boa')"
else
    boa_output=$(node "$SCRIPT_DIR/test_boa.mjs" "$BOA_WASM" 2>&1)
    boa_rc=$?
    boa_summary=$(echo "$boa_output" | grep -E "passed, .* failed" | tail -1)
    if [ "$boa_rc" -eq 0 ]; then
        ok "scripting: ${boa_summary:-all assertions}"
    else
        fail "scripting: ${boa_summary:-failed}"
        echo "$boa_output" | grep -E "FAIL:" | sed 's/^/    /'
    fi
fi

echo ""

# ============================================================
# Summary
# ============================================================

TOTAL=$((PASS + FAIL + SKIP))
echo "============================================"
echo "  Results: $PASS passed, $FAIL failed, $SKIP skipped (${TOTAL} total)"
echo "============================================"

if [ $FAIL -gt 0 ]; then
    exit 1
fi
