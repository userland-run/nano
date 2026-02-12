name: Bellard
description: >
  Enforces Bellard-style high-performance WASM emulator architecture.
  Generates Rust code that compiles to a monolithic br_table-based interpreter
  with lazy flags, software TLB, and minimal host boundary.
  Informed by full reverse-engineering of the original JSLinux/TinyEMU x86_64 emulator.

version: 2.0.0

activation:
  triggers:
    - x86 emulator
    - wasm emulator
    - virtual machine
    - TinyEMU
    - JSLinux
    - high performance interpreter
    - br_table
    - lazy flags
    - software TLB
    - opcode handler
    - instruction decoder
    - page table walk
    - virtio device
    - cooperative scheduler

principles:
  - Single monolithic interpreter function (must compile to >100KB WASM).
  - Dense match dispatch to force WASM br_table.
  - Lazy EFLAGS computation (3 stores per ALU op, not ~30 flag computations).
  - Software TLB for virtual address translation (3 ops on hit).
  - No trait objects in hot path.
  - No heap allocation in CPU loop.
  - No dynamic dispatch in CPU core.
  - Cooperative instruction budgeting (yield via counter, resume via callback).
  - Minimal JS/WASM boundary crossings (27 imports, 17 exports in original).
  - "#[repr(C)] flat CPU state layout" — hot variables as locals inside exec().
  - unsafe raw pointer memory for guest RAM.
  - Device I/O delegated to host via imported functions, not emulated in WASM.
  - No JIT — pure interpreter; WASM engine's own JIT compensates.
  - Single-threaded by design — no threads, no SharedArrayBuffer, no Worker.

constraints:
  forbid:
    - Vec allocation inside CPU loop
    - HashMap usage in CPU hot path
    - trait objects (dyn) in CPU execution
    - recursion in interpreter
    - host calls inside instruction handlers (batch I/O at yield points)
    - threads or SharedArrayBuffer dependency
    - generics in CPU struct
    - modularizing opcode handlers into separate functions
    - BIOS/UEFI firmware emulation (direct kernel load only)
    - real-mode 16-bit boot path
    - ACPI, SMP, USB, audio, GPU emulation
    - full NIC emulation (use VirtIO + host callback)

  require:
    - "#[repr(C)]" on all CPU/Machine structs
    - explicit instruction budget counter at known memory offset
    - match-based opcode dispatch (769 entries: 256 per operand size x 3)
    - raw pointer guest memory access
    - "#[inline(always)]" on tiny helpers only (TLB lookup, flag set, fetch)
    - panic = abort
    - 4-level page walk on TLB miss (PML4 -> PDP -> PD -> PT)
    - 26 lazy flag operation types (0x00-0x1a)
    - separate TLB sets for read/write/exec

code_style:
  - unsafe is allowed and expected in hot path
  - flatten nested abstractions
  - no generics in CPU struct
  - avoid modularizing opcode handlers into separate functions
  - small helper functions must inline
  - prefer performance over abstraction
  - explicitly note where br_table is expected
  - keep device boundary separate from CPU core

# -------------------------------------------------------------------
# Reference Architecture (from reverse-engineering the original binary)
# -------------------------------------------------------------------

reference_architecture:
  binary_size: 519KB
  total_functions: 504 (27 imports, 17 exports, 435 internal + 25 thunks)
  cpu_interpreter_size: 300899 bytes (58% of binary, one function)
  br_table_entries: 769 main + 104 sub-dispatches
  guest_ram: 256MB (WASM linear memory)
  function_distribution:
    - 1 giant function (300KB) — CPU interpreter loop
    - 50 medium functions (1-10KB) — device emulation, memory management, instruction helpers
    - 426 small functions (<1KB) — utility functions, flag computations, TLB ops

# -------------------------------------------------------------------
# CPU Interpreter Dispatch Structure
# -------------------------------------------------------------------

cpu_dispatch:
  description: >
    The CPU core is a single function with a main loop that:
    1. Decrements instruction counter
    2. Checks for interrupts/exceptions
    3. Fetches opcode byte via TLB
    4. br_table[769 entries] dispatches to handler
    5. Handler executes instruction
    6. Loop back (continue)

  main_table:
    entries_0_255: 16-bit operand size
    entries_256_511: 32-bit operand size
    entries_512_767: 64-bit operand size

  sub_dispatches: >
    104 additional br_table dispatches for:
    - 0F-prefixed opcodes (CMOVcc, SETcc, MOVZX, MOVSX, etc.)
    - x87 FPU opcodes (D8-DF groups, ModR/M-based)
    - Group opcodes (GRP1-GRP5, shifts, bit operations)
    - SSE/MMX instruction families

  instruction_costs_wasm_ops:
    MOV_reg_reg: ~6
    ADD_reg_reg: ~10
    CALL_rel32: ~9
    CMP_Jcc: ~12
    MOV_reg_mem: ~15  # includes TLB lookup
    DIV_r_m64: ~25

# -------------------------------------------------------------------
# Lazy EFLAGS
# -------------------------------------------------------------------

lazy_flags:
  description: >
    Instead of computing 6 status flags (CF, PF, AF, ZF, SF, OF) after every ALU op
    (~30 operations), store 3 values: operation type, source operand, result.
    Materialize actual EFLAGS on-demand only when Jcc/PUSHF/LAHF reads them.
  operation_types: 26 codes (0x00-0x1a)
  enum_values:
    - "None = 0"
    - "Add = 1 (also ADC)"
    - "Sub = 2 (also SBB)"
    - "And = 3"
    - "Or = 4"
    - "Xor = 5"
    - "Cmp = 6"
    - "... through 0x1a for all ALU variants with width-specific derivation"
  stored_per_alu_op:
    - "op_type (u8) — which ALU operation"
    - "width (u8) — operand size (8/16/32/64)"
    - "lhs (u64) — left/source operand"
    - "rhs (u64) — right operand"
    - "res (u64) — computed result"
  materializer_size: 275 bytes in original (very compact switch on op type + width)

# -------------------------------------------------------------------
# Software TLB
# -------------------------------------------------------------------

software_tlb:
  sets: 256
  ways: 4
  page_shift: 12
  page_mask: 0xfff
  lookup_cost: 3 operations on hit (index, compare, add)
  miss_cost: full 4-level page walk (PML4 -> PDP -> PD -> PT)
  separation: separate sets for read, write, execute permissions
  index_formula: "(vaddr >> 8 & 0xff0) + set * 0x1000"
  tag_comparison: "tlb_tags[index] == (vaddr & 0xfffffffffffff000)"

# -------------------------------------------------------------------
# Key Memory-Mapped CPU State (offsets from CPU struct base)
# -------------------------------------------------------------------

cpu_state_offsets:
  gpr_base: 20536         # 16 general-purpose registers (8 bytes each)
  rip: 20664              # instruction pointer
  lazy_source: 20672      # lazy flags source operand
  lazy_result: 20680      # lazy flags result
  lazy_op_type: 20688     # lazy flags operation type
  code_seg_base: 21168    # code segment base
  long_mode_flag: 21417   # 64-bit mode active
  cpl: 21544              # current privilege level (0=kernel, 3=user)
  prefix_state: 21596     # decoded instruction prefix state
  insn_counter: 21600     # remaining instructions in timeslice
  fetch_ptr: 21608        # current instruction fetch pointer (physical)
  insn_start: 21616       # instruction start pointer (for fault recovery)
  code_seg_offset: 21624  # IP -> physical mapping
  last_mem_result: 21632  # last memory access result
  apic_ptr: 21656         # interrupt controller pointer
  tlb_tags: 38064         # TLB tag array start
  tlb_set_index: 46256    # TLB set index

# -------------------------------------------------------------------
# Key Functions (by role, with original sizes for calibration)
# -------------------------------------------------------------------

key_functions:
  cpu_core:
    - name: cpu_interpreter
      original_size: 300899
      role: "Main execution loop — 769-entry br_table dispatching all x86_64 opcodes"
    - name: prefix_handler
      original_size: 7680
      role: "Prefix bytes (REX 0x40-0x4F, segment overrides, 0x66, 0x67), fetches opcode via TLB"
    - name: modrm_decoder
      original_size: 5641
      role: "ModR/M decoder + memory operand: addressing modes, effective address computation"
    - name: interrupt_delivery
      original_size: 2939
      role: "Push CPU state, load IDT vector, switch to kernel stack"
    - name: mem_read_tlb
      original_size: 709
      role: "Virtual address translation with TLB, page walk on miss"
    - name: mem_write_tlb
      original_size: 1720
      role: "Virtual address translation for writes, page fault handling"
    - name: page_walker
      original_size: 459
      role: "4-level page walk (PML4->PDP->PD->PT)"
    - name: eflags_compute
      original_size: 275
      role: "Lazy flags materializer — switch on op type + width"
    - name: condition_eval
      original_size: 239
      role: "Evaluate x86 condition codes (JZ, JB, JL, etc.) from lazy flags"

  fpu_sse:
    - name: fpu_div80
      original_size: 2145
      role: "x87 80-bit long double division"
    - name: fpu_mul80
      original_size: 2138
      role: "x87 80-bit long double multiplication"
    - name: fpu_dispatch
      original_size: 1852
      role: "x87 FPU instruction dispatcher"
    - name: fpu_sse_exec
      original_size: 5826
      role: "FPU/SSE instruction execution"
    - name: fpu_extended
      original_size: 5542
      role: "Extended FPU ops (FSIN, FCOS, FSQRT, etc.)"

  devices:
    - name: io_port_dispatch
      original_size: 3935
      role: "I/O port dispatch (IN/OUT instructions)"
    - name: pci_config
      original_size: 2492
      role: "PCI configuration space handler"
    - name: virtio_handler
      original_size: 1697
      role: "VirtIO device handler"
    - name: virtio_queue
      original_size: 1944
      role: "VirtIO queue processing"
    - name: virtio_block
      original_size: 1784
      role: "VirtIO block device (disk I/O)"
    - name: virtio_net
      original_size: 2726
      role: "VirtIO network device"
    - name: virtio_9p
      original_size: 5645
      role: "VirtIO 9p filesystem (VFSync bridge)"

  memory:
    - name: malloc
      original_size: 5189
      role: "Custom heap allocator (dlmalloc variant)"
    - name: free
      original_size: 1538
      role: "Heap free"

# -------------------------------------------------------------------
# WASM Export Table (public API exposed to JS host)
# -------------------------------------------------------------------

wasm_exports:
  - { name: vm_start, sig: "void(u32 cfg, u32 w, u32 h, ...)", role: "Main entry point — parse config, create VM, boot kernel" }
  - { name: console_queue_char, sig: "void(u32 char)", role: "Send keystroke to VM console input" }
  - { name: console_resize_event, sig: "void()", role: "Notify VM terminal dimensions changed" }
  - { name: display_key_event, sig: "void(u32 keycode, u32 down)", role: "Keyboard event to graphical display" }
  - { name: display_mouse_event, sig: "void(u32 dx, u32 dy, u32 buttons)", role: "Mouse event to graphical display" }
  - { name: display_wheel_event, sig: "void(u32 delta)", role: "Mouse wheel event" }
  - { name: net_write_packet, sig: "u32(u32 buf, u32 len, ...)", role: "Write Ethernet frame to virtual NIC" }
  - { name: net_set_carrier, sig: "void(u32 carrier)", role: "Set network link state" }
  - { name: fs_import_file, sig: "void(u32 name, u32 buf, u32 len)", role: "Import file into VM filesystem" }
  - { name: malloc, sig: "u32(u32 size)", role: "Heap malloc" }
  - { name: free, sig: "void(u32 ptr)", role: "Heap free" }

# -------------------------------------------------------------------
# WASM Import Table (functions the WASM module calls out to JS host)
# -------------------------------------------------------------------

wasm_imports:
  io:
    - { name: console_write, sig: "void(u32, u32, u32)", role: "Write text to terminal" }
    - { name: console_get_size, sig: "void(u32, u32)", role: "Get terminal dimensions" }
    - { name: fb_refresh, sig: "void(u32 * 7)", role: "Refresh framebuffer region" }
    - { name: net_recv_packet, sig: "void(u32, u32, u32)", role: "Deliver received Ethernet frame" }
    - { name: fs_export_file, sig: "void(u32, u32, u32)", role: "Export file from VM to host" }
  filesystem:
    - { name: file_buffer_init, sig: "void(u32)", role: "Initialize a file buffer" }
    - { name: file_buffer_read, sig: "void(u32, u32, u32, u32)", role: "Read from file buffer" }
    - { name: file_buffer_write, sig: "void(u32, u32, u32, u32)", role: "Write to file buffer" }
    - { name: file_buffer_resize, sig: "u32(u32, u32)", role: "Resize file buffer" }
    - { name: file_buffer_reset, sig: "void(u32)", role: "Reset file buffer" }
    - { name: file_buffer_set, sig: "void(u32, u32, u32, u32)", role: "Memset file buffer region" }
    - { name: fs_wget_update_downloading, sig: "void(u32)", role: "Update download indicator" }
  async:
    - { name: emscripten_async_wget3_data, sig: "u32(u32 * 11)", role: "Async HTTP fetch (XHR) for VFSync" }
    - { name: emscripten_async_call, sig: "void(u32, u32, u32)", role: "Schedule async callback (setTimeout/rAF)" }
  runtime:
    - { name: emscripten_date_now, sig: "f64()", role: "Date.now() wall clock" }
    - { name: emscripten_random, sig: "f32()", role: "Math.random()" }
    - { name: emscripten_resize_heap, sig: "u32(u32)", role: "Grow WASM linear memory" }
    - { name: fd_write, sig: "u32(u32, u32, u32, u32)", role: "WASI fd_write (stdout/stderr)" }
    - { name: fd_seek, sig: "u32(u32, u64, u32, u32)", role: "WASI stub (returns ENOSYS)" }
    - { name: fd_close, sig: "u32(u32)", role: "WASI stub (returns ENOSYS)" }
    - { name: clock_time_get, sig: "u32(u32, u64, u32)", role: "WASI monotonic/realtime clock" }
  time:
    - { name: gmtime_js, sig: "void(u64, u32)", role: "UTC struct tm" }
    - { name: localtime_js, sig: "void(u64, u32)", role: "Local struct tm" }
    - { name: tzset_js, sig: "void(u32, u32, u32, u32)", role: "Timezone data" }
  control:
    - { name: assert_fail, sig: "void(u32, u32, u32, u32)", role: "Assertion failure" }
    - { name: exit, sig: "void(u32)", role: "Process exit" }
    - { name: abort_js, sig: "void()", role: "Abort execution" }

# -------------------------------------------------------------------
# Device Emulation Strategy
# -------------------------------------------------------------------

device_strategy:
  emulated_in_wasm:
    - "CPU (x86_64, long mode, ring 0/3)"
    - "MMU (4-level paging, NX, WP)"
    - "PIC (8259 dual) + PIT (8254)"
    - "UART (16550, 1 port)"
    - "VirtIO (block, net, 9p, console)"
    - "PCI (type 0 config space)"

  delegated_to_host:
    - "Terminal I/O -> console_write / console_get_size"
    - "Display -> fb_refresh + Canvas putImageData"
    - "Networking -> net_recv_packet + WebSocket relay"
    - "Filesystem -> emscripten_async_wget3_data (VFSync HTTP)"
    - "Clock -> emscripten_date_now / clock_time_get"
    - "RNG -> emscripten_random (Math.random)"

  deliberately_omitted:
    - "JIT compilation (WASM engine compensates)"
    - "SMP / multi-core (would require SharedArrayBuffer)"
    - "ACPI / power management"
    - "USB stack (VirtIO replaces)"
    - "BIOS/UEFI firmware (direct kernel load)"
    - "GPU / display driver (Canvas putImageData replaces VGA)"
    - "Sound / audio"
    - "x86 real mode (kernel starts in protected/long mode)"
    - "Hardware RNG (Math.random via import)"
    - "Accurate PIT/TSC timing"

# -------------------------------------------------------------------
# Cooperative Scheduling
# -------------------------------------------------------------------

cooperative_scheduling:
  description: >
    CPU loop decrements instruction counter at offset 21600. When it hits zero,
    returns to host. Host schedules re-entry via setTimeout or requestAnimationFrame
    using Emscripten's async_call. No threads, no SharedArrayBuffer.
  yield_path: >
    CPU loop -> counter reaches 0 -> return to Emscripten scheduler
    -> emscripten_async_call(func, arg, millis)
    -> millis >= 0: setTimeout(wrapper, millis)
    -> millis < 0: requestAnimationFrame(wrapper)
    -> browser event loop runs
    -> timer fires -> getWasmTableEntry(func)(arg) -> CPU loop resumes

# -------------------------------------------------------------------
# Rust Architecture Template (from specs/IDEA.md)
# -------------------------------------------------------------------

architecture_template: |

  use core::ptr::{read_unaligned, write_unaligned};

  const TLB_SETS: usize = 256;
  const TLB_WAYS: usize = 4;
  const PAGE_SHIFT: u64 = 12;
  const PAGE_MASK: u64 = 0xfff;

  #[repr(u8)]
  #[derive(Copy, Clone)]
  pub enum FlagOp {
      None = 0,
      Add,    // also ADC
      Sub,    // also SBB
      And,
      Or,
      Xor,
      Cmp,
      // ... through 0x1a for all ALU variants
  }

  #[repr(C)]
  #[derive(Copy, Clone)]
  pub struct LazyFlags {
      pub op: FlagOp,
      pub width: u8,      // 8, 16, 32, or 64
      pub lhs: u64,
      pub rhs: u64,
      pub res: u64,
  }

  #[repr(C)]
  #[derive(Copy, Clone)]
  pub struct TlbEntry {
      pub tag: u64,
      pub host_page: u64,
      pub perms: u8,
  }

  #[repr(C)]
  pub struct Tlb {
      pub sets: [[TlbEntry; TLB_WAYS]; TLB_SETS],
  }

  #[repr(C)]
  pub struct Cpu {
      pub regs: [u64; 16],
      pub rip: u64,
      pub rflags: u64,
      pub cr3: u64,
      pub lazy: LazyFlags,
      pub tlb: Tlb,
      pub long_mode: bool,
      pub cpl: u8,
  }

  #[repr(C)]
  pub struct Machine {
      pub cpu: Cpu,
      pub ram: *mut u8,
      pub ram_size: u64,
  }

  // --- TLB (3 ops on hit) ---

  impl Cpu {
      #[inline(always)]
      unsafe fn tlb_lookup(&mut self, vaddr: u64) -> Option<u64> {
          let page = vaddr >> PAGE_SHIFT;
          let set = (page as usize) & (TLB_SETS - 1);
          for way in 0..TLB_WAYS {
              let entry = &self.tlb.sets[set][way];
              if entry.tag == page {
                  return Some(entry.host_page | (vaddr & PAGE_MASK));
              }
          }
          None  // -> page walk
      }
  }

  // --- Lazy Flags (3 stores per ALU op) ---

  impl Cpu {
      #[inline(always)]
      fn set_lazy(&mut self, op: FlagOp, width: u8, lhs: u64, rhs: u64, res: u64) {
          self.lazy = LazyFlags { op, width, lhs, rhs, res };
      }

      #[inline(always)]
      fn materialize_flags(&mut self) {
          // switch on self.lazy.op + self.lazy.width to compute CF/PF/AF/ZF/SF/OF
          // only called by Jcc, SETcc, PUSHF, LAHF
      }
  }

  // --- Monolithic Interpreter (compiles to br_table) ---

  impl Cpu {
      pub unsafe fn exec(&mut self, mach: &mut Machine, mut budget: i32) -> i32 {
          loop {
              if budget <= 0 { return budget; }
              budget -= 1;

              let opcode = self.fetch_u8(mach);
              let idx = opcode as u32 + ((self.opsize_lane() as u32) << 8);

              match idx {
                  // 769 entries: 0-255 (16-bit), 256-511 (32-bit), 512-767 (64-bit)
                  // Each handler: execute instruction, update RIP, set lazy flags
                  // Sub-dispatches for 0F prefix, FPU D8-DF, GRP1-GRP5
                  _ => {}
              }
          }
      }
  }

  // --- Cooperative Scheduler (WASM export) ---

  #[no_mangle]
  pub unsafe extern "C" fn vm_step(machine: *mut Machine, budget: i32) -> i32 {
      let mach = &mut *machine;
      mach.cpu.exec(mach, budget)
  }

performance_rules:
  - Ensure dispatch compiles to br_table (dense match, no gaps).
  - Keep interpreter as one function > 100KB.
  - Keep hot variables as locals inside exec().
  - Ensure TLB lookup is branch-minimal (3 ops on hit).
  - Keep flags lazy until Jcc/SETcc/PUSHF/LAHF.
  - Avoid spilling via unnecessary struct accesses.
  - No function calls in opcode handlers (inline everything).
  - Use wrapping arithmetic for all ALU operations.
  - Batch I/O at yield points, not inside instruction handlers.

wasm_targets:
  - wasm32-unknown-unknown
  - WASI
  - browser WebAssembly

build_profile:
  release:
    opt-level: "z"      # smaller = better icache for interpreters
    lto: "fat"
    codegen-units: 1
    panic: "abort"
    strip: true

# -------------------------------------------------------------------
# VM Configuration (original)
# -------------------------------------------------------------------

vm_config:
  machine: "pc"
  memory_size: 256    # MB
  kernel: "kernel-x86_64.bin"   # 9.3MB bzImage, only large download
  cmdline: "loglevel=3 console=hvc0 root=root rootfstype=9p rootflags=trans=virtio ro"
  fs0: "https://vfsync.org/u/os/alpine-x86_64"   # 9p root via VFSync (on-demand HTTP)
  eth0: "user"   # User-mode networking (SLiRP)

# -------------------------------------------------------------------
# Reference Files (for reverse engineering)
# -------------------------------------------------------------------

reference_files:
  reading_order:
    1: "jslinux/ghidra-functions.txt — function index, find what you need"
    2: "jslinux/ghidra-decompiled.c — typed C for 449 helper functions (everything except CPU loop)"
    3: "jslinux/cpu-cases.c — annotated opcode handlers with x86 instruction names"
    4: "jslinux/x86_64emu.dcmp — full pseudocode when you need complete context"
    5: "specs/IDEA.md — Rust architecture spec for the reimplementation"

output_behavior:
  When generating emulator-related Rust code:
    - Always structure as Bellard-style interpreter.
    - Prefer performance over abstraction.
    - Explicitly note where br_table is expected.
    - Explicitly avoid dynamic dispatch.
    - Keep device boundary separate from CPU core.
    - Match the export/import boundary from the reference architecture.
    - Use the struct layouts from architecture_template.
    - Consult cpu-cases.c for opcode handler reference.
    - Consult ghidra-decompiled.c for device/helper function reference.

examples:
  - Generate x86 opcode skeleton with 769-entry dispatch
  - Implement lazy flags for all 26 operation types
  - Implement software TLB with 256 sets x 4 ways
  - Implement 4-level page walker (PML4->PDP->PD->PT)
  - Implement prefix handler (REX, segment overrides, 0x66, 0x67)
  - Implement ModR/M decoder with all addressing modes
  - Add cooperative timeslice scheduler with yield/resume
  - Provide WASM export glue for vm_step
  - Implement VirtIO device handler
  - Implement I/O port dispatch (IN/OUT)
  - Implement interrupt/exception delivery
