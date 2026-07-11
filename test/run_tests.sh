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
for kt in "$PROJECT_ROOT"/kernel/test/test_*.mjs; do
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
NODERT_DIR="$PROJECT_ROOT/runners/node"
if [ -f "$NODERT_DIR/vendor/node-lib/index.json" ]; then
    if node "$NODERT_DIR/test/smoke.mjs" 2>/dev/null; then
        ok "nodert smoke (14 programs run on the host engine)"
    else
        fail "nodert smoke"
    fi
    # Differential vs host Node (pure-JS fidelity); --vm mode is @heavy (needs runners/riscv/images/node)
    if node "$NODERT_DIR/test/differential.mjs" 2>/dev/null; then
        ok "nodert differential (vs host-node oracle)"
    else
        fail "nodert differential"
    fi
    # Event-loop ordering harness (§16.2): phase/callback interleave, byte-exact vs oracle
    if node "$NODERT_DIR/test/ordering.mjs" 2>/dev/null; then
        ok "nodert ordering harness (event-loop phases vs host-node oracle)"
    else
        fail "nodert ordering harness"
    fi
    # Engine selector (§14): vm/nodert/auto policy + ERR_NODERT_UNSUPPORTED fallback + pins
    if node "$NODERT_DIR/test/engine.mjs" 2>/dev/null; then
        ok "nodert engine selector (vm/nodert/auto, fallback, routing pins)"
    else
        fail "nodert engine selector"
    fi
    # K9-browser: host loads the node-lib bundle (disk/brotli + gzip/fetch) → boot from bytes
    if node "$NODERT_DIR/test/lib-loader.mjs" 2>/dev/null; then
        ok "nodert lib-loader (browser bundle-in-init: gzip == brotli, boot from bytes)"
    else
        fail "nodert lib-loader"
    fi
    # Cross-tier spawn (nodert → nodert child_process, §12)
    if node "$NODERT_DIR/test/cross-tier.mjs" 2>/dev/null; then
        ok "nodert cross-tier spawn (child_process)"
    else
        fail "nodert cross-tier spawn"
    fi
    # Real-tool proof: the actual TypeScript compiler on the host engine.
    # Self-skips if a typescript checkout isn't reachable (heaviest nodert phase).
    if node "$NODERT_DIR/test/tsc.mjs" 2>/dev/null; then
        ok "nodert real-tool: tsc (version + compile + type-check on the host engine)"
    else
        fail "nodert real-tool: tsc"
    fi
    # Real-app proof: the actual opencode agent CLI (16MB minified ESM) on the
    # host engine. Self-skips if the opencode assets aren't present (terminal/).
    if node "$NODERT_DIR/test/opencode.mjs" 2>/dev/null; then
        ok "nodert real-app: opencode CLI (16MB ESM bundle runs on the host engine)"
    else
        fail "nodert real-app: opencode"
    fi
    # Upstream lib/*.js run verbatim (P2 fidelity)
    if node "$NODERT_DIR/test/upstream.mjs" 2>/dev/null; then
        ok "nodert upstream-verbatim (events/qs/punycode/string_decoder/assert/path/streams/util/console)"
    else
        fail "nodert upstream-verbatim"
    fi
    # M1 net loopback + http server/client (§11)
    if node "$NODERT_DIR/test/net-http.mjs" 2>/dev/null; then
        ok "nodert net+http (loopback, server/client, ServeBridge reachable)"
    else
        fail "nodert net+http"
    fi
    # /dev/__net__ outbound device → Kernel fetch bridge → LLM bridge (nanoinfer)
    if node "$NODERT_DIR/test/llm-bridge.mjs" 2>/dev/null; then
        ok "nodert LLM bridge (/dev/__net__ → nanoinfer, incl. SSE streaming)"
    else
        fail "nodert LLM bridge"
    fi
    # WASM tier W-1: wasip1 apps as Kernel processes (runners/wasm, UL-SPEC/wasm-tier)
    if node "$PROJECT_ROOT/runners/wasm/test/wasm.mjs" 2>/dev/null; then
        ok "wasm tier (wasip1 apps, structural preopens, node→wasm spawn)"
    else
        fail "wasm tier"
    fi
    # WASM tier W-3: WASI service runner (wasm module as a svc.* Kernel Service)
    if node "$PROJECT_ROOT/runners/wasm/test/wasi-service.mjs" 2>/dev/null; then
        ok "WASI service runner (wasm-service over svc.* bus)"
    else
        fail "WASI service runner"
    fi
    # M2 ESM blob-URL loader (§9.2)
    if node "$NODERT_DIR/test/esm.mjs" 2>/dev/null; then
        ok "nodert ESM loader (import/export/TLA/dynamic/cycles/TS via SWC)"
    else
        fail "nodert ESM loader"
    fi
    # M2 worker_threads + fs.watch (§10.3, §6.1)
    if node "$NODERT_DIR/test/worker-watch.mjs" 2>/dev/null; then
        ok "nodert worker_threads + fs.watch"
    else
        fail "nodert worker_threads + fs.watch"
    fi
    # M3 cross-tier chain (node → sh → node; npm lifecycle showcase §12.3)
    if node "$NODERT_DIR/test/cross-tier-chain.mjs" 2>/dev/null; then
        ok "nodert cross-tier chain (npm run build → sh → node)"
    else
        fail "nodert cross-tier chain"
    fi
    # The REAL §12.3 showcase: live NanoVM (BusyBox) as the vm tier + nodert +
    # shared VFS. Needs wasm/nano.wasm + runners/riscv/images/busybox (skips otherwise).
    if [ -f "$PROJECT_ROOT/runners/riscv/runners/riscv/images/busybox" ]; then
        if node "$PROJECT_ROOT/integration/vm-cross-tier.mjs" 2>/dev/null; then
            ok "nodert ↔ real BusyBox cross-tier (§12.3 acceptance, shared VFS)"
        else
            fail "nodert ↔ real BusyBox cross-tier"
        fi
        # Kernel-native applets difftested byte-for-byte vs BusyBox (UL-SPEC/applets)
        if node "$PROJECT_ROOT/integration/applets-difftest.mjs" 2>/dev/null; then
            ok "kernel-native applets == BusyBox (difftest + S2 fallback)"
        else
            fail "kernel-native applets difftest"
        fi
    else
        skip "real-VM cross-tier + applet difftest" "runners/riscv/images/busybox not present"
    fi
else
    skip "nodert tier" "vendored node-lib bundle missing - run 'node runners/node/tools/vendor-node-lib.mjs'"
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
BUSYBOX="$PROJECT_ROOT/runners/riscv/runners/riscv/images/busybox"

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
NODE_BIN="$PROJECT_ROOT/runners/riscv/runners/riscv/images/node"

# Devenv tests need: bundled WASM (>1MB) + node binary + --devenv flag
WASM_SIZE=$(wc -c < "$WASM" | tr -d ' ')
HAS_BUNDLED=0
if [ "$DEVENV" -eq 1 ] && [ "$WASM_SIZE" -gt 1000000 ]; then
    HAS_BUNDLED=1
fi

if [ "$HAS_BUNDLED" -eq 0 ]; then
    skip "Devenv tool tests" "no bundled WASM - run 'make build' then use --devenv"
elif [ ! -f "$NODE_BIN" ]; then
    skip "Devenv tool tests" "runners/riscv/images/node binary not found"
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
    boa_output=$(node "$PROJECT_ROOT/runners/boa/test/test_boa.mjs" "$BOA_WASM" 2>&1)
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
