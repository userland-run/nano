# Spike S1 — Binding Tracer Bootstrap: Findings

**Risk addressed:** R1 (bootstrap fails / silently misbehaves on guessed binding surfaces).
**Method:** boot the vendored Node v25.4.0 `lib/` on the host engine (Node 24, no VM) with a
Proxy-based `internalBinding` registry that records every `(binding, property)` access and answers
with progressively-real stubs. Run `node nodert/spike/s1-tracer.mjs`.

## Result: bootstrap is viable

- **`primordials`** built from the vendored `per_context` scripts verbatim → **814 properties**
  (R2: run upstream, don't reimplement). One gotcha found and handled: `domexception.js` needs a
  `privateSymbols` parameter the C++ layer supplies — a symbol-minting Proxy satisfies it.
- **`internal/bootstrap/realm.js` runs to COMPLETION.** It is the spine: it destructures
  `builtins.{builtinIds, compileFunction, setInternalLoaders}` and `module_wrap.ModuleWrap`, then
  hands its JS loaders back via `setInternalLoaders`. `compileFunction(id)` is exactly where the
  lazy bundle-eval hooks in (§8.1) — the spike wires it straight to the vendored bundle index.
- **`internal/bootstrap/node.js` runs deep** — through `setupProcessObject`, `setupGlobalProxy`,
  `setupBuffer`, the `_exiting`/`exitCode` accessors, timers, and into `fs`/`internal/fs/utils`
  before the first stop. It halts inside Buffer's **pool allocator** (`fromStringFast` →
  `utf8Write`), which needs the real `buffer` binding write-static contract — implementation
  work, not a discovery gap.

## Bootstrap-critical binding surface (empirical, first-touch order)

27 bindings, exactly matching the M0 plan baseline (plus a few the plan already anticipated):

```
builtins  module_wrap  errors  util  config  timers  async_wrap  task_queue
symbols  constants  types  options  string_decoder  icu  trace_events
async_context_frame  buffer  messaging  process_methods  credentials
url_pattern  url  modules  contextify  fs  blob  encoding_binding
```

New vs. the plan's Appendix-B M0 list: `async_context_frame`, `url_pattern` (both pulled in by
v25's process/url setup) and `credentials` (already listed). None are surprises; all are stub-or-
trivial except where noted below.

## Concrete-implementation requirements discovered (feed M0 task 6)

The proxy-with-stubs approach breaks on bindings that hand out **live objects the vendored JS
operates on**. These need real backing from day one, in this order:

1. **`builtins`** — `builtinIds` (from the bundle index), `compileFunction(id)` (bundle eval with
   Node's wrapper params), `setInternalLoaders`, `getNatives`, `config` (a JSON string —
   `JSON.parse`d by bootstrap).
2. **`module_wrap`** — a real `ModuleWrap` class (realm does `setPrototypeOf(ModuleWrap.prototype,
   null)`).
3. **`util`** — `privateSymbols` (shared symbol table; `exit_info_private_symbol` et al.),
   `constants` (`kExiting/kExitCode/kHasExitCode`), and **`defineLazyProperties`** — v25 moved this
   into the C++ util binding; it must install lazy getters that `require(id)[key]` on first touch.
   Also `WeakReference`, `guessHandleType`.
4. **`buffer` / `encoding_binding`** — real `byteLengthUtf8`, `copy`, `compare`, the
   `utf8WriteStatic/latin1WriteStatic/asciiWriteStatic` write-statics, `createUnsafeBuffer`,
   `encodeInto`/`decodeUTF8`. The stop point proves these are load-bearing at bootstrap, not lazy.
5. **`contextify`** — `compileFunction` (host `Function` with wrapper params — the CJS loader spine,
   §9.1) and a `ContextifyScript` class with `runInThisContext`. Separate-context APIs stay deferred
   (§8.9).
6. **Typed-array bindings** (`task_queue.tickInfo`, `timers.immediateInfo/timeoutInfo`,
   `async_wrap.async_hook_fields`) — real arrays, not proxies; the JS mutates them in place.
7. **`process` object** — must sit on a **mutable** intermediate prototype (bootstrap does
   `setPrototypeOf(getPrototypeOf(process), EventEmitter.prototype)`) and carry the exit-info
   `Uint32Array` under `util.privateSymbols.exit_info_private_symbol`.

## Go / no-go

**GO.** No architectural blocker surfaced. Every stop was a missing concrete primitive with an
obvious real implementation, and the dependency order is now known empirically rather than guessed.
The `options`/`config`/`constants`/`errno` values come from the checked-in VM fixtures
(`fixtures/generated/`), removing the largest guess. M0 task 6 should implement bindings in the
first-touch order above, using this spike as the regression harness (extend it until
`bootstrap/node.js` completes, then `run_main_module`).
