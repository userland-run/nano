.PHONY: build build-full build-minimal build-min build-trace build-busybox build-boa devenv clean serve test test-build test-devenv test-boa test-boa-vm test-trace demo

WASM_TARGET = wasm32-unknown-unknown
OUT_DIR = wasm

# The shared-memory wasm needs `core` recompiled with the +atomics/+bulk-memory
# target-features (the .cargo/config rustflags). That requires build-std, which
# needs a nightly toolchain + the rust-src component. Passed via the env var
# (more reliable than the `-Z build-std` flag across cargo versions).
BUILD_STD = CARGO_UNSTABLE_BUILD_STD=core,alloc,panic_abort

# Scripting component (Boa). Built as an independent crate with its OWN linear
# memory, so it must NOT inherit nano's .cargo/config.toml rustflags
# (--shared-memory/--import-memory). RUSTFLAGS via the environment fully
# overrides config-file rustflags, which is the only clean way to do that.
BOA_DIR = runners/boa/crate
BOA_RUSTFLAGS = --cfg getrandom_backend="custom"
# wasm-opt needs every wasm feature rustc emits enabled, or it rejects the input.
WASM_OPT_FEATURES = --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int \
                    --enable-mutable-globals --enable-multivalue --enable-reference-types \
                    --enable-extended-const

# Default: SLIM runtime → wasm/nano.wasm (bare emulator + trace). node and devenv
# are NOT embedded — they install from the catalog into the guest VFS on demand.
# No bundled-binary prerequisites; small and fast to build.
build:
	$(BUILD_STD) cargo build --target $(WASM_TARGET) --release
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.wasm

# Legacy all-in-one: bundle busybox + node + devenv into wasm/nano.wasm for a
# fully-offline build (no catalog/CDN at first use). Requires the prebuilt images.
build-full:
	@test -f runners/riscv/images/busybox || (echo "ERROR: runners/riscv/images/busybox not found." && exit 1)
	@test -f runners/riscv/images/node || (echo "ERROR: runners/riscv/images/node not found." && exit 1)
	@test -f build/devenv.tar.gz || (echo "ERROR: build/devenv.tar.gz not found. Run 'make devenv' first." && exit 1)
	gzip -9 -k -f runners/riscv/images/busybox && mv runners/riscv/images/busybox.gz build/busybox.gz
	gzip -9 -k -f runners/riscv/images/node && mv runners/riscv/images/node.gz build/node.gz
	$(BUILD_STD) cargo build --target $(WASM_TARGET) --release --features demo
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.wasm

# Minimal build: bare emulator, no bundled binaries (fast, for development/testing).
# Keeps the `trace` feature so `node test/run.mjs --trace` still counts syscalls.
build-minimal:
	$(BUILD_STD) cargo build --target $(WASM_TARGET) --release --no-default-features --features trace
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.wasm

# Release artifact: plain conformance runtime → wasm/nano.min.wasm (no bundled
# binaries, no per-syscall trace). Used for the pass/fail + golden-output run.
build-min:
	$(BUILD_STD) cargo build --target $(WASM_TARGET) --release --no-default-features
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.min.wasm

# Release artifact: trace conformance runtime → wasm/nano.trace.wasm. Same bare
# emulator, but emits a debug_log(0x0A | nr) on every syscall for coverage.
build-trace:
	$(BUILD_STD) cargo build --target $(WASM_TARGET) --release --no-default-features --features trace
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.trace.wasm

# Release artifact: busybox-bundled runtime → wasm/nano.busybox.wasm. Bare
# emulator + the BusyBox guest only (no node/devenv), small enough to fetch in
# CI. Used by the SDK and terminal smoke runs that must actually execute
# `echo`/`sort`/etc.
build-busybox:
	@test -f runners/riscv/images/busybox || (echo "ERROR: runners/riscv/images/busybox not found." && exit 1)
	gzip -9 -k -f runners/riscv/images/busybox && mv runners/riscv/images/busybox.gz build/busybox.gz
	$(BUILD_STD) cargo build --target $(WASM_TARGET) --release --no-default-features --features busybox
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nano.busybox.wasm

# Scripting engine: build boa.wasm (independent crate). Size-optimizes with
# wasm-opt when available, but never fails the build if wasm-opt is missing or
# rejects the module — it only ever shrinks a valid artifact in place.
build-boa:
	RUSTFLAGS='$(BOA_RUSTFLAGS)' cargo build --release --target $(WASM_TARGET) --manifest-path $(BOA_DIR)/Cargo.toml
	cp $(BOA_DIR)/target/$(WASM_TARGET)/release/boa.wasm $(OUT_DIR)/boa.wasm
	@if command -v wasm-opt >/dev/null 2>&1; then \
		echo "wasm-opt -Oz $(OUT_DIR)/boa.wasm"; \
		if wasm-opt -Oz $(WASM_OPT_FEATURES) $(OUT_DIR)/boa.wasm -o $(OUT_DIR)/boa.wasm.opt 2>/dev/null; then \
			mv $(OUT_DIR)/boa.wasm.opt $(OUT_DIR)/boa.wasm; \
		else \
			rm -f $(OUT_DIR)/boa.wasm.opt; echo "  (wasm-opt rejected module; keeping unoptimized)"; \
		fi; \
	else \
		echo "  (wasm-opt not found; skipping size optimization)"; \
	fi
	@ls -lh $(OUT_DIR)/boa.wasm | awk '{print "boa.wasm:", $$5}'

# Build the devenv tarball (Docker, ~60-90 min first time, cached after)
devenv:
	bash build/devenv/build.sh

clean:
	cargo clean
	cd $(BOA_DIR) && cargo clean
	rm -f $(OUT_DIR)/nano.wasm $(OUT_DIR)/boa.wasm

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

# Run the scripting-layer unit tests (builds boa.wasm first)
test-boa: build-boa
	node test/test_boa.mjs $(OUT_DIR)/boa.wasm

# Integration: a Boa script driving the real emulator (needs bundled nano.wasm)
test-boa-vm: build-boa
	@test -f $(OUT_DIR)/nano.wasm || (echo "ERROR: $(OUT_DIR)/nano.wasm not found. Run 'make build' first." && exit 1)
	node test/test_boa_vm.mjs

# Verify the trace feature gate: build both release wasms, assert nano.trace.wasm
# emits per-syscall events and nano.min.wasm does not.
test-trace: build-min build-trace
	node test/test_trace.mjs

# Run demo dev server (copies WASM to public dir, starts vite)
demo: build build-boa
	mkdir -p web/demo/public
	cp $(OUT_DIR)/nano.wasm web/demo/public/nano.wasm
	cp $(OUT_DIR)/boa.wasm web/demo/public/boa.wasm
	cd web/demo && npm run dev
