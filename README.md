# NanoVM

A RISC-V Linux userland emulator compiled to WebAssembly. Runs BusyBox, Node.js, and the full npm/TypeScript toolchain entirely in the browser — no server required.

> 📚 **Documentation lives at <https://userland.run/docs/>.** This README is a quick orientation; the
> hosted docs cover the CLI/JS API, syscalls, host API, architecture, build, and the full SDK reference.
> NanoVM is the emulator core of **[userland.run](https://userland.run)** — most users consume it through
> the [SDK](https://github.com/userland-run/sdk), the [terminal](https://github.com/userland-run/terminal)
> web component, and the [app catalog](https://github.com/userland-run/catalog) (see
> [Part of userland.run](#part-of-userlandrun) below).

## What it does

NanoVM emulates an RV64GC RISC-V CPU with ~80 Linux syscalls, enough to run:

- **BusyBox** — echo, cat, ls, sort, grep, head, tail, and more
- **Node.js v25** — full runtime with `require()`, fs, path, crypto, http, streams, Buffer, EventEmitter, async/await
- **npm toolchain** — TypeScript compiler, ESLint, Prettier

Everything runs inside a single WASM module. The emulator handles memory management (brk/mmap), file I/O (via an in-memory POSIX filesystem), sockets, epoll, timerfds, futex-based threading, and ELF loading.

The default build is **slim** (~2.4 MB, BusyBox only): Node.js and the dev tools are not embedded — they
are installed on demand from the signed [app catalog](https://github.com/userland-run/catalog) at
runtime. A fully-bundled build (`make build-full`, ~68 MB) embeds BusyBox + Node.js + devenv for offline use.

## Quick start

```bash
# Build the WASM module (~585KB without bundled binaries)
make build

# Run tests
make test

# Run a BusyBox command
node test/run.mjs runners/riscv/images/busybox --cmd echo "Hello from RISC-V"

# Run a Node.js script
node test/run.mjs runners/riscv/images/node --cmd node -e "console.log(process.arch)"
```

## Web demo

The demo is a browser-based IDE with a file tree, code editor, and console/preview panel:

```bash
make demo    # Builds WASM with bundled binaries + starts Vite dev server
```

Requires `runners/riscv/images/busybox`, `runners/riscv/images/node`, and `build/devenv.tar.gz`. See [docs/build.md](docs/build.md) for details.

The demo includes examples that run inside the emulator: basic Node.js (hello world, filesystem, crypto), and HTTP servers with live preview in an iframe via a Service Worker bridge.

## Architecture

NanoVM follows Fabrice Bellard's approach to high-performance WASM interpreters:

- **Monolithic `exec()` function** — Dense dispatch compiles to WASM `br_table` (O(1) jump tables). Source code is split across files with `#[inline(always)]`; fat LTO fuses everything into a single function.
- **`#![no_std]` Rust** — No standard library, no heap allocation in the hot path. Zero crate dependencies (math like `sqrt` lowers straight to WASM opcodes).
- **Minimal host boundary** — 5 WASM imports, ~30 exports. Filesystem I/O goes through a shared-memory protocol, not per-instruction callbacks.
- **Cooperative threading** — clone/futex-based multithreading with context switching at syscall boundaries.

The WASM binary is ~585KB without bundled binaries, or ~68MB with BusyBox + Node.js + devenv embedded.

## Project structure

One shared kernel + peer runners + apps (see [`runners/README.md`](runners/README.md)):

```
kernel/             Shared OS layer: bus IDL, VFS, proc/router, net, caps, services, platform.mjs
runners/
├── riscv/          This emulator
│   ├── src/        RV64GC interpreter — cpu/decode/syscall/mem/elf/types/exports/alloc/host/lib .rs
│   ├── host/       nanovm.mjs (browser wrapper: WASM + MemFS + virtual server) + memfs.mjs
│   └── images/     RISC-V ELF binaries (busybox, node — Git LFS)
├── node/           Node.js on the host JS engine (the `node` delegate)
├── wasm/           wasm32-wasip1 command tier (the `wasm` delegate)
└── boa/            Sandboxed JS: crate/ (nano-boa → boa.wasm) + host/boa.mjs
apps/core/          Upstream tools → wasm (ripgrep, coreutils) that run on runners/wasm
integration/        Cross-runner tests (differential-vs-oracle, cross-tier chains)
bench/              Cross-runner workload benchmarks
web/demo/           React + Vite IDE demo app
test/               RISC-V ELF conformance harness + the top-level test orchestrator
build/              Devenv Docker build scripts
```

A runner imports only from `kernel/` — never another runner (cross-tier goes through the router + bus + shared VFS).

## Documentation

**Full, hosted documentation: <https://userland.run/docs/>** — getting started, CLI & JS API,
syscalls, host API, networking, architecture, performance, build, and the complete SDK reference.

The source pages also live in this repo under `docs/`:

- [Architecture](docs/architecture.md) — Design principles, memory layout, execution model, VM struct
- [Syscalls](docs/syscalls.md) — Complete syscall reference with handling modes
- [Host API](docs/host-api.md) — WASM imports/exports and FS_PENDING protocol
- [Virtual Server](docs/virtual-server.md) — HTTP request injection for the preview iframe
- [Build Guide](docs/build.md) — Build targets, feature flags, testing, devenv setup
- [Demo](docs/demo.md) — Web IDE architecture and Service Worker bridge

## Part of userland.run

NanoVM is the emulator core of the **[userland.run](https://userland.run)** workspace — a set of
repos that turn the raw VM into a product:

| Repo | What it is |
| ---- | ---------- |
| **[nano](https://github.com/userland-run/nano)** | The RV64GC → WASM emulator core — **this repo** |
| [sdk](https://github.com/userland-run/sdk) | `@userland-run/nano-sdk` — typed TypeScript SDK that drives the VM (code / terminal / serve / scripting / worker) |
| [terminal](https://github.com/userland-run/terminal) | `<nano-terminal>` Shadow-DOM web component — the terminal UI, consumed via the SDK |
| [catalog](https://github.com/userland-run/catalog) | Signed, content-addressed app marketplace (node, typescript, eslint, prettier, …) installed on demand |
| [website](https://github.com/userland-run/website) | Landing page + the hosted docs at [userland.run/docs](https://userland.run/docs/) |

## Tests

```
$ make test
============================================
  NanoVM Test Suite
============================================
--- MemFS Unit Tests ---      50 passed
--- ELF Execution Tests ---    6 passed (hello, test_suite, rvc, memory, syscalls, float)
--- BusyBox Smoke Tests ---   17 passed (echo, cat, head, tail, sort, id, ...)
--- Devenv Tool Tests ---      6 passed (node, tsc, npm, eslint, prettier)
============================================
  Results: 24 passed, 0 failed
============================================
```
