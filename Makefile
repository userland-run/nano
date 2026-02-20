.PHONY: build build-bundled build-demo devenv clean serve test test-build test-devenv demo

WASM_TARGET = wasm32-unknown-unknown
OUT_DIR = web

build:
	cargo build --target $(WASM_TARGET) --release
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nanovm.wasm

# Build the devenv tarball (Docker, ~60-90 min first time, cached after)
devenv:
	bash build/devenv/build.sh

# Build WASM with embedded devenv (requires devenv.tar.gz from `make devenv`)
build-bundled:
	@test -f build/devenv.tar.gz || (echo "ERROR: build/devenv.tar.gz not found. Run 'make devenv' first." && exit 1)
	cargo build --target $(WASM_TARGET) --release --features devenv
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nanovm.wasm

# Build WASM with all bundled binaries (busybox + node + devenv)
build-demo:
	@test -f test/busybox || (echo "ERROR: test/busybox not found." && exit 1)
	@test -f test/node || (echo "ERROR: test/node not found." && exit 1)
	@test -f build/devenv.tar.gz || (echo "ERROR: build/devenv.tar.gz not found. Run 'make devenv' first." && exit 1)
	cargo build --target $(WASM_TARGET) --release --features demo
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nanovm.wasm

clean:
	cargo clean
	rm -f $(OUT_DIR)/nanovm.wasm

serve: build
	cd $(OUT_DIR) && python3 -m http.server 8080

# Build test ELF binaries (requires RISC-V cross-compiler)
test-build:
	bash test/build_tests.sh

# Run all tests (builds WASM first, then runs test suite)
test: build
	bash test/run_tests.sh

# Run all tests including devenv tool tests (requires build-bundled + test/node)
test-devenv: build-bundled
	bash test/run_tests.sh --devenv

# Run demo dev server (copies WASM to public dir, starts vite)
demo: build-demo
	mkdir -p web/demo/public
	cp web/nanovm.wasm web/demo/public/nanovm.wasm
	cd web/demo && npm run dev
