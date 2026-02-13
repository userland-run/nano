// NanoVM core data structures
// All structs are #[repr(C)] for deterministic layout and WASM compatibility.

// ============================================================
// Constants
// ============================================================

pub const TLB_SETS: usize = 256;
pub const TLB_WAYS: usize = 4;
pub const PAGE_SHIFT: u32 = 12;
pub const PAGE_SIZE: u64 = 1 << PAGE_SHIFT;
pub const PAGE_MASK: u64 = PAGE_SIZE - 1;

pub const NUM_GPRS: usize = 16;

// x86-64 register indices
pub const RAX: usize = 0;
pub const RCX: usize = 1;
pub const RDX: usize = 2;
pub const RBX: usize = 3;
pub const RSP: usize = 4;
pub const RBP: usize = 5;
pub const RSI: usize = 6;
pub const RDI: usize = 7;
pub const R8: usize = 8;
pub const R9: usize = 9;
pub const R10: usize = 10;
pub const R11: usize = 11;
pub const R12: usize = 12;
pub const R13: usize = 13;
pub const R14: usize = 14;
pub const R15: usize = 15;

// RFLAGS bit positions
pub const CF_BIT: u64 = 0;
pub const PF_BIT: u64 = 2;
pub const AF_BIT: u64 = 4;
pub const ZF_BIT: u64 = 6;
pub const SF_BIT: u64 = 7;
pub const TF_BIT: u64 = 8;
pub const IF_BIT: u64 = 9;
pub const DF_BIT: u64 = 10;
pub const OF_BIT: u64 = 11;
pub const IOPL_BIT: u64 = 12;
pub const NT_BIT: u64 = 14;
pub const RF_BIT: u64 = 16;
pub const VM_BIT: u64 = 17;
pub const AC_BIT: u64 = 18;
pub const VIF_BIT: u64 = 19;
pub const VIP_BIT: u64 = 20;
pub const ID_BIT: u64 = 21;

pub const CF: u64 = 1 << CF_BIT;
pub const PF: u64 = 1 << PF_BIT;
pub const AF: u64 = 1 << AF_BIT;
pub const ZF: u64 = 1 << ZF_BIT;
pub const SF: u64 = 1 << SF_BIT;
pub const TF: u64 = 1 << TF_BIT;
pub const IF: u64 = 1 << IF_BIT;
pub const DF: u64 = 1 << DF_BIT;
pub const OF: u64 = 1 << OF_BIT;
pub const IOPL_MASK: u64 = 3 << IOPL_BIT;
pub const NT: u64 = 1 << NT_BIT;
pub const RF: u64 = 1 << RF_BIT;
pub const VM: u64 = 1 << VM_BIT;
pub const AC: u64 = 1 << AC_BIT;
pub const VIF: u64 = 1 << VIF_BIT;
pub const VIP: u64 = 1 << VIP_BIT;
pub const ID: u64 = 1 << ID_BIT;

// CR0 bits
pub const CR0_PE: u64 = 1 << 0;
pub const CR0_MP: u64 = 1 << 1;
pub const CR0_EM: u64 = 1 << 2;
pub const CR0_TS: u64 = 1 << 3;
pub const CR0_ET: u64 = 1 << 4;
pub const CR0_NE: u64 = 1 << 5;
pub const CR0_WP: u64 = 1 << 16;
pub const CR0_AM: u64 = 1 << 18;
pub const CR0_NW: u64 = 1 << 29;
pub const CR0_CD: u64 = 1 << 30;
pub const CR0_PG: u64 = 1 << 31;

// CR4 bits
pub const CR4_VME: u64 = 1 << 0;
pub const CR4_PVI: u64 = 1 << 1;
pub const CR4_TSD: u64 = 1 << 2;
pub const CR4_DE: u64 = 1 << 3;
pub const CR4_PSE: u64 = 1 << 4;
pub const CR4_PAE: u64 = 1 << 5;
pub const CR4_MCE: u64 = 1 << 6;
pub const CR4_PGE: u64 = 1 << 7;
pub const CR4_OSFXSR: u64 = 1 << 9;
pub const CR4_OSXMMEXCPT: u64 = 1 << 10;

// EFER bits (MSR 0xC0000080)
pub const EFER_SCE: u64 = 1 << 0;
pub const EFER_LME: u64 = 1 << 8;
pub const EFER_LMA: u64 = 1 << 10;
pub const EFER_NXE: u64 = 1 << 11;

// Segment register indices
pub const SEG_ES: usize = 0;
pub const SEG_CS: usize = 1;
pub const SEG_SS: usize = 2;
pub const SEG_DS: usize = 3;
pub const SEG_FS: usize = 4;
pub const SEG_GS: usize = 5;

// Exception vectors
pub const EXC_DE: u32 = 0;   // Divide Error
pub const EXC_DB: u32 = 1;   // Debug
pub const EXC_NMI: u32 = 2;  // NMI
pub const EXC_BP: u32 = 3;   // Breakpoint
pub const EXC_OF: u32 = 4;   // Overflow
pub const EXC_BR: u32 = 5;   // BOUND Range
pub const EXC_UD: u32 = 6;   // Undefined Opcode
pub const EXC_NM: u32 = 7;   // Device Not Available
pub const EXC_DF: u32 = 8;   // Double Fault
pub const EXC_TS: u32 = 10;  // Invalid TSS
pub const EXC_NP: u32 = 11;  // Segment Not Present
pub const EXC_SS: u32 = 12;  // Stack Segment Fault
pub const EXC_GP: u32 = 13;  // General Protection
pub const EXC_PF: u32 = 14;  // Page Fault
pub const EXC_MF: u32 = 16;  // x87 FP Exception
pub const EXC_AC: u32 = 17;  // Alignment Check
pub const EXC_XF: u32 = 19;  // SIMD FP Exception

// ============================================================
// Lazy EFLAGS
// ============================================================

/// Lazy flag operation types. Maps to TinyEMU's operation type codes.
/// After each ALU op, we store (op, width, src, res) and defer flag computation.
#[repr(u8)]
#[derive(Copy, Clone, PartialEq, Eq)]
pub enum FlagOp {
    // 8-bit operations (codes 0x00-0x06)
    AddB = 0,
    OrB  = 1,
    AdcB = 2,
    SbbB = 3,
    AndB = 4,
    SubB = 5,
    XorB = 6,
    // 16-bit operations (codes 0x07-0x0d)
    AddW = 7,
    OrW  = 8,
    AdcW = 9,
    SbbW = 10,
    AndW = 11,
    SubW = 12,
    XorW = 13,
    // 32-bit operations (codes 0x0e-0x14)
    AddL = 14,
    OrL  = 15,
    AdcL = 16,
    SbbL = 17,
    AndL = 18,
    SubL = 19,
    XorL = 20,
    // 64-bit operations (codes 0x15-0x1b)
    AddQ = 21,
    OrQ  = 22,
    AdcQ = 23,
    SbbQ = 24,
    AndQ = 25,
    SubQ = 26,
    XorQ = 27,
    // Shift/rotate operations
    ShlB = 28,
    ShlW = 29,
    ShlL = 30,
    ShlQ = 31,
    SarB = 32,
    SarW = 33,
    SarL = 34,
    SarQ = 35,
    // INC/DEC (like ADD/SUB but preserve CF)
    IncB = 36,
    IncW = 37,
    IncL = 38,
    IncQ = 39,
    DecB = 40,
    DecW = 41,
    DecL = 42,
    DecQ = 43,
    // Bit test
    BtL  = 44,
    BtQ  = 45,
    // External (flags set directly via rflags)
    External = 46,
}

/// Lazy flags state — stores deferred flag computation inputs.
/// Actual EFLAGS are computed on-demand by `materialize_flags()`.
#[repr(C)]
#[derive(Copy, Clone)]
pub struct LazyFlags {
    pub op: FlagOp,
    pub src: u64,   // source operand (lhs for ADD, rhs for SUB)
    pub res: u64,   // result of the operation
}

impl LazyFlags {
    pub const fn new() -> Self {
        Self {
            op: FlagOp::External,
            src: 0,
            res: 0,
        }
    }
}

// ============================================================
// Software TLB
// ============================================================

/// TLB entry: tag (virtual page number) + host pointer offset.
#[repr(C)]
#[derive(Copy, Clone)]
pub struct TlbEntry {
    /// Virtual page number (vaddr & ~0xFFF). 0xFFFFFFFFFFFFFFFF = invalid.
    pub tag: u64,
    /// Host pointer base: (ram_base + phys_page - vaddr_page) so that
    /// host_addr = addend + vaddr gives the host pointer.
    pub addend: u32,
}

impl TlbEntry {
    pub const INVALID: Self = Self {
        tag: !0u64,
        addend: 0,
    };
}

/// Software TLB — 256 sets x 4 ways, separate arrays for read/write/code.
#[repr(C)]
pub struct Tlb {
    pub read: [[TlbEntry; TLB_WAYS]; TLB_SETS],
    pub write: [[TlbEntry; TLB_WAYS]; TLB_SETS],
    pub code: [[TlbEntry; TLB_WAYS]; TLB_SETS],
}

impl Tlb {
    pub fn flush_all(&mut self) {
        for set in self.read.iter_mut() {
            for entry in set.iter_mut() {
                *entry = TlbEntry::INVALID;
            }
        }
        for set in self.write.iter_mut() {
            for entry in set.iter_mut() {
                *entry = TlbEntry::INVALID;
            }
        }
        for set in self.code.iter_mut() {
            for entry in set.iter_mut() {
                *entry = TlbEntry::INVALID;
            }
        }
    }

    pub fn flush_page(&mut self, vaddr: u64) {
        let page = vaddr & !PAGE_MASK;
        let set_idx = ((vaddr >> PAGE_SHIFT) as usize) & (TLB_SETS - 1);
        for way in 0..TLB_WAYS {
            if self.read[set_idx][way].tag == page {
                self.read[set_idx][way] = TlbEntry::INVALID;
            }
            if self.write[set_idx][way].tag == page {
                self.write[set_idx][way] = TlbEntry::INVALID;
            }
            if self.code[set_idx][way].tag == page {
                self.code[set_idx][way] = TlbEntry::INVALID;
            }
        }
    }
}

// ============================================================
// Segment descriptors
// ============================================================

#[repr(C)]
#[derive(Copy, Clone)]
pub struct SegmentReg {
    pub selector: u16,
    pub base: u64,
    pub limit: u32,
    pub flags: u32,  // access rights / descriptor type
}

impl SegmentReg {
    pub const fn new() -> Self {
        Self {
            selector: 0,
            base: 0,
            limit: 0,
            flags: 0,
        }
    }
}

/// Descriptor table register (GDTR / IDTR)
#[repr(C)]
#[derive(Copy, Clone)]
pub struct DtReg {
    pub base: u64,
    pub limit: u16,
}

impl DtReg {
    pub const fn new() -> Self {
        Self { base: 0, limit: 0 }
    }
}

// ============================================================
// FPU State
// ============================================================

/// x87 FPU state
#[repr(C)]
pub struct FpuState {
    pub regs: [u64; 8],       // 64-bit mantissa of 80-bit extended (simplified)
    pub regs_exp: [u16; 8],   // exponent + sign for 80-bit
    pub status: u16,          // FPU status word
    pub control: u16,         // FPU control word
    pub tag: u16,             // FPU tag word
    pub top: u8,              // top of stack pointer (0-7)
}

impl FpuState {
    pub const fn new() -> Self {
        Self {
            regs: [0; 8],
            regs_exp: [0; 8],
            status: 0,
            control: 0x037F, // default control word
            tag: 0xFFFF,     // all empty
            top: 0,
        }
    }
}

/// SSE state (XMM registers)
#[repr(C)]
pub struct SseState {
    pub xmm: [[u64; 2]; 16],  // 16 XMM registers, 128 bits each
    pub mxcsr: u32,            // MXCSR control/status
}

impl SseState {
    pub const fn new() -> Self {
        Self {
            xmm: [[0; 2]; 16],
            mxcsr: 0x1F80, // default MXCSR
        }
    }
}

// ============================================================
// CPU State
// ============================================================

/// Decoded prefix state for current instruction
#[repr(C)]
#[derive(Copy, Clone)]
pub struct PrefixState {
    pub rex: u8,            // REX prefix byte (0 if none)
    pub seg_override: i8,   // segment override index (-1 = none)
    pub op_size: bool,      // 0x66 prefix present
    pub addr_size: bool,    // 0x67 prefix present
    pub rep: u8,            // 0=none, 0xF2=REPNE, 0xF3=REP/REPE
    pub lock: bool,         // LOCK prefix
}

impl PrefixState {
    pub const fn new() -> Self {
        Self {
            rex: 0,
            seg_override: -1,
            op_size: false,
            addr_size: false,
            rep: 0,
            lock: false,
        }
    }
}

/// The complete CPU state.
#[repr(C)]
pub struct Cpu {
    // General-purpose registers (RAX..R15)
    pub regs: [u64; NUM_GPRS],

    // Instruction pointer
    pub rip: u64,

    // Flags
    pub rflags: u64,
    pub lazy: LazyFlags,

    // Control registers
    pub cr0: u64,
    pub cr2: u64,  // page fault linear address
    pub cr3: u64,  // page table base
    pub cr4: u64,
    pub cr8: u64,  // TPR (task priority register)

    // Model-specific registers
    pub efer: u64,           // Extended Feature Enable Register
    pub star: u64,           // SYSCALL target address
    pub lstar: u64,          // SYSCALL target address (long mode)
    pub cstar: u64,          // SYSCALL target address (compat mode)
    pub fmask: u64,          // SYSCALL flag mask
    pub kernel_gs_base: u64, // SWAPGS base
    pub tsc: u64,            // timestamp counter
    pub tsc_offset: u64,     // offset for rdtsc
    pub apic_base: u64,      // APIC base MSR

    // Segment registers
    pub segs: [SegmentReg; 6],  // ES, CS, SS, DS, FS, GS
    pub ldt: SegmentReg,
    pub tr: SegmentReg,          // task register

    // Descriptor table registers
    pub gdt: DtReg,
    pub idt: DtReg,

    // Operating mode
    pub long_mode: bool,     // 64-bit long mode active
    pub cpl: u8,             // current privilege level (0=kernel, 3=user)
    pub a20_mask: u64,       // A20 gate mask (0xFFFFFFFF or 0xFFEFFFFF)

    // Instruction decode state (per-instruction, reset each cycle)
    pub prefix: PrefixState,
    pub instr_start_rip: u64,   // RIP at start of current instruction

    // Instruction budget (cooperative scheduling)
    pub budget: i32,

    // Interrupt state
    pub irq_pending: bool,    // external interrupt pending
    pub nmi_pending: bool,    // NMI pending
    pub inhibit_irq: bool,    // interrupt inhibited (after MOV SS, POP SS)
    pub halted: bool,         // HLT state

    // Software TLB
    pub tlb: Tlb,

    // FPU / SSE
    pub fpu: FpuState,
    pub sse: SseState,
}

impl Cpu {
    pub fn new() -> Self {
        // Safety: Tlb is large (~73KB), zero-init is correct since we flush after
        let mut cpu = Cpu {
            regs: [0; NUM_GPRS],
            rip: 0,
            rflags: 0x2, // bit 1 always set
            lazy: LazyFlags::new(),
            cr0: 0,
            cr2: 0,
            cr3: 0,
            cr4: 0,
            cr8: 0,
            efer: 0,
            star: 0,
            lstar: 0,
            cstar: 0,
            fmask: 0,
            kernel_gs_base: 0,
            tsc: 0,
            tsc_offset: 0,
            apic_base: 0xFEE00900, // base | BSP(bit8) | enable(bit11)
            segs: [SegmentReg::new(); 6],
            ldt: SegmentReg::new(),
            tr: SegmentReg::new(),
            gdt: DtReg::new(),
            idt: DtReg::new(),
            long_mode: false,
            cpl: 0,
            a20_mask: 0xFFFFFFFF,
            prefix: PrefixState::new(),
            instr_start_rip: 0,
            budget: 0,
            irq_pending: false,
            nmi_pending: false,
            inhibit_irq: false,
            halted: false,
            // Safety: we'll flush_all right after construction
            tlb: unsafe { core::mem::zeroed() },
            fpu: FpuState::new(),
            sse: SseState::new(),
        };
        cpu.tlb.flush_all();
        cpu
    }
}

// ============================================================
// I/O Port Dispatch
// ============================================================

/// I/O port registration entry
#[repr(C)]
#[derive(Copy, Clone)]
pub struct IoPortEntry {
    pub base: u16,
    pub size: u16,
    pub opaque: u32,       // pointer/index to device context
    pub read_fn: u32,      // function table index for read
    pub write_fn: u32,     // function table index for write
}

// ============================================================
// PCI Configuration
// ============================================================

pub const PCI_MAX_DEVICES: usize = 32;

#[repr(C)]
pub struct PciDevice {
    pub config: [u8; 256],
    pub active: bool,
    pub opaque: u32,
    pub bar_size: [u32; 6],
}

impl PciDevice {
    pub const fn new() -> Self {
        Self {
            config: [0; 256],
            active: false,
            opaque: 0,
            bar_size: [0; 6],
        }
    }
}

// ============================================================
// VirtIO
// ============================================================

pub const VIRTQ_MAX_SIZE: usize = 256;

#[repr(C)]
#[derive(Copy, Clone)]
pub struct VirtqDesc {
    pub addr: u64,
    pub len: u32,
    pub flags: u16,
    pub next: u16,
}

#[repr(C)]
pub struct Virtqueue {
    pub num: u32,              // queue size
    pub desc_addr: u64,        // descriptor table address
    pub avail_addr: u64,       // available ring address
    pub used_addr: u64,        // used ring address
    pub last_avail_idx: u16,   // last processed available index
    pub ready: bool,
}

impl Virtqueue {
    pub const fn new() -> Self {
        Self {
            num: VIRTQ_MAX_SIZE as u32,
            desc_addr: 0,
            avail_addr: 0,
            used_addr: 0,
            last_avail_idx: 0,
            ready: false,
        }
    }
}

// ============================================================
// Machine (top-level)
// ============================================================

/// Console input FIFO
pub const CONSOLE_FIFO_SIZE: usize = 256;

#[repr(C)]
pub struct ConsoleFifo {
    pub buf: [u8; CONSOLE_FIFO_SIZE],
    pub read_pos: u16,
    pub write_pos: u16,
    pub count: u16,
}

impl ConsoleFifo {
    pub const fn new() -> Self {
        Self {
            buf: [0; CONSOLE_FIFO_SIZE],
            read_pos: 0,
            write_pos: 0,
            count: 0,
        }
    }

    pub fn push(&mut self, ch: u8) -> bool {
        if self.count as usize >= CONSOLE_FIFO_SIZE {
            return false;
        }
        self.buf[self.write_pos as usize] = ch;
        self.write_pos = (self.write_pos + 1) % CONSOLE_FIFO_SIZE as u16;
        self.count += 1;
        true
    }

    pub fn pop(&mut self) -> Option<u8> {
        if self.count == 0 {
            return None;
        }
        let ch = self.buf[self.read_pos as usize];
        self.read_pos = (self.read_pos + 1) % CONSOLE_FIFO_SIZE as u16;
        self.count -= 1;
        Some(ch)
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }
}

/// The Machine struct — holds all emulator state.
#[repr(C)]
pub struct Machine {
    pub cpu: Cpu,
    pub ram: *mut u8,
    pub ram_size: u32,

    // PCI bus
    pub pci_addr: u32,   // PCI config address register (port 0xCF8)
    pub pci_devices: [PciDevice; PCI_MAX_DEVICES],

    // Interrupt controller (PIC)
    pub pic_master: PicState,
    pub pic_slave: PicState,

    // Timer (PIT)
    pub pit: PitState,

    // Serial console
    pub uart: UartState,
    pub console_fifo: ConsoleFifo,

    // VirtIO devices
    pub virtio_console: VirtioConsole,
    pub virtio_9p: Virtio9p,
    pub virtio_blk: VirtioBlk,
    pub virtio_net: VirtioNet,
}

// Forward declarations for device states (defined in their modules)
#[repr(C)]
pub struct PicState {
    pub irr: u8,       // interrupt request register
    pub imr: u8,       // interrupt mask register
    pub isr: u8,       // in-service register
    pub icw: [u8; 4],  // initialization command words
    pub icw_idx: u8,   // current ICW being programmed
    pub init: bool,     // in initialization sequence
    pub auto_eoi: bool,
    pub rotate_on_auto_eoi: bool,
    pub special_fully_nested: bool,
    pub special_mask: bool,
    pub read_isr: bool, // OCW3: read ISR vs IRR
    pub elcr: u8,       // edge/level control register
    pub irq_base: u8,   // vector base (ICW2)
}

impl PicState {
    pub const fn new() -> Self {
        Self {
            irr: 0,
            imr: 0xFF,  // all masked initially
            isr: 0,
            icw: [0; 4],
            icw_idx: 0,
            init: false,
            auto_eoi: false,
            rotate_on_auto_eoi: false,
            special_fully_nested: false,
            special_mask: false,
            read_isr: false,
            elcr: 0,
            irq_base: 0,
        }
    }
}

#[repr(C)]
pub struct PitChannel {
    pub count: u16,       // current counter value
    pub latch: u16,       // latched counter value
    pub reload: u16,      // reload value
    pub mode: u8,         // operating mode (0-5)
    pub rw_mode: u8,      // read/write mode
    pub read_state: u8,   // read state machine
    pub write_state: u8,  // write state machine
    pub latched: bool,    // counter is latched
    pub gate: bool,       // gate input
    pub out: bool,        // output state
}

impl PitChannel {
    pub const fn new() -> Self {
        Self {
            count: 0,
            latch: 0,
            reload: 0,
            mode: 0,
            rw_mode: 0,
            read_state: 0,
            write_state: 0,
            latched: false,
            gate: true,
            out: false,
        }
    }
}

#[repr(C)]
pub struct PitState {
    pub channels: [PitChannel; 3],
    pub last_time_ms: f64,   // last update timestamp
}

impl PitState {
    pub const fn new() -> Self {
        Self {
            channels: [PitChannel::new(), PitChannel::new(), PitChannel::new()],
            last_time_ms: 0.0,
        }
    }
}

#[repr(C)]
pub struct UartState {
    pub thr: u8,        // transmit holding register
    pub rbr: u8,        // receive buffer register
    pub ier: u8,        // interrupt enable register
    pub iir: u8,        // interrupt identification register
    pub lcr: u8,        // line control register
    pub mcr: u8,        // modem control register
    pub lsr: u8,        // line status register
    pub msr: u8,        // modem status register
    pub scr: u8,        // scratch register
    pub dll: u8,        // divisor latch low
    pub dlh: u8,        // divisor latch high
    pub fcr: u8,        // FIFO control register
    pub irq: u8,        // IRQ number (4 for COM1)
}

impl UartState {
    pub const fn new() -> Self {
        Self {
            thr: 0,
            rbr: 0,
            ier: 0,
            iir: 0x01,  // no pending interrupt
            lcr: 0,
            mcr: 0,
            lsr: 0x60,  // transmitter empty + THR empty
            msr: 0,
            scr: 0,
            dll: 0,
            dlh: 0,
            fcr: 0,
            irq: 4,
        }
    }
}

// VirtIO device structs

#[repr(C)]
pub struct VirtioCommon {
    pub device_id: u32,
    pub vendor_id: u32,
    pub status: u32,
    pub device_features: u64,
    pub driver_features: u64,
    pub queue_sel: u32,
    pub isr: u32,
    pub config_gen: u32,
    pub pci_slot: u8,
    pub irq: u8,
}

impl VirtioCommon {
    pub const fn new(device_id: u32) -> Self {
        Self {
            device_id,
            vendor_id: 0x1AF4,
            status: 0,
            device_features: 0,
            driver_features: 0,
            queue_sel: 0,
            isr: 0,
            config_gen: 0,
            pci_slot: 0,
            irq: 0,
        }
    }
}

#[repr(C)]
pub struct VirtioConsole {
    pub common: VirtioCommon,
    pub queues: [Virtqueue; 2],  // rx, tx
}

impl VirtioConsole {
    pub const fn new() -> Self {
        Self {
            common: VirtioCommon::new(3), // VirtIO console type
            queues: [Virtqueue::new(), Virtqueue::new()],
        }
    }
}

#[repr(C)]
pub struct Virtio9p {
    pub common: VirtioCommon,
    pub queues: [Virtqueue; 1],
    pub mount_tag: [u8; 32],
    pub mount_tag_len: u8,
}

impl Virtio9p {
    pub const fn new() -> Self {
        Self {
            common: VirtioCommon::new(9), // VirtIO 9p type
            queues: [Virtqueue::new()],
            mount_tag: [0; 32],
            mount_tag_len: 0,
        }
    }
}

#[repr(C)]
pub struct VirtioBlk {
    pub common: VirtioCommon,
    pub queues: [Virtqueue; 1],
    pub capacity: u64,
}

impl VirtioBlk {
    pub const fn new() -> Self {
        Self {
            common: VirtioCommon::new(2), // VirtIO block type
            queues: [Virtqueue::new()],
            capacity: 0,
        }
    }
}

#[repr(C)]
pub struct VirtioNet {
    pub common: VirtioCommon,
    pub queues: [Virtqueue; 2],  // rx, tx
    pub mac: [u8; 6],
}

impl VirtioNet {
    pub const fn new() -> Self {
        Self {
            common: VirtioCommon::new(1), // VirtIO network type
            queues: [Virtqueue::new(), Virtqueue::new()],
            mac: [0x52, 0x54, 0x00, 0x12, 0x34, 0x56],
        }
    }
}
