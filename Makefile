.PHONY: build clean serve

WASM_TARGET = wasm32-unknown-unknown
OUT_DIR = web

build:
	cargo build --target $(WASM_TARGET) --release
	cp target/$(WASM_TARGET)/release/nanovm.wasm $(OUT_DIR)/nanovm.wasm

clean:
	cargo clean
	rm -f $(OUT_DIR)/nanovm.wasm

serve: build
	cd $(OUT_DIR) && python3 -m http.server 8080
