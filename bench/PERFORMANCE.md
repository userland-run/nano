# NanoVM Performance Analysis

## Implemented: block-engine rework (measurement-driven)

The interpreter originally had a basic-block cache that was **only entered on backward
branches**. Instrumentation (a `debug_block_*` hit-rate counter, surfaced in `test/run.mjs`'s
`[progress]`/`[blockstats]` lines) showed this gave **0.2% block coverage even on `loop-compute`** —
i.e. ~99.8% of the hottest loop ran in the slow per-instruction baseline. The fix landed in stages,
each gated by the counter and the correctness suite:

| change | what it does |
|---|---|
| **C1** | block-cache / dispatch instrumentation (`BLOCK_*`, `JALR/forward` counters → `debug_*` exports) |
| **A0** | execute FP/AMO instructions *inside* blocks (`build_block` no longer breaks on them) |
| **B3** | superblocks — blocks span *forward* conditional branches as internal multi-exit points |
| **A1** | **block dispatch moved to the top of `exec()`** — every control transfer (incl. `JALR`/forward `JAL`/forward branch) now enters a cached block; consecutive blocks chain through the loop top |
| **A2** | self-modifying-code safety: guest stores into a page that holds cached code invalidate stale blocks (no `fence.i` exists in the guest, so we watch stores — see `src/mem.rs` `note_store`) |
| **C2** | block cache 4096 → 16384 entries (−62% rebuilds; negligible wall-clock, helps larger workloads) |

### Measured result (Apple Silicon, minimal WASM + RISC-V Node v25)

| benchmark | before | after | wall-clock | block coverage |
|---|---|---|---|---|
| loop-compute | 67.3 s | **58.2 s** | **−13%** | 0.2% → **100%** |
| math-compute | 17.8 s | **15.4 s** | **−13%** | 0.8% → **100%** |

Correctness held throughout: 24/24 ELF+BusyBox+MemFS tests, 9 diverse Node programs
(json/classes/regex/crypto/proxy-reflect/typed-arrays/…), and result canaries (`74735`, `78498`).

### What the data taught us (three hypotheses the counter killed)

1. *"FP ops break blocks"* (A0) — implemented, coverage stayed 0.2%. Not the limiter.
2. *"Blocks die at the first conditional branch"* (B3) — implemented, coverage stayed ~0.4%. Not it.
3. The control-flow counter then showed the truth: for `loop-compute`'s 23.2 B baseline insns, the
   transfers were **827 M `JALR` + 714 M forward-branch + 196 M forward-`JAL`**, none entering a block
   because the cache only fired on backward branches. Moving dispatch to the loop top (A1) fixed it.

### Honest caveats

- **Wall-clock (`BENCH … ms`) is the ground truth.** Reported MIPS (~520) and "100% coverage" are
  *inflated*: `exec_block` charges the full block budget even on early exits, so `block_insns`
  over-counts by ~25%.
- **The current bottleneck is per-block dispatch + per-op decode overhead**, *not* coverage and *not*
  cache thrash (C2 cut rebuilds 62% with ~0% wall-clock change). Remaining compute levers are
  incremental: A1b (true successor-pointer chaining ~4–10%), B2 (pin `sp`/`ra` as WASM locals), or a
  wider pre-decoded op format. The 200–777× *library* benchmarks (`buffer-ops`/`string-ops`/`crypto`)
  are untouched — those need **P1** (paravirtual `memcpy`/`memset` hypercalls in a custom guest build).

---

## Baseline Benchmark Results (before the block-engine rework)

```
  Benchmark                Native     NanoVM   Slowdown
  ─────────────────── ──────── ──────── ────────
  array-sort                 23ms     4791ms       208x
  buffer-ops                 38ms    29508ms       777x
  crypto-hash                 7ms     1750ms       250x
  fib                       265ms   156081ms       589x
  http-throughput            21ms      990ms        47x
  json-parse                 64ms     6501ms       102x
  loop-compute               40ms    64113ms      1603x
  math-compute               13ms    17194ms      1323x
  object-create              16ms     1156ms        72x
  regex                      29ms     8013ms       276x
  string-ops                  6ms     1218ms       203x
  ─────────────────── ──────── ──────── ────────
  TOTAL                     522ms   291315ms       558x

  Interpreter throughput: ~350 MIPS
```

**Environment**: Apple Silicon (M-series), Node.js v25, NanoVM WASM interpreter,
`opt-level=3`, `lto=fat`, `codegen-units=1`.

## Benchmark Categories

| Benchmark | What it measures | Slowdown | Bottleneck |
|-----------|-----------------|----------|------------|
| object-create | V8 object/Map/Set internals | 72x | Mostly V8 runtime, not interpreter |
| http-throughput | I/O + event loop + networking | 47x | Host boundary dominates |
| json-parse | JSON.stringify/parse (V8 C++) | 102x | V8 built-in speed |
| string-ops | String concat/search/regex | 203x | Mixed V8 + interpret |
| array-sort | Array sort with callbacks | 208x | Comparison callbacks interpreted |
| crypto-hash | SHA-256 (OpenSSL in Node) | 250x | Crypto kernel interpreted |
| regex | Regexp engine | 276x | V8 Irregexp interpreted |
| fib | Deep recursion, integer ALU | 589x | Call/ret overhead, branch |
| buffer-ops | Buffer alloc + hex encode/decode | 777x | Tight byte loops + GC |
| math-compute | Sieve + int matrix multiply | 1323x | Tight integer loops |
| loop-compute | Pure ALU tight loop | 1603x | Raw dispatch overhead |

## Analysis: Where Time Is Spent

### Tier 1: V8-heavy workloads (47x-200x)
These benchmarks spend most time in V8's C++ runtime (JSON parser, object
allocator, Map/Set internals, I/O). The interpreter is just shuttling between
V8 built-in calls. Optimization opportunity is low — the interpreter overhead
is already a small fraction.

### Tier 2: Mixed workloads (200x-600x)
String operations, sorting, crypto, regex — these alternate between V8 runtime
and interpreted RISC-V code. The interpreted portions (comparison callbacks,
loop bodies) are the bottleneck.

### Tier 3: CPU-bound tight loops (600x-1600x)
Fibonacci, buffer byte loops, sieve, matrix multiply, pure ALU — these spend
nearly 100% of time in the interpreter dispatch loop. Every emulated
instruction costs ~3ns (at 350 MIPS), compared to sub-nanosecond on native.
This is the target for optimization.

## Current Architecture

The interpreter is a monolithic `exec()` function with:
- **24-arm RVC direct dispatch** (`try_exec_rvc`) for compressed instructions
- **25-arm opcode_5 dispatch** for standard 32-bit instructions
- **Nested funct3/funct7 dispatch** inside each opcode handler
- All helpers marked `#[inline(always)]`, fused by fat LTO into one function
- 70 `br_table` instructions in the compiled WASM (good density)
- Hot state (x[32], f[32], pc, fcsr) kept as locals
- Single `i32.load` for instruction fetch

### What's Already Good
- Direct RVC execution avoids expand+re-decode for 60%+ of instructions
- Dense br_table dispatch (WASM JIT compiles to jump tables)
- No bounds checks on memory access (raw pointer arithmetic)
- No heap allocation in the hot loop
- Fat LTO fuses everything into one WASM function (17KB)

---

## Optimization Opportunities

> **Note:** several items below were superseded by the block-engine rework at the top of this doc.
> The "decode cache" and "basic block chaining" ideas are now realized as the loop-top block dispatch
> (A1) + superblocks (B3); register pinning (B2), superinstructions, and `memcpy` interception (now
> reframed as P1 paravirtual hypercalls) remain open. Treat the analysis below as background.

### 1. Decode Cache (HIGH IMPACT, estimated 1.5-2x speedup)

**Problem**: Every instruction is decoded from scratch each time it's executed.
For a tight loop like `for(i=0;i<N;i++) { c=(a+b)|0; ... }`, the same 10-15
instructions are re-decoded billions of times.

**Solution**: Cache decoded instruction fields indexed by guest PC.

```rust
#[repr(C)]
struct DecodedInsn {
    opcode_tag: u8,    // dense enum: ADDI, LD, SD, BEQ, JAL, ...
    rd: u8,
    rs1: u8,
    rs2: u8,
    imm: i32,          // pre-extracted immediate
}

// 64KB decode cache — direct-mapped by (pc >> 1) & 0x7FFF
static mut DECODE_CACHE: [DecodedInsn; 32768] = ...;
static mut DECODE_TAGS: [u32; 32768] = ...; // pc tag for validation
```

On cache hit (expected 95%+ for hot loops): skip all bit extraction, jump
directly to the handler via a dense `match` on `opcode_tag`.

On cache miss: decode normally, fill cache entry, continue.

**Why it matters**: Instruction decode (bit extraction, sign extension, field
routing) accounts for ~40% of the per-instruction cost. The WASM JIT can
optimize the cache-hit path into a tight table-jump.

**Risk**: Increases code size, may thrash WASM function-level caches.
Trade-off worth it for loop-heavy workloads.

### 2. Basic Block Chaining (HIGH IMPACT, estimated 1.3-1.5x speedup)

**Problem**: The main loop checks `remaining <= 0` and does `remaining -= 1`
on every single instruction. For a basic block of 5 instructions with no
branches, that's 5 redundant budget checks and 5 counter decrements.

**Solution**: At decode-cache fill time, compute the basic block length
(number of instructions until next branch/jump/syscall). Then in the hot path:

```rust
// Subtract entire block budget at once
remaining -= block_len;
if remaining < 0 { break; }

// Execute block instructions without per-insn budget check
for insn in block {
    execute(insn);
}
```

This eliminates ~2 WASM instructions (i32.le_s + br_if + i32.sub) per
emulated instruction, which is significant at 350 MIPS.

### 3. Superinstructions / Fused Pairs (MEDIUM IMPACT, estimated 1.2-1.4x)

**Problem**: Common instruction sequences like `ld + addi + sd` or
`beqz + j` require 2-3 full dispatch cycles.

**Solution**: Detect common pairs/triples at decode-cache fill time and
create fused "superinstructions" that execute as a single dispatch:

```
LOAD_ADD:  x[rd] = mem[x[rs1]+imm1]; x[rd2] += imm2;
BRANCH_J:  if condition { pc += off1 } else { pc += off2 }
STORE_ADDI: mem[x[rs1]+imm] = x[rs2]; x[rd] += imm2; // stack push + SP adjust
```

Target the top 10 instruction pairs from Node.js execution profiles.
Each fused pair saves one dispatch cycle (~3ns).

### 4. Register Pinning / Local Caching (MEDIUM IMPACT, estimated 1.1-1.3x)

**Problem**: The `x` array is a `[u64; 32]` on the WASM stack. Every register
access is `local.get $x_ptr` + `i32.const offset` + `i64.load`. V8's
TurboFan can optimize some of this, but not all.

**Solution**: Pin the most frequently used registers as individual WASM locals:

```rust
let mut x_sp = x[2];   // sp — used in every stack op
let mut x_ra = x[1];   // ra — used in every call/ret
let mut x_a0 = x[10];  // a0 — function args
let mut x_a1 = x[11];  // a1
// ... top 8-10 registers
```

WASM locals are kept in CPU registers by the JIT. Direct `local.get`/`local.set`
is faster than array indexing.

**Trade-off**: Increases code complexity. Need to sync pinned locals before
syscalls and at loop exit. Only pin the top 8-10 most-used registers.

### 5. Speculative Execution for Memory (LOW-MEDIUM IMPACT)

**Problem**: Every memory access computes `base + addr as u32`, which requires
a 64-to-32 truncation. The guest address space is always within WASM linear
memory.

**Solution**: Since we're in a userland emulator with no virtual memory
translation, the truncation is minimal overhead. BUT: we can avoid redundant
base additions for sequential accesses in the same basic block by caching
`base + x[rs1]` when rs1 doesn't change.

### 6. Host Boundary Optimization (LOW IMPACT for CPU-bound, HIGH for I/O)

**Problem**: Every syscall requires: write-back all locals to Vm struct →
call `syscall::handle` → reload all locals from Vm struct.

**Solution**: For read-only syscalls (clock_gettime, getpid, etc.), avoid
the full save/restore cycle. Use a "fast syscall" path that handles simple
syscalls inline without touching the Vm struct.

### 7. Instruction Fetch Optimization (LOW IMPACT)

**Problem**: Current fetch is `((base + pc as u32) as *const u32).read_unaligned()`.
This is already optimal for single instructions.

**Solution**: For basic blocks, prefetch the entire block into a local buffer:
```rust
let block_ptr = (base + pc as u32) as *const u32;
let insn0 = block_ptr.read_unaligned();
let insn1 = block_ptr.add(1).read_unaligned(); // if next is 32-bit
```
This can help V8's JIT schedule loads ahead of decode.

### 8. WASM SIMD for Bulk Operations (SPECULATIVE)

Node.js uses `memcpy`, `memset`, `memcmp` heavily (string/buffer ops).
The emulator could detect these patterns (tight byte-copy loops) and
accelerate them with WASM SIMD (`v128.load`, `v128.store`) instead of
interpreting each `ld`/`sd` individually.

This is a form of "library call interception" — detect known function
entry points (like `memcpy`) and execute them natively.

---

## Recommended Implementation Order

| Priority | Optimization | Effort | Expected Gain |
|----------|-------------|--------|---------------|
| 1 | Decode cache | 2-3 days | 1.5-2x |
| 2 | Basic block chaining | 1-2 days | 1.3-1.5x |
| 3 | Superinstructions (top 10) | 2 days | 1.2-1.4x |
| 4 | Register pinning (sp, ra, a0-a5) | 1 day | 1.1-1.3x |
| 5 | Fast syscall path | 0.5 day | 1.0-1.05x (CPU), 1.2x (I/O) |
| 6 | memcpy/memset interception | 1 day | 1.1-1.2x (buffer-heavy) |

**Combined estimated improvement**: 3-5x for tight loops (Tier 3 benchmarks),
1.5-2x for mixed workloads (Tier 2), minimal for V8-heavy (Tier 1).

**Target**: Bring loop-compute from 1600x → ~400x, fib from 589x → ~200x.

---

## WASM-Specific Considerations

### V8 TurboFan Behavior
- `br_table` compiles to native jump tables — our dispatch is already optimal
- Functions >50KB may not get fully optimized by TurboFan (our exec is 17KB, good)
- With decode cache, exec may grow to ~25KB — still within optimization threshold
- WASM locals are register-allocated; more locals = better for frequently-used values

### Memory Layout
- WASM linear memory is contiguous — no TLB misses for guest RAM access
- SharedArrayBuffer adds overhead for every load/store (atomic ordering)
- Consider: does the emulator *need* shared memory for the main thread's RAM?
  If single-threaded execution is common, a non-shared memory variant could help

### Browser JIT Warmup
- First execution of a benchmark is slower (JIT compiling the WASM)
- Subsequent runs benefit from compiled code cache
- The monolithic exec() function may take 50-100ms to JIT compile initially
