# apps/core — core system apps (wasm)

The `nano-core-apps` set: upstream Unix tools **compiled to `wasm32-wasip1`** and
run on the wasm runner (`runners/wasm`) — fast (host wasm engine, no emulation),
GNU-compatible (compiled from the real tools, not reimplemented), and installed
through the catalog/CAS like any other app.

An **app** targets a runner's ABI; it never imports runner code. These modules
run under `runners/wasm` (routed via the Kernel `wasm` tier) and are
difftested against the RISC-V BusyBox oracle (`runners/riscv/images/busybox`).

## Planned contents

| tool | upstream | why compile, not reimplement |
|---|---|---|
| `rg` (ripgrep) | BurntSushi/ripgrep (Rust) | opencode's file enumeration + search; ripgrep-only flags (`--files`, `--json`, `--glob`) |
| coreutils (`ls`/`cat`/`cp`/`mv`/`rm`/`head`/`tail`/`wc`/`sort`/…) | uutils/coreutils (Rust) | GNU-compatible, passes the GNU test suite |
| `fd`, `sd`, `bat` | Rust ecosystem | as demand appears |

## Layout (as tools land)

```
apps/core/
  build/       build configs (cargo → wasm32-wasip1, wasm-opt)
  manifests/   catalog manifests (kind: "wasm-service" / "wasm-app")
  test/        difftest vs the BusyBox oracle
```

## Status

Skeleton. First artifact: **ripgrep → wasm** (unblocks opencode's `rg --files`),
registered via the W-3 WASI service runner with a router pin `rg → wasm`.
