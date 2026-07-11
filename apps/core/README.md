# apps/core — core system apps (wasm)

Upstream Unix tools **compiled to `wasm32-wasip1`** and run on the wasm runner
(`runners/wasm`) — fast (host wasm engine, no emulation), and (for search/globs)
built on the real upstream crates, not reimplemented.

An **app** targets a runner's ABI; it never imports runner code. These run on
`runners/wasm` (via a router pin to the wasm-app tier) and, like any Unix tool,
see their spawn cwd as `.`.

## Scope — only what busybox/kernel applets DON'T already provide

The basic coreutils (`cat`, `ls`, `echo`, `head`, `tail`, `wc`, …) are already
covered twice: the **kernel-native JS applets** (fast, byte-identical to
BusyBox) and **BusyBox-in-VM** (the fidelity oracle). We do **not** replicate
those in wasm — that would be pure redundancy.

`apps/core` is for **gap-fillers**: tools BusyBox lacks that modern workflows
need, where compiling the real upstream tool to wasm beats both the slow VM and
a hand-rolled applet.

| tool | status | why |
|---|---|---|
| **`rg`** (ripgrep) | **shipped** (`rg.wasm`) | no grep in BusyBox with ripgrep semantics; opencode's file enumeration + search |
| `fd` | planned | fast, gitignore-aware find |
| `jq` | planned | JSON processing |
| `sd`, `bat`, `delta` | later | as demand appears |

## `rg` — built on ripgrep's own crates

`build/rg` is a real ripgrep front-end over **`ignore`** (gitignore/hidden/glob
directory walking) + **`regex`** (the same matcher) + **`globset`** — single-
threaded (`Walk`, not `WalkParallel`) and std-only I/O so it runs on wasip1.

Supported: `--files`; search with `-i`/`-S`/`-w`/`-F`/`-v`, `-n`/`-N`,
`-H`/`--no-filename`, `-l`/`--files-with-matches`, `--files-without-match`,
`-c`/`--count`, `-o`/`--only-matching`, `-A`/`-B`/`-C` context, `-g`/`--glob`,
`--hidden`, `--no-ignore`, `--json` (ripgrep JSON Lines), `-e`/`--regexp`,
`-m`/`--max-count`. Not yet: PCRE2 (`-P`), multiline (`-U`), replacements, `--type`.

## Layout

```
apps/core/
  rg.wasm            the built artifact (wasm32-wasip1)
  build/rg/          its Rust crate — `make build-rg`
  test/              difftest home (vs the BusyBox oracle)
```

`make build-rg` rebuilds `rg.wasm`; `runners/wasm/test/wasm-app.mjs` covers it
(route pin, `--files` walk incl. fd_readdir + gitignore, real-regex search).
