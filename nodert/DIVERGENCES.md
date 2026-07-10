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

## Notes

- **DIV-VM-POW is unusual**: it documents a case where the *oracle* (the emulated VM)
  is the one that diverges from canonical Node, and nodert is correct. Kept here so
  the VM-oracle differential run stays green; a future VM FP fix would retire it.
- M0 lean-implementation divergences (DIV-*-M0) are temporary bring-up shims, not
  permanent behavior; each is retired when its upstream lib module runs verbatim.
