# Building NanoVM

## Prerequisites

- **Rust** (stable toolchain) with `wasm32-unknown-unknown` target
- **Node.js** (v18+) for running tests and the demo dev server
- **Docker** (optional, for building the devenv tarball)

The Rust toolchain is pinned in `rust-toolchain.toml`. The WASM target is added automatically.

## Build Targets

```bash
make build            # Default: fully-bundled wasm/nano.wasm (~68MB)
make build-minimal    # Bare emulator — no bundled binaries (dev; keeps syscall trace)
make build-min        # Release artifact: wasm/nano.min.wasm  (no trace — plain conformance)
make build-trace      # Release artifact: wasm/nano.trace.wasm (per-syscall trace coverage)
make test-trace       # Verify the trace feature gate (min emits no syscalls, trace does)
make clean            # Remove build artifacts
```

`nano.min.wasm` and `nano.trace.wasm` are the two runtimes the app publish pipeline
consumes (see `specs/nano/publish-pipeline.md`); `.github/workflows/release.yml`
builds both — plus `nano-syscalls.json` from `tools/gen-syscalls-json.mjs` — and
attaches them to the GitHub Release on each `v*` tag.

### What gets built

`cargo build --target wasm32-unknown-unknown --release` produces a `.wasm` file which is copied to `wasm/nano.wasm`.

The default build embeds busybox, node, and devenv tools. Use `build-minimal` for a fast build without bundled binaries.

### Feature flags

| Feature | What it embeds | Size impact |
|---------|---------------|-------------|
| `busybox` | `images/busybox` (static RISC-V ELF) | ~1MB |
| `node` | `images/node` (static RISC-V ELF) | ~52MB |
| `devenv` | `build/devenv.tar.gz` (npm, tsc, eslint, prettier) | ~15MB |
| `demo` | All of the above (default) | ~68MB |
| `trace` | nothing; emits `debug_log(0x0A \| nr)` per syscall (default-on; off in `build-min`) | none |

Binaries are embedded via `include_bytes!` into the WASM data section. When a feature is disabled, the corresponding `vm_bundled_*_ptr()` returns 0 and `vm_bundled_*_size()` returns 0.

### Release profile

```toml
[profile.release]
opt-level = 3      # Speed over size (interpreter benefits from speed)
lto = "fat"        # Cross-crate inlining (critical: fuses all #[inline(always)] into exec())
codegen-units = 1  # Single compilation unit (required for fat LTO to work)
panic = "abort"    # No unwinding (saves ~10KB)
strip = true       # Remove debug info
```

### WASM memory configuration (`.cargo/config.toml`)

```
-C link-args=--stack-first -z stack-size=1048576 --initial-memory=4194304 --max-memory=536870912
```

- 1MB stack, 4MB initial memory, 512MB max
- `--stack-first` puts the stack at the bottom of linear memory
- WASM memory is shared (`WebAssembly.Memory({ shared: true })`) for future threading support

## Fast Iteration

```bash
# Type-check only (no linking, ~0.6s)
cargo check --target wasm32-unknown-unknown

# Dev build (opt-level=1, incremental, ~2s)
cargo build --target wasm32-unknown-unknown
```

## Running Tests

```bash
make test             # Build minimal + run all tests
make test-devenv      # Build bundled + run all tests including devenv tools

# Individual test commands:
bash test/run_tests.sh              # Run tests (requires wasm/nano.wasm)
bash test/run_tests.sh --build      # Build test ELFs first (needs riscv64 cross-compiler)
bash test/run_tests.sh --verbose    # With instruction tracing

# Single ELF:
node test/run.mjs test/hello.elf

# BusyBox command:
node test/run.mjs images/busybox --cmd echo Hello

# With syscall tracing:
node test/run.mjs images/busybox --trace --cmd ls /
```

### Test phases

1. **MemFS unit tests** — Pure JS, tests the in-memory filesystem
2. **ELF execution** — hello, test_suite, test_rvc, test_memory, test_syscalls, test_float
3. **BusyBox smoke tests** — 17 applets (echo, cat, sort, id, etc.)
4. **Devenv tool tests** — Node.js, tsc, npm, eslint, prettier (requires `--devenv` flag)

## Building the Devenv

The devenv is a compressed tarball containing Node.js packages (npm, TypeScript, ESLint, Prettier, esbuild) built for the RISC-V target:

```bash
make devenv       # Docker build (~60-90 min first time, cached after)
ls -lh build/devenv.tar.gz
```

The build script is at `build/devenv/build.sh`. It uses a multi-stage Docker build to cross-compile packages for riscv64.

