name: Bellard-RISCV
version: 3.0.0

description: >
  Enforces a Bellard-style high-performance WebAssembly emulator architecture
  for RV64 Linux userland (BusyBox, Node.js). Generates Rust code that compiles
  to a monolithic, br_table-friendly interpreter with minimal abstraction,
  fast memory access, batched host boundary, and deterministic multithreading
  via SharedArrayBuffer + Web Workers (futex, atomics).

activation:
  triggers:
    - riscv emulator
    - rv64 emulator
    - linux userland emulator
    - wasm emulator
    - nano vm
    - nodejs in wasm
    - busybox in wasm
    - high performance interpreter
    - br_table
    - software tlb
    - mmap brk
    - futex
    - epoll
    - sharedarraybuffer
    - web workers

# --------------------------------
# Target Profile (single profile)
# --------------------------------
profile:
  cpu_arch: riscv64
  execution_model: userland
  threading: required
  wasm_environment: browser
  host_boundary: minimal_imports_exports
  no_jit: true   # interpreter only; rely on browser wasm JIT
  determinism_goal: "race-safe, reproducible within browser scheduling limits"

# --------------------------------
# Key Principles (RISC-V specific)
# --------------------------------
principles:
  - Monolithic interpreter function for the CPU hot loop (keep it big).
  - Dense dispatch engineered to compile into br_table (or nested br_table) where feasible.
  - No dynamic dispatch (no trait objects) in the CPU hot path.
  - No heap allocation in the CPU loop.
  - Keep hot CPU state in locals inside exec() to minimize struct traffic.
  - Use #[repr(C)] for all VM/CPU/Process structs; stable layout required.
  - Unsafe raw pointer guest memory access in hot path is expected.
  - Decode caching and basic-block fast paths are allowed and recommended.
  - Syscalls cross the host boundary in batches; avoid chatty per-instruction host calls.
  - Threaded correctness first: avoid shared static mut state; pass vm_ptr explicitly.

# --------------------------------
# Hard Constraints
# --------------------------------
constraints:
  forbid:
    - Vec allocation inside the instruction dispatch loop
    - HashMap usage in CPU hot path (allowed in loader/setup only)
    - trait objects (dyn) in CPU execution
    - recursion in interpreter core
    - per-instruction host calls (except unavoidable traps/syscalls)
    - global mutable singletons for VM pointers (no shared static mut VM)
    - hidden thread-local VM globals (must be explicit)
    - generics on Cpu/Vm core structs (generics allowed in helpers outside hot loop)
  require:
    - "#[repr(C)] on Cpu/Vm/Proc/Mmap/Tlb structs"
    - "panic = abort"
    - "codegen-units = 1"
    - "lto = fat (or thin, but prefer fat)"
    - "explicit instruction budget counter for cooperative yielding (even if threads exist)"
    - "worker entrypoints take vm_ptr: u32 explicitly"
    - "shared allocator state for mmap/brk across threads (AtomicU64 CAS bump)"
    - "futex wait/wake implemented via Atomics.wait/notify on SharedArrayBuffer"

# --------------------------------
# CPU Core Shape
# --------------------------------
cpu_core:
  rv_width: 64
  regs: 32
  pc: u64
  dispatch:
    intent: >
      Dense dispatch that the wasm compiler can lower to br_table.
      RISC-V decode is field-based (opcode/funct3/funct7), so implement as:
      1) fetch 32-bit insn
      2) compute a compact dispatch index (dense) from (opcode,f3,f7-group)
      3) match on that index with dense arms
    recommended_index:
      - "opcode (7b) -> primary lane"
      - "funct3 (3b) -> secondary"
      - "funct7 (or imm[11:5]) -> tertiary group for ALU/shift variants"
    note: >
      br_table works best with dense integer ranges; use explicit mapping tables
      to compress sparse encodings into dense indices.

  fetch:
    - "fast u32 fetch from guest memory"
    - "unaligned loads allowed; enforce little-endian decode"
    - "I-cache/TLB optional; prefer decode-cache first"

  decode_cache:
    allowed: true
    recommended: true
    description: >
      Cache decoded fields per guest PC (or per page) to avoid re-decoding hot code.
      Store rd/rs1/rs2/imm and precomputed flags (is_branch, is_mem, etc.).

# --------------------------------
# Memory Model (Userland)
# --------------------------------
memory:
  model: "mmap/brk + mapping table"
  guest_va: 64bit
  guest_ram_backing: "WASM linear memory"
  access:
    - "raw pointer access into linear memory"
    - "bounds checks minimized; hoist where possible"
  mapping_table:
    description: >
      Maintain a mapping from guest VA regions to host offsets within linear memory.
      Simple page-based map is fine; software TLB is optional but recommended.
  software_tlb:
    enabled: recommended
    sets: 256
    ways: 4
    page_shift: 12
    separation:
      - read
      - write
      - exec
    hit_goal: "few operations on hit; no heap; no hashing"
    miss_path: "mapping lookup + permission check; not x86 page-walk"

  allocators:
    brk:
      - "shared_brk: AtomicU64"
      - "CAS bump allocate"
    mmap:
      - "shared_mmap_next: AtomicU64"
      - "CAS bump allocate with alignment"
    rule: >
      All threads must allocate from the same shared allocator state to avoid overlap.

# --------------------------------
# Linux Syscalls (Userland Subset)
# --------------------------------
syscalls:
  philosophy: >
    Implement only what the target workloads need (BusyBox + Node).
    Prefer correctness and determinism; keep host boundary minimal.
  required_core:
    - read
    - write
    - close
    - openat
    - newfstatat
    - fstat
    - lseek
    - getdents64
    - getcwd
    - chdir
    - unlinkat
    - renameat
    - mkdirat
    - rmdir
    - mmap
    - munmap
    - mprotect
    - brk
    - clock_gettime
    - nanosleep
    - getrandom
    - uname
    - prlimit64
    - sched_yield
    - rt_sigaction
    - rt_sigprocmask
    - sigaltstack
    - exit
    - exit_group

  node_specific_common:
    - epoll_create1
    - epoll_ctl
    - epoll_pwait
    - eventfd2
    - timerfd_create
    - timerfd_settime
    - pipe2
    - dup
    - dup2
    - fcntl
    - ioctl

# --------------------------------
# Threads + Futex (Required)
# --------------------------------
threads:
  model: "SharedArrayBuffer + Web Workers"
  invariants:
    - "no shared global VM pointers"
    - "all worker calls include vm_ptr explicitly"
    - "per-thread stacks allocated deterministically"
    - "TLS model explicit (or toolchain-provided), no hidden globals"
  futex:
    implemented_by_host: true
    mapping: "Linux futex -> Atomics.wait/notify on Int32Array view"
    shutdown_policy:
      - "track consecutive timeouts per futex address"
      - "after N timeouts, terminate stuck workers"
      - "when no workers remain, clear futex word to prevent dead wait"
    batching_rule: "avoid debug logging in hot futex path"

# --------------------------------
# Host Boundary
# --------------------------------
host_boundary:
  rule: >
    Keep imported functions small in count and semantics stable.
    Syscalls are marshaled via shared memory request/response blocks.
  recommended_pattern:
    - "worker -> writes request struct -> Atomics.notify"
    - "main thread -> handles request -> writes response -> Atomics.notify"
  forbid:
    - "chatty per-byte or per-instruction host callbacks"
    - "logging in hot paths"

# --------------------------------
# Build Profile
# --------------------------------
build_profile:
  release:
    opt-level: 3        # prefer speed for interpreter; use z only if size matters more than speed
    lto: "fat"
    codegen-units: 1
    panic: "abort"
    strip: true
  wasm:
    target: wasm32-unknown-unknown
    features:
      - atomics
      - bulk-memory
      - mutable-globals
      - sign-ext

# --------------------------------
# Output Behavior (how code should be generated)
# --------------------------------
output_behavior:
  When generating emulator-related Rust code:
    - Always structure as a monolithic interpreter with dense dispatch.
    - Keep hot state in locals inside exec().
    - Avoid trait objects/dynamic dispatch in CPU hot path.
    - Use explicit vm_ptr passing for thread entrypoints.
    - Use shared allocator state (AtomicU64 CAS) for mmap/brk across threads.
    - Prefer decode cache + basic-block fast paths before exotic optimizations.
    - Keep syscall boundary explicit and batched through shared memory.

# --------------------------------
# Minimal Architecture Template (RV64)
# --------------------------------
architecture_template: |
  use core::sync::atomic::{AtomicU64, Ordering};

  #[repr(C)]
  pub struct Cpu {
      pub x: [u64; 32],
      pub pc: u64,
      pub insn_budget: i32,
      // optional: decode cache pointers, tlb pointers, etc.
  }

  #[repr(C)]
  pub struct SharedAlloc {
      pub mmap_next: AtomicU64,
      pub brk: AtomicU64,
  }

  #[repr(C)]
  pub struct Vm {
      pub cpu: Cpu,
      pub mem_base: *mut u8,
      pub mem_size: u64,
      pub alloc: *mut SharedAlloc, // shared across threads
      // process state, fds, mapping table, etc.
  }

  #[inline(always)]
  unsafe fn load_u32_le(p: *const u8) -> u32 {
      (p.read() as u32)
        | ((p.add(1).read() as u32) << 8)
        | ((p.add(2).read() as u32) << 16)
        | ((p.add(3).read() as u32) << 24)
  }

  impl Vm {
      pub unsafe fn exec(&mut self) -> i32 {
          // keep hot locals
          let mem = self.mem_base;
          let mut pc = self.cpu.pc;
          let mut budget = self.cpu.insn_budget;

          loop {
              if budget <= 0 { break; }
              budget -= 1;

              // fetch
              let insn_ptr = mem.add(pc as usize); // replace with VA->host translation
              let insn = load_u32_le(insn_ptr);

              // decode fields
              let opcode = (insn & 0x7f) as u32;
              let funct3 = ((insn >> 12) & 0x7) as u32;
              let funct7 = ((insn >> 25) & 0x7f) as u32;

              // compress to dense dispatch index (example only)
              let idx = (opcode) | (funct3 << 7) | ((funct7 & 0x1) << 10);

              match idx {
                  // dense arms → br_table expected
                  _ => {
                      // illegal instruction trap
                      return -1;
                  }
              }

              pc = pc.wrapping_add(4);
          }

          self.cpu.pc = pc;
          self.cpu.insn_budget = budget;
          budget
      }
  }

  #[no_mangle]
  pub unsafe extern "C" fn vm_step(vm_ptr: *mut Vm) -> i32 {
      (&mut *vm_ptr).exec()
  }
