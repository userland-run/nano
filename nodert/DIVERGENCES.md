# nodert Divergence Registry

The reference oracle is the real Node v25.4.0 running in NanoVM (spec §16.4, G4).
Any observable difference between `nodert` and the oracle is a `nodert` bug **unless
recorded here**. The differential/ordering harnesses fail on any un-annotated diff.

Format: `id | area | nodert behavior | reference behavior | rationale | spec | tests`.

| id | area | nodert | reference | rationale | spec |
|---|---|---|---|---|---|
| DIV-001 | process.platform/arch | `linux` / `x64` | VM: `linux` / `riscv64` | Max ecosystem compatibility; packages special-case linux/x64 | §8.3 |
| DIV-VM-POW | Math `**` | `2**10 === 1024` (correct, matches x86 Node) | VM: `1024.0000000000002` | The VM's *emulated* FP `pow` diverges from real Node; nodert is correct. Divergence is on the VM side. | §16.4 |
| DIV-BUF-M0 | `Buffer` | nodert lean Buffer (host-native primitives) | upstream `lib/buffer.js` | M0 lean bring-up; upgraded to upstream buffer.js in M1 (needs streams/blob closure) | §8 |
| DIV-CONSOLE-M0 | `console` | lean formatter, no color | upstream `lib/internal/console/*` | M0; upgraded when Writable streams land (M1) | §8.6 |
| DIV-FS-M0 | `fs` | nodert bus-backed fs module | upstream `lib/fs.js` | M0 covers sync+promises+callbacks; upstream fs.js + streams in M1 | §8.5 |
| DIV-INSPECT-PROMISE | `util.inspect` of promises/proxies | shows `[object]`/degraded | full introspection | `getPromiseDetails`/`getProxyDetails` are not implementable on the host engine | §8.4 |
| DIV-SQLITE-DUCKDB | `node:sqlite` | backed by DuckDB-wasm + sqlite core extension | real embedded SQLite | User decision; dialect/error-code differences vs embedded SQLite | §8.8 |
| DIV-URL-M0 | `require("url")` | host WHATWG URL/URLSearchParams + lean helpers | upstream `lib/url.js` | upstream url needs the ada `url` binding (M2); host URL is WHATWG-standard | §8.4 |
| DIV-RSPACK | `rspack` service | ERR_NODERT_UNSUPPORTED | native bundler | No browser-wasm build of Rspack exists; use the VM or esbuild-wasm | §13 |
| DIV-NET-M0 | `net` | nodert loopback sockets (Kernel pipes) | upstream lib/net.js (tcp_wrap) | M1; loopback-only, upstream net.js needs tcp_wrap/LibuvStreamWrap | §11 |
| DIV-HTTP-M0 | `http` | lean HTTP/1.1 over net | upstream lib/http.js (llhttp) | M1; Content-Length bodies, no chunked-request parsing yet | §11 |
| DIV-CRYPTO-M0 | `crypto` | sha256/sha1 + hmac + random | full node:crypto (BoringSSL) | M1 subset; legacy ciphers/DH/scrypt need BoringSSL-wasm | §8.8 |
| WASM-TERM | wasip1 apps | no termios / raw-mode TUI | native TTY | wasip1 has no termios; line-oriented tools only | wasm-tier T3 |
| WASM-SIGNAL | wasip1 apps | kill always terminates | signal delivery | wasip1 has no signals; SIGTERM/SIGKILL both teardown | wasm-tier T4 |
| WASM-SOCK | wasip1 apps | sock_* → ENOTSUP | sockets | wasip1 has no sockets outside wasi-http (W-3) | wasm-tier P3 |
| DIV-ESM-CYCLE | ESM circular imports | multi-node SCC concatenated into one module (shared scope) | separate module records with live bindings | The blob-URL model can't cycle across URLs; concatenation resolves the cycle intra-module — top-level name collisions across cycle members are the caller's responsibility | §9.2 |
| DIV-ESM-DATAURL | ESM module URLs (Node) | data: URLs (headless) | blob: URLs (browser) | Node has no URL.createObjectURL; the browser uses flat blob: URLs. Behavior identical; deep graphs are larger under data: | §9.2 |
| DIV-WT-JSON | worker_threads messaging | JSON-framed over Kernel pipes | V8 structured serialize + SAB transfer | M2; covers plain-data messages. Full structuredClone/SAB transfer is a refinement | §10.3 |
| DIV-SH-LEAN | the "vm" shell delegate (headless, portable) | lean POSIX-ish sh (sequencing, builtins, spawn) | real BusyBox `sh` | M3 headless stand-in with IDENTICAL cross-tier routing. RESOLVED where a live NanoVM is available: vm-delegate.mjs runs REAL BusyBox as a cross-tier shell (busybox applets in the emulator, `node …` in nodert) over the shared VFS — the true §12.3 path | §12.3 |

## Upstream modules running VERBATIM (P2 — no reimplementation)

These vendored `lib/*.js` modules execute byte-identical on the host engine over
the nodert bindings (verified in `test/upstream.mjs`): **events** (EventEmitter),
**querystring**, **punycode**, **string_decoder** (native binding, multibyte-safe),
**assert**, **path**. This list grows each milestone as more bindings land; the
lean nodert shims (Buffer/console/fs/url above) are replaced by their upstream
counterparts as their dependency closures (streams, ada) come online in M1/M2.

## Notes

- **DIV-VM-POW is unusual**: it documents a case where the *oracle* (the emulated VM)
  is the one that diverges from canonical Node, and nodert is correct. Kept here so
  the VM-oracle differential run stays green; a future VM FP fix would retire it.
- M0 lean-implementation divergences (DIV-*-M0) are temporary bring-up shims, not
  permanent behavior; each is retired when its upstream lib module runs verbatim.
