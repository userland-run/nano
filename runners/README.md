# runners/ — execution tiers

Each runner is an **engine** that executes a kind of program and registers a
spawn **delegate** with the Kernel router. Runners are peers: they talk to each
other only through the Kernel (router + bus + shared VFS), never by importing
one another.

| runner | runs | engine | trust | speed |
|---|---|---|---|---|
| [`riscv`](riscv) | RV64 ELF (busybox, node) | emulated CPU (Rust→wasm) | fidelity oracle | slow |
| [`node`](node) | Node.js | host JS engine | trusted | fast |
| [`wasm`](wasm) | wasm32-wasip1 commands | host wasm engine | capability-scoped | fast |
| [`boa`](boa) | untrusted JS | Boa interpreter (Rust→wasm) | sandboxed | medium |

## Dependency rule

- A runner imports **only** from [`../kernel`](../kernel) — the shared contract
  (bus IDL, VFS, proc/router, net, caps, services) plus shared host infra
  (`kernel/platform.mjs`, the worker-spawn / module-URL abstraction).
- No runner imports another runner's `src`/`host`. Cross-tier interaction goes
  through `router.route()` + `registerDelegate()` + the bus + the shared VFS.
- **Apps** ([`../apps`](../apps)) target a runner's ABI (`wasm32-wasip1`,
  `riscv64-elf`) and are consumed via the catalog/CAS — they import nothing.

### Known exception

`riscv/host/nanovm.mjs` lazy-imports `boa/host/boa.mjs` for `NanoVM.scripting()`
— the pre-existing scripting seam, to be routed through the Kernel later.

## Layout

```
riscv/  src/ (Rust emulator) · host/ (nanovm.mjs, kernel client) · images/ (RV64 ELF, LFS)
node/   src/ · vendor/node-lib/ · test/
wasm/   src/ (runWasm, wasi-shim, wasi-service) · test/
boa/    crate/ (nano-boa) · host/ (boa.mjs)
```

Cross-runner tests (differential-vs-oracle, cross-tier chains) live in
[`../integration`](../integration), not in any single runner.
