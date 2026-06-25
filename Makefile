.PHONY: build build-minimal build-min build-trace devenv clean serve test test-build test-devenv test-trace demo

WASM_TARGET = wasm32-unknown-unknown
OUT_DIR = wasm

# Default: fully-bundled build → wasm/nano.wasm (busybox + node + devenv)
build:
	@test -f images/busybox || (echo "ERROR: images/busybox not found." && exit 1)
	@test -f images/node || (echo "ERROR: images/node not found." && exit 1)
	@test -f build/devenv.tar.gz || (echo "ERROR: build/devenv.tar.gz not found. Run 'make devenv' first." && exit 1)
	gzip -9 -k -f images/busybox && mv images/busybox.gz build/busybox.gz
	gzip -9 -k -f images/node && mv images/node.gz build/node.gz
	cargo build --target $(WASM_TARGET) --release
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.wasm

# Minimal build: bare emulator, no bundled binaries (fast, for development/testing).
# Keeps the `trace` feature so `node test/run.mjs --trace` still counts syscalls.
build-minimal:
	cargo build --target $(WASM_TARGET) --release --no-default-features --features trace
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.wasm

# Release artifact: plain conformance runtime → wasm/nano.min.wasm (no bundled
# binaries, no per-syscall trace). Used for the pass/fail + golden-output run.
build-min:
	cargo build --target $(WASM_TARGET) --release --no-default-features
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.min.wasm

# Release artifact: trace conformance runtime → wasm/nano.trace.wasm. Same bare
# emulator, but emits a debug_log(0x0A | nr) on every syscall for coverage.
build-trace:
	cargo build --target $(WASM_TARGET) --release --no-default-features --features trace
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.trace.wasm

# Build the devenv tarball (Docker, ~60-90 min first time, cached after)
devenv:
	bash build/devenv/build.sh

clean:
	cargo clean
	rm -f $(OUT_DIR)/nano.wasm

serve: build
	cd $(OUT_DIR) && python3 -m http.server 8080

# Build test ELF binaries (requires RISC-V cross-compiler)
test-build:
	bash test/build_tests.sh

# Run all tests (builds minimal WASM first, then runs test suite)
test: build-minimal
	bash test/run_tests.sh

# Run all tests including devenv tool tests (requires full bundled build)
test-devenv: build
	bash test/run_tests.sh --devenv

# Verify the trace feature gate: build both release wasms, assert nano.trace.wasm
# emits per-syscall events and nano.min.wasm does not.
test-trace: build-min build-trace
	node test/test_trace.mjs

# Run demo dev server (copies WASM to public dir, starts vite)
demo: build
	mkdir -p web/demo/public
	cp $(OUT_DIR)/nano.wasm web/demo/public/nano.wasm
	cd web/demo && npm run dev
