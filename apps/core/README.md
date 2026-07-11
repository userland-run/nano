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

## Layout so far

```
apps/core/
  rg.wasm            first artifact — a minimal `rg --files` (wasm32-wasip1)
  build/rg/          its Rust crate (std-only; `make build-rg`)
```

## Status

**First artifact shipped: `rg.wasm`** — a minimal `rg --files` (recursive
enumeration, ripgrep's hidden/.git skip, `--glob=!` exclusions), the subset the
opencode agent needs before its first model turn. It runs on `runners/wasm` via
the **wasm-app runner** (`runners/wasm/src/wasm-app.mjs`): a registered name is
pinned so `rg …` routes to the wasm tier and sees its spawn cwd as `.` (this is
what forced implementing the shim's `fd_readdir`). `make build-rg` rebuilds it;
`runners/wasm/test/wasm-app.mjs` covers it.

**Next:** search mode via the upstream regex/`grep` crate (where compiling
upstream beats reimplementing), then `uutils/coreutils` → wasm.
