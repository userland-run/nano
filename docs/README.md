# NanoVM Documentation

NanoVM is a **multi-tier execution platform** for running programs in the browser: a shared
`kernel/` (bus, VFS, router, net, caps, services) plus peer **runners** that each execute a
kind of program on a different engine, and **apps** delivered through the catalog. The
historic RISC-V emulator ("NanoVM") is one of those runners — the high-fidelity oracle the
faster tiers are validated against.

> 📚 The canonical, hosted documentation is at **<https://userland.run/docs/>**. These pages
> are the in-repo source and may be slightly ahead of or behind the site.

## Pages

| Page | What it covers |
|------|----------------|
| [Architecture](architecture.md) | The platform: kernel + peer runners (riscv/node/wasm/boa) + apps, the dependency rule, and the terminal model/render split |
| [RISC-V Runner](riscv-runner.md) | The emulator core — Bellard-style interpreter, memory layout, the 12,680-byte VM struct, threading, and the `runners/riscv/src/` source map |
| [Syscalls](syscalls.md) | The RISC-V runner's Linux syscall ABI (~80 syscalls), by category and handling mode |
| [Host API](host-api.md) | The RISC-V runner's WASM imports/exports and the FS_PENDING request/response protocol |
| [Virtual Server](virtual-server.md) | Injecting browser HTTP requests into in-guest Node servers for the preview iframe |
| [Build Guide](build.md) | Build targets, feature flags, WASM memory config, and the test suite |

## Quick orientation

- **New here?** Start with [Architecture](architecture.md) for the platform shape, then
  [RISC-V Runner](riscv-runner.md) for the emulator internals.
- **Integrating NanoVM?** Most consumers use the [SDK](https://github.com/userland-run/sdk),
  the [`<nano-terminal>`](https://github.com/userland-run/terminal) web component, and the
  [app catalog](https://github.com/userland-run/catalog) rather than the raw VM. See the root
  [README](../README.md#part-of-userlandrun).
- **Building from source?** See the [Build Guide](build.md); `make build` produces the slim
  default `wasm/nano.wasm`.
