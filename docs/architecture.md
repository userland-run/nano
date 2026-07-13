# Architecture

NanoVM is not a single emulator — it is a **multi-tier execution platform** for running
programs in the browser. A shared `kernel/` provides the OS contract (a bus, a virtual
filesystem, a process router, networking, capabilities, and services); a set of peer
**runners** each execute one kind of program on a different engine; and **apps** are
prebuilt binaries that target a runner's ABI and are delivered through the catalog.

```
                        ┌──────────────────────────────┐
                        │            kernel/            │
                        │  bus · VFS · router · net ·   │
                        │  caps · services · platform   │
                        └──────────────┬───────────────┘
              register delegate(s) via │ router  (runners never import each other)
        ┌───────────────┬──────────────┼───────────────┬───────────────┐
        ▼               ▼              ▼               ▼
   runners/riscv    runners/node   runners/wasm    runners/boa
   RV64 ELF emu     Node.js on     wasm32-wasip1   sandboxed JS
   (Rust→wasm)      host JS        commands        (Boa, Rust→wasm)
        ▲
        │ apps/ (ripgrep, coreutils, …) target a runner ABI, delivered via catalog/CAS
```

## Runners

Each runner is an **engine** that executes a kind of program and registers a spawn
**delegate** with the kernel router. Runners are peers — they never talk to each other
directly, only through the kernel.

| Runner | Runs | Engine | Trust | Speed |
|--------|------|--------|-------|-------|
| [`riscv`](riscv-runner.md) | RV64 ELF (busybox, node) | emulated CPU (Rust→wasm) | fidelity oracle | slow |
| `node` | Node.js | host JS engine | trusted | fast |
| `wasm` | `wasm32-wasip1` commands | host wasm engine | capability-scoped | fast |
| `boa` | untrusted JS | Boa interpreter (Rust→wasm) | sandboxed | medium |

The **RISC-V runner** is the historic "NanoVM" — a full RV64GC Linux userland emulator and
the correctness oracle the faster tiers are validated against. Its internals (the
Bellard-style interpreter, memory layout, VM struct, threading) are documented separately in
[RISC-V Runner](riscv-runner.md). The three reference pages — [Syscalls](syscalls.md),
[Host API](host-api.md), and [Virtual Server](virtual-server.md) — also describe the RISC-V
runner specifically.

## The dependency rule

- A runner imports **only** from `kernel/` — the shared contract (bus IDL, VFS, proc/router,
  net, caps, services) plus shared host infrastructure (`kernel/platform.mjs`, the
  worker-spawn / module-URL abstraction).
- No runner imports another runner's `src`/`host`. Cross-tier interaction goes through
  `router.route()` + `registerDelegate()` + the bus + the shared VFS.
- **Apps** (`apps/core/`) target a runner's ABI (`wasm32-wasip1`, `riscv64-elf`) and are
  consumed via the catalog/CAS — they import nothing.

*Known exception:* `runners/riscv/host/nanovm.mjs` lazy-imports `runners/boa/host/boa.mjs`
for `NanoVM.scripting()` — a pre-existing scripting seam, to be routed through the kernel later.

## The kernel

`kernel/` is the shared OS layer every runner builds on:

- **bus** — the typed IDL for messages between the host, runners, and services.
- **VFS** — the shared virtual filesystem, including the canonical in-memory POSIX filesystem
  at `kernel/vfs/memfs.mjs` (the RISC-V runner's `host/memfs.mjs` re-exports it).
- **proc / router** — process table and the router that dispatches a spawn to the right
  runner's delegate.
- **net**, **caps**, **services** — networking, capability scoping, and shared services.
- **`platform.mjs`** — host infrastructure for spawning workers and resolving module URLs.

## Apps

`apps/` holds upstream tools compiled to a runner ABI — e.g. ripgrep and coreutils built to
`wasm32-wasip1` to run on the `wasm` runner. They are content-addressed and installed on
demand through the catalog, which is also how the RISC-V runner acquires BusyBox, Node.js,
and the devtools now that the default build embeds nothing (see [Build Guide](build.md)).

## Terminal: model / render split

The terminal is split so the model lives inside the guest and the UI lives on the host. The
RISC-V runner's `term.rs` (an ANSI/`vte` parser + a fixed-capacity cell grid) and `tty.rs`
(the tty line discipline + stdin ring) form the **model** inside `nano.wasm`; the separate
`terminal/` web component reads the grid out of linear memory and **renders** it. See
[RISC-V Runner](riscv-runner.md#terminal--console-model) for details.

## Where to go next

- [RISC-V Runner](riscv-runner.md) — the emulator core: interpreter, memory, VM struct, threading.
- [Syscalls](syscalls.md) — the RISC-V runner's Linux syscall ABI.
- [Host API](host-api.md) — the RISC-V runner's WASM ↔ JS boundary and FS_PENDING protocol.
- [Virtual Server](virtual-server.md) — injecting browser HTTP requests into in-guest servers.
- [Build Guide](build.md) — build targets, feature flags, and testing.
