// Kernel loading and boot sequence — bzImage loader, machine init, vm_start.
// Direct kernel loading: no BIOS, no UEFI, no real-mode boot.
// The kernel is loaded into RAM at 0x100000, page tables and GDT set up,
// and the CPU starts in 64-bit long mode.

use crate::types::*;

// Memory layout constants (guest physical addresses)
const BOOT_PARAMS_ADDR: u64 = 0x90000;    // Linux boot_params (zero page)
const CMDLINE_ADDR: u64 = 0x90880;        // Kernel command line
const GDT_ADDR: u64 = 0x91090;            // GDT entries
const PML4_ADDR: u64 = 0x91000;           // PML4 table
const PDP_ADDR: u64 = 0x92000;            // PDP table (for identity map)
const PDP_HIGH_ADDR: u64 = 0x93000;       // PDP table (for kernel high mapping)
const KERNEL_ENTRY: u64 = 0x100000;       // Kernel code start (1MB)

// bzImage header offsets
const BZIMAGE_BOOT_SIG: usize = 0x1FE;    // 0xAA55
const BZIMAGE_HEADER_SIG: usize = 0x202;  // "HdrS" = 0x53726448
const BZIMAGE_SETUP_SECTS: usize = 0x1F1; // Setup sector count

// GDT entries for long mode
const GDT_NULL: u64 = 0x0000000000000000;             // Null descriptor
const GDT_KERNEL_CODE: u64 = 0x00AF9B000000FFFF;      // 64-bit code, DPL=0
const GDT_KERNEL_DATA: u64 = 0x00CF93000000FFFF;      // 64-bit data, DPL=0
const GDT_USER_CODE: u64 = 0x00AFFB000000FFFF;        // 64-bit code, DPL=3
const GDT_USER_DATA: u64 = 0x00CFF3000000FFFF;        // 64-bit data, DPL=3

// CR0 flags
const CR0_PE: u64 = 1 << 0;   // Protected mode
const CR0_MP: u64 = 1 << 1;   // Monitor coprocessor
const CR0_ET: u64 = 1 << 4;   // Extension type
const CR0_NE: u64 = 1 << 5;   // Numeric error
const CR0_WP: u64 = 1 << 16;  // Write protect
const CR0_AM: u64 = 1 << 18;  // Alignment mask
const CR0_PG: u64 = 1 << 31;  // Paging

// CR4 flags
const CR4_PAE: u64 = 1 << 5;  // Physical address extension
const CR4_PGE: u64 = 1 << 7;  // Page global enable
const CR4_OSFXSR: u64 = 1 << 9;  // OS FXSAVE/FXRSTOR support
const CR4_OSXMMEXCPT: u64 = 1 << 10; // OS unmasked exception support

/// Main VM startup — called from the vm_start export.
/// In the real system, kernel_ptr and kernel_size point to the bzImage
/// already loaded into WASM linear memory by the JS host.
pub unsafe fn vm_start_impl(
    _url: u32,
    mem_size_mb: u32,
    _cmdline: u32,
    _pwd: u32,
    _width: u32,
    _height: u32,
    _net_enabled: u32,
    _drive_url: u32,
) {
    let ram_size = if mem_size_mb < 2 { 256 } else { mem_size_mb } * 1024 * 1024;

    // Allocate RAM using our malloc (from WASM linear memory)
    let ram_ptr = crate::exports::malloc(ram_size);
    if ram_ptr == 0 {
        return; // OOM
    }
    let ram = ram_ptr as *mut u8;

    // Zero the first 1MB (important for boot params, page tables, etc.)
    core::ptr::write_bytes(ram, 0, core::cmp::min(ram_size as usize, 0x100000));

    // Create Machine struct
    let mach_ptr = crate::exports::malloc(core::mem::size_of::<Machine>() as u32);
    if mach_ptr == 0 {
        return;
    }
    let mach = &mut *(mach_ptr as *mut Machine);
    core::ptr::write_bytes(mach as *mut Machine as *mut u8, 0, core::mem::size_of::<Machine>());

    // Initialize machine
    mach.ram = ram;
    mach.ram_size = ram_size;
    mach.cpu = Cpu::new();

    // Initialize PIC (master at 0x20, slave at 0xA0)
    mach.pic_master = PicState::new();
    mach.pic_slave = PicState::new();
    mach.pic_master.irq_base = 0x20; // IRQ 0-7 → vectors 0x20-0x27
    mach.pic_slave.irq_base = 0x28;  // IRQ 8-15 → vectors 0x28-0x2F

    // Initialize PIT
    mach.pit = PitState::new();

    // Initialize UART
    mach.uart = UartState::new();

    // Initialize console FIFO
    mach.console_fifo = ConsoleFifo::new();

    // Set global machine pointer
    crate::exports::set_machine(mach as *mut Machine);

    // Set up page tables for long mode (identity map first 4GB)
    setup_page_tables(ram, ram_size);

    // Set up GDT
    setup_gdt(ram, ram_size);

    // Set up boot params (zero page)
    setup_boot_params(ram, ram_size, ram_size);

    // Initialize CPU state for 64-bit long mode
    let cpu = &mut mach.cpu;

    // Control registers
    cpu.cr0 = CR0_PE | CR0_MP | CR0_ET | CR0_NE | CR0_WP | CR0_AM | CR0_PG;
    cpu.cr3 = PML4_ADDR;
    cpu.cr4 = CR4_PAE | CR4_PGE | CR4_OSFXSR | CR4_OSXMMEXCPT;
    cpu.efer = EFER_LME | EFER_LMA | EFER_NXE | EFER_SCE;

    // Long mode active
    cpu.long_mode = true;
    cpu.cpl = 0;  // Ring 0 (kernel mode)

    // A20 gate enabled
    cpu.a20_mask = 0xFFFFFFFFFFFFFFFF;

    // Segment registers
    // CS: selector 0x10 → GDT entry 2 (kernel code)
    cpu.segs[SEG_CS].selector = 0x10;
    cpu.segs[SEG_CS].base = 0;
    cpu.segs[SEG_CS].limit = 0xFFFFFFFF;
    cpu.segs[SEG_CS].flags = 0xA09B; // L=1 (64-bit), P=1, S=1, Type=0xB

    // DS/ES/SS: selector 0x18 → GDT entry 3 (kernel data)
    for seg in &[SEG_DS, SEG_ES, SEG_SS] {
        cpu.segs[*seg].selector = 0x18;
        cpu.segs[*seg].base = 0;
        cpu.segs[*seg].limit = 0xFFFFFFFF;
        cpu.segs[*seg].flags = 0xC093; // G=1, B=1, P=1, S=1, Type=3
    }

    // FS/GS: zeroed
    cpu.segs[SEG_FS].selector = 0;
    cpu.segs[SEG_GS].selector = 0;

    // GDT register
    cpu.gdt.base = GDT_ADDR;
    cpu.gdt.limit = 5 * 8 - 1; // 5 entries

    // IDT — initially empty (kernel will set it up)
    cpu.idt.base = 0;
    cpu.idt.limit = 0;

    // Entry point and stack
    cpu.rip = KERNEL_ENTRY;
    cpu.regs[RSP] = BOOT_PARAMS_ADDR; // Linux uses this as initial stack briefly
    cpu.regs[RSI] = BOOT_PARAMS_ADDR; // RSI points to boot_params

    // RFLAGS: IF cleared (interrupts disabled at boot)
    cpu.rflags = 0x2; // Bit 1 always set, IF=0

    // Flush TLB
    cpu.tlb.flush_all();

    // Register VirtIO PCI devices with proper BAR0, IRQ, and subsystem IDs
    // Slot 1: VirtIO console (type 3) — BAR0 at 0xC000, IRQ 10
    crate::pci::register_virtio_device(mach, 1, 3, 0xC000, 0x40, 10);
    // Slot 2: VirtIO 9p (type 9) — BAR0 at 0xC040, IRQ 11
    crate::pci::register_virtio_device(mach, 2, 9, 0xC040, 0x40, 11);

    // Set up VirtIO device state
    // Console: advertise VIRTIO_CONSOLE_F_SIZE (bit 0)
    mach.virtio_console.common.device_features = 1; // console size available
    mach.virtio_console.common.pci_slot = 1;
    mach.virtio_console.common.irq = 10;

    // 9p: advertise VIRTIO_9P_MOUNT_TAG (bit 0), set mount tag to "root"
    mach.virtio_9p.common.device_features = 1; // mount tag available
    mach.virtio_9p.common.pci_slot = 2;
    mach.virtio_9p.common.irq = 11;
    mach.virtio_9p.mount_tag[0] = b'r';
    mach.virtio_9p.mount_tag[1] = b'o';
    mach.virtio_9p.mount_tag[2] = b'o';
    mach.virtio_9p.mount_tag[3] = b't';
    mach.virtio_9p.mount_tag_len = 4;

    // Set ELCR for level-triggered VirtIO IRQs
    // IRQ 10 = slave bit 2, IRQ 11 = slave bit 3
    mach.pic_slave.elcr = 0x0C; // bits 2 and 3

    // The kernel binary should already be at KERNEL_ENTRY in RAM.
    // The JS host is responsible for:
    // 1. Calling vm_start to initialize the machine
    // 2. Calling load_kernel to load the bzImage into RAM
    // 3. Calling vm_step in a rAF/setTimeout loop for cooperative scheduling
}

/// Set up 4-level page tables for identity mapping the first 4GB.
/// Uses 2MB huge pages (PDE.PS=1) for simplicity and speed.
unsafe fn setup_page_tables(ram: *mut u8, ram_size: u32) {
    // PML4 @ PML4_ADDR (0x91000)
    let pml4 = ram.add(PML4_ADDR as usize) as *mut u64;

    // PDP @ PDP_ADDR (0x92000) for identity map (low addresses)
    let pdp = ram.add(PDP_ADDR as usize) as *mut u64;

    // Clear tables
    core::ptr::write_bytes(pml4, 0, 512);
    core::ptr::write_bytes(pdp, 0, 512);

    // PML4[0] → PDP for identity map (first 512GB)
    *pml4 = PDP_ADDR | 0x03; // Present + Writable

    // PDP entries: each maps 1GB using 2MB pages
    // We need page directory tables for 2MB pages
    // For simplicity, use 1GB huge pages if available, otherwise 2MB pages

    // Map first 4GB with 2MB huge pages via page directories
    for i in 0u64..4 {
        let pd_addr = 0x94000 + i * 0x1000; // PD tables at 0x94000-0x97000
        let pd = ram.add(pd_addr as usize) as *mut u64;
        core::ptr::write_bytes(pd, 0, 512);

        // PDP[i] → PD[i]
        *pdp.add(i as usize) = pd_addr | 0x03; // Present + Writable

        // Fill PD with 2MB huge page entries
        for j in 0u64..512 {
            let phys_addr = i * 0x40000000 + j * 0x200000; // 1GB * i + 2MB * j
            if phys_addr < ram_size as u64 {
                *pd.add(j as usize) = phys_addr | 0x83; // Present + Writable + PS (2MB page)
            }
        }
    }

    // Also map the kernel at high address 0xFFFFFFFF80000000
    // PML4[511] → PDP_HIGH for kernel space
    let pdp_high = ram.add(PDP_HIGH_ADDR as usize) as *mut u64;
    core::ptr::write_bytes(pdp_high, 0, 512);
    *pml4.add(511) = PDP_HIGH_ADDR | 0x03;

    // PDP_HIGH[510] → PD at 0x94000 (same as identity map first 1GB)
    // This maps 0xFFFFFFFF80000000 → physical 0x00000000
    *pdp_high.add(510) = 0x94000 | 0x03;

    // PDP_HIGH[511] → PD at 0x95000 (same as identity map second 1GB)
    *pdp_high.add(511) = 0x95000 | 0x03;
}

/// Set up the GDT with null, kernel code, kernel data, user code, user data.
unsafe fn setup_gdt(ram: *mut u8, _ram_size: u32) {
    let gdt = ram.add(GDT_ADDR as usize) as *mut u64;

    *gdt.add(0) = GDT_NULL;         // 0x00: Null
    *gdt.add(1) = GDT_NULL;         // 0x08: Reserved (for TSS later)
    *gdt.add(2) = GDT_KERNEL_CODE;  // 0x10: Kernel code (64-bit)
    *gdt.add(3) = GDT_KERNEL_DATA;  // 0x18: Kernel data
    *gdt.add(4) = GDT_USER_CODE;    // 0x20: User code (64-bit)
    *gdt.add(5) = GDT_USER_DATA;    // 0x28: User data
}

/// Set up the Linux boot_params structure (zero page) at 0x90000.
unsafe fn setup_boot_params(ram: *mut u8, _ram_size: u32, total_ram: u32) {
    let bp = ram.add(BOOT_PARAMS_ADDR as usize);

    // Zero the entire boot_params area (already done in vm_start_impl, but be safe)
    core::ptr::write_bytes(bp, 0, 0x1000);

    // Boot signature at offset 0x1FE (the classic 0xAA55)
    *bp.add(0x1FE) = 0x55;
    *bp.add(0x1FF) = 0xAA;

    // Boot flag at offset 0x210: bootloader present
    *bp.add(0x210) = 1;

    // Kernel type loader at offset 0x210 byte 1
    // *bp.add(0x211) = 0; // already zero

    // E820 memory map (simplified: one big region)
    // E820 entries start at offset 0x2D0 (d820_map)
    // Each entry: base(8), size(8), type(4) = 20 bytes
    let e820 = bp.add(0x2D0);

    // Entry 0: usable memory from 0 to 0x9F000 (conventional)
    write_u64(e820, 0);            // base
    write_u64(e820.add(8), 0x9F000); // size
    write_u32(e820.add(16), 1);    // type: usable

    // Entry 1: usable memory from 0x100000 to end of RAM
    let e820_1 = e820.add(20);
    write_u64(e820_1, 0x100000);                         // base
    write_u64(e820_1.add(8), (total_ram as u64) - 0x100000); // size
    write_u32(e820_1.add(16), 1);                        // type: usable

    // E820 entry count at offset 0x1E8
    *bp.add(0x1E8) = 2;

    // Extended memory size (above 1MB, in KB) at offset 0x1E0
    let ext_mem_kb = ((total_ram - 0x100000) / 1024) as u32;
    write_u32(bp.add(0x1E0), ext_mem_kb);

    // Command line pointer at offset 0x228 (32-bit physical address)
    write_u32(bp.add(0x228), CMDLINE_ADDR as u32);

    // Write default command line
    let cmdline = b"loglevel=3 console=hvc0 root=root rootfstype=9p rootflags=trans=virtio ro\0";
    let cmdline_dst = ram.add(CMDLINE_ADDR as usize);
    core::ptr::copy_nonoverlapping(cmdline.as_ptr(), cmdline_dst, cmdline.len());

    // Command line size at offset 0x238
    write_u32(bp.add(0x238), cmdline.len() as u32);
}

/// Load a bzImage kernel into RAM at KERNEL_ENTRY.
/// Returns true on success.
/// The kernel data is expected to be accessible at `kernel_ptr` in WASM linear memory.
pub unsafe fn load_kernel(ram: *mut u8, ram_size: u32, kernel_ptr: *const u8, kernel_size: u32) -> bool {
    if kernel_size < 0x1000 {
        return false; // Too small
    }

    // Validate boot signature (0xAA55 at offset 0x1FE)
    let sig = ((*kernel_ptr.add(BZIMAGE_BOOT_SIG)) as u16)
        | (((*kernel_ptr.add(BZIMAGE_BOOT_SIG + 1)) as u16) << 8);
    if sig != 0xAA55 {
        return false;
    }

    // Validate bzImage header ("HdrS" at offset 0x202)
    let hdr = ((*kernel_ptr.add(BZIMAGE_HEADER_SIG)) as u32)
        | (((*kernel_ptr.add(BZIMAGE_HEADER_SIG + 1)) as u32) << 8)
        | (((*kernel_ptr.add(BZIMAGE_HEADER_SIG + 2)) as u32) << 16)
        | (((*kernel_ptr.add(BZIMAGE_HEADER_SIG + 3)) as u32) << 24);
    if hdr != 0x53726448 {
        return false;
    }

    // Get setup sectors count
    let mut setup_sects = *kernel_ptr.add(BZIMAGE_SETUP_SECTS) as u32;
    if setup_sects == 0 {
        setup_sects = 4; // Default
    }
    let setup_size = (setup_sects + 1) * 512;

    if setup_size >= kernel_size {
        return false; // Malformed
    }

    let kernel_code_size = kernel_size - setup_size;

    // Copy setup header fields to boot params (offset 0x1F1+)
    // The setup header starts at 0x1F1 in the bzImage
    let setup_hdr_size = core::cmp::min(setup_size - 0x1F1, 0x1000 - 0x1F1);
    let bp = ram.add(BOOT_PARAMS_ADDR as usize);
    core::ptr::copy_nonoverlapping(
        kernel_ptr.add(0x1F1),
        bp.add(0x1F1),
        setup_hdr_size as usize,
    );

    // Copy kernel code to 0x100000
    let dest = ram.add(KERNEL_ENTRY as usize);
    if KERNEL_ENTRY as u32 + kernel_code_size > ram_size {
        return false; // Won't fit
    }
    core::ptr::copy_nonoverlapping(
        kernel_ptr.add(setup_size as usize),
        dest,
        kernel_code_size as usize,
    );

    true
}

// Helpers for unaligned writes to arbitrary memory locations
#[inline(always)]
unsafe fn write_u32(ptr: *mut u8, val: u32) {
    core::ptr::write_unaligned(ptr as *mut u32, val);
}

#[inline(always)]
unsafe fn write_u64(ptr: *mut u8, val: u64) {
    core::ptr::write_unaligned(ptr as *mut u64, val);
}
