# nano-boa — the `boa.wasm` scripting component

Embeds the [Boa](https://github.com/boa-dev/boa) JavaScript engine as a
standalone WebAssembly module shipped next to `nano.wasm`. It gives nano a fast,
sandboxed, host-side scripting capability for automating the emulator without
booting a full guest process.

Design: [`specs/nano/scripting-layer.md`](../../specs/nano/scripting-layer.md).
Loader + bridge: [`container/boa.mjs`](../container/boa.mjs).

## Build

```bash
make build-boa      # -> wasm/boa.wasm (+ wasm-opt when available)
make test-boa       # unit tests (container/boa.mjs + boa.wasm, mock VM)
make test-boa-vm    # integration: a Boa script driving the real emulator
```

The crate builds with a custom getrandom backend and **must not** inherit nano's
`.cargo/config.toml` rustflags (`--shared-memory`/`--import-memory`) — boa.wasm
has its own linear memory. `make build-boa` passes `RUSTFLAGS` via the
environment, which fully overrides config-file rustflags (the only clean way,
since cargo *joins* ancestor config rustflags into nested crates). Raw command:

```bash
RUSTFLAGS='--cfg getrandom_backend="custom"' \
  cargo build --release --target wasm32-unknown-unknown --manifest-path boa/Cargo.toml
```

## Why no wasm-bindgen

Boa's `js` feature pulls `web-time` + `getrandom/wasm_js` + `time/wasm-bindgen`,
dragging in the whole `js-sys`/`wasm-bindgen` glue. Instead this crate omits the
`js` feature and supplies the two host-platform needs — entropy and wall-clock
time — through its own tiny imports. The result is a clean module: 6 imports,
its own `memory`, ~2.7 MB after `wasm-opt`, and a thin hand-written loader
(symmetric with how `nano.wasm` talks to its JS host).

## ABI

`boa.wasm` imports (all under `env`):

| Import | Purpose |
|---|---|
| `host_random(ptr, len)` | Fill `len` bytes with entropy (getrandom custom backend). |
| `host_now_millis() -> f64` | Wall-clock ms since epoch (the engine's `Clock`). |
| `host_tz_offset(unix_secs) -> i32` | Local timezone offset, seconds east of UTC. |
| `host_call(fn_id, ptr, len) -> u64` | Synchronous host-function call; returns a packed `(ptr<<32)\|len` JSON reply we then free. |
| `host_call_async(fn_id, ptr, len, promise_id)` | Async host-function call; settled later via `boa_resolve`/`boa_reject`. |
| `host_write(stream, ptr, len)` | console output (stream 1 = stdout, 2 = stderr). |

Exports (the C-style ABI; strings cross as UTF-8 JSON, returns packed as `u64`):

`boa_alloc` · `boa_free` · `boa_version` · `boa_context_create` ·
`boa_context_dispose` · `boa_define_global` · `boa_register_host_fn` ·
`boa_eval` · `boa_eval_module` · `boa_run_jobs` · `boa_take_result` ·
`boa_resolve` · `boa_reject`.

The async boundary (spec §5): `boa_eval` of an async script reports `pending`;
the loader pumps `boa_run_jobs`, services in-flight async host calls, feeds
results back with `boa_resolve`/`boa_reject`, and reads the settled value with
`boa_take_result`.

## License

Boa is MIT or Unlicense (see this crate's `license` field). Bundling `boa.wasm`
adds a permissive dependency and imposes no copyleft; it is a separate module
from `nano.wasm` with its own license, independent of nano's terms.
