// Kernel loading and boot sequence — bzImage loader, machine init, vm_start.
// Direct kernel loading: no BIOS, no UEFI, no real-mode boot.
// Matches the original TinyEMU boot state: 32-bit protected mode, no paging.
// The kernel's startup_32 at 0x100000 handles the 32→64 bit transition itself.

use crate::types::*;

// Memory layout constants (guest physical addresses)
const BOOT_PARAMS_ADDR: u64 = 0x90000;    // Linux boot_params (zero page)
const CMDLINE_ADDR: u64 = 0x90880;        // Kernel command line
const GDT_ADDR: u64 = 0x91080;            // GDT entries (matches original TinyEMU)
const KERNEL_ENTRY: u64 = 0x100000;       // Kernel code start (1MB)

// bzImage header offsets
const BZIMAGE_BOOT_SIG: usize = 0x1FE;    // 0xAA55
const BZIMAGE_HEADER_SIG: usize = 0x202;  // "HdrS" = 0x53726448
const BZIMAGE_SETUP_SECTS: usize = 0x1F1; // Setup sector count

// GDT entries — 32-bit protected mode (matches original TinyEMU)
const GDT_NULL: u64 = 0x0000000000000000;
const GDT_CODE_32: u64 = 0x00CF9B000000FFFF; // 32-bit code: G=1, D=1, L=0, DPL=0
const GDT_DATA_32: u64 = 0x00CF93000000FFFF; // 32-bit data: G=1, D=1, DPL=0

/// Main VM startup — called from the vm_start export.
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

    // Zero the first 1MB (important for boot params, GDT, etc.)
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

    // Set up GDT (32-bit protected mode, matching original TinyEMU)
    setup_gdt(ram);

    // Set up boot params (zero page) — fields at offsets < 0x1F1 only,
    // since load_kernel will overwrite the setup header area (0x1F1+)
    setup_boot_params(ram, ram_size);

    // Initialize CPU state for 32-bit protected mode (matches original TinyEMU)
    // No paging — the kernel's startup_32 sets up page tables and enables paging itself
    let cpu = &mut mach.cpu;

    // Control registers — PE only, no paging
    cpu.cr0 = CR0_PE;
    cpu.cr3 = 0;
    cpu.cr4 = 0;
    cpu.efer = 0;

    // 32-bit protected mode, not long mode
    cpu.long_mode = false;
    cpu.cpl = 0;  // Ring 0 (kernel mode)

    // A20 gate enabled
    cpu.a20_mask = 0xFFFFFFFF;

    // Segment registers — 32-bit flat model
    // CS: selector 0x10 → GDT entry 2 (32-bit code)
    cpu.segs[SEG_CS].selector = 0x10;
    cpu.segs[SEG_CS].base = 0;
    cpu.segs[SEG_CS].limit = 0xFFFFFFFF;
    cpu.segs[SEG_CS].flags = 0xC09B; // G=1, D=1, L=0, P=1, S=1, Type=0xB

    // ES/SS/DS/FS/GS: selector 0x18 → GDT entry 3 (32-bit data)
    for seg in &[SEG_ES, SEG_SS, SEG_DS, SEG_FS, SEG_GS] {
        cpu.segs[*seg].selector = 0x18;
        cpu.segs[*seg].base = 0;
        cpu.segs[*seg].limit = 0xFFFFFFFF;
        cpu.segs[*seg].flags = 0xC093; // G=1, D=1, P=1, S=1, Type=3
    }

    // GDT register
    cpu.gdt.base = GDT_ADDR;
    cpu.gdt.limit = 4 * 8 - 1; // 4 entries (null, null, code, data)

    // IDT — initially empty (kernel will set it up)
    cpu.idt.base = 0;
    cpu.idt.limit = 0;

    // Entry point and boot_params pointer (matches original TinyEMU)
    cpu.rip = KERNEL_ENTRY;
    cpu.regs[RSI] = BOOT_PARAMS_ADDR; // RSI points to boot_params

    // RFLAGS: CF set (matches original), IF cleared
    cpu.rflags = 0x3; // Bit 1 always set + CF

    // Flush TLB
    cpu.tlb.flush_all();

    // Register VirtIO PCI devices with proper BAR0, IRQ, and subsystem IDs
    // Slot 1: VirtIO console (type 3) — BAR0 at 0xC000, IRQ 10
    crate::pci::register_virtio_device(mach, 1, 3, 0xC000, 0x40, 10);
    // Slot 2: VirtIO 9p (type 9) — BAR0 at 0xC040, IRQ 11
    crate::pci::register_virtio_device(mach, 2, 9, 0xC040, 0x40, 11);

    // Set up VirtIO device state
    // Console: advertise VIRTIO_CONSOLE_F_SIZE (bit 0)
    mach.virtio_console.common.device_features = 1;
    mach.virtio_console.common.pci_slot = 1;
    mach.virtio_console.common.irq = 10;

    // 9p: advertise VIRTIO_9P_MOUNT_TAG (bit 0), set mount tag to "root"
    mach.virtio_9p.common.device_features = 1;
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
}

/// Set up the GDT with 32-bit protected mode entries (matches original TinyEMU).
/// GDT at 0x91080: null, null, 32-bit code, 32-bit data
unsafe fn setup_gdt(ram: *mut u8) {
    let gdt = ram.add(GDT_ADDR as usize) as *mut u64;

    *gdt.add(0) = GDT_NULL;     // 0x00: Null
    *gdt.add(1) = GDT_NULL;     // 0x08: Null
    *gdt.add(2) = GDT_CODE_32;  // 0x10: 32-bit kernel code
    *gdt.add(3) = GDT_DATA_32;  // 0x18: 32-bit kernel data
}

/// Set up the Linux boot_params structure (zero page) at 0x90000.
/// Only sets fields at offsets < 0x1F1 (e820, ext_mem, etc.)
/// since load_kernel will overwrite the setup header area (0x1F1+).
/// The cmdline pointer and other header fields are set in load_kernel
/// AFTER the header copy, so they don't get overwritten.
unsafe fn setup_boot_params(ram: *mut u8, total_ram: u32) {
    let bp = ram.add(BOOT_PARAMS_ADDR as usize);

    // Zero the entire boot_params + cmdline area
    core::ptr::write_bytes(bp, 0, 0x10A0);

    // E820 memory map
    // E820 entries start at offset 0x2D0 (d820_map)
    // Each entry: base(8), size(8), type(4) = 20 bytes
    let e820 = bp.add(0x2D0);

    // Entry 0: usable memory from 0 to 0x9F000 (conventional)
    write_u64(e820, 0);
    write_u64(e820.add(8), 0x9F000);
    write_u32(e820.add(16), 1);

    // Entry 1: usable memory from 0x100000 to end of RAM
    let e820_1 = e820.add(20);
    write_u64(e820_1, 0x100000);
    write_u64(e820_1.add(8), (total_ram as u64) - 0x100000);
    write_u32(e820_1.add(16), 1);

    // E820 entry count at offset 0x1E8
    *bp.add(0x1E8) = 2;

    // Extended memory size (above 1MB, in KB) at offset 0x1E0
    let ext_mem_kb = ((total_ram - 0x100000) / 1024) as u32;
    write_u32(bp.add(0x1E0), ext_mem_kb);

    // Write default command line at 0x90880
    let cmdline = b"loglevel=3 console=hvc0 root=root rootfstype=9p rootflags=trans=virtio ro\0";
    let cmdline_dst = ram.add(CMDLINE_ADDR as usize);
    core::ptr::copy_nonoverlapping(cmdline.as_ptr(), cmdline_dst, cmdline.len());
}

/// Load a bzImage kernel into RAM at KERNEL_ENTRY.
/// Returns true on success.
pub unsafe fn load_kernel(ram: *mut u8, ram_size: u32, kernel_ptr: *const u8, kernel_size: u32) -> bool {
    if kernel_size < 0x1000 {
        return false;
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
        setup_sects = 4;
    }
    let setup_size = (setup_sects + 1) * 512;

    if setup_size >= kernel_size {
        return false;
    }

    let kernel_code_size = kernel_size - setup_size;

    // Copy kernel code to 0x100000
    let dest = ram.add(KERNEL_ENTRY as usize);
    if KERNEL_ENTRY as u32 + kernel_code_size > ram_size {
        return false;
    }
    core::ptr::copy_nonoverlapping(
        kernel_ptr.add(setup_size as usize),
        dest,
        kernel_code_size as usize,
    );

    // Copy setup header fields to boot params (offset 0x1F1+)
    let setup_hdr_size = core::cmp::min(setup_size - 0x1F1, 0x1000 - 0x1F1);
    let bp = ram.add(BOOT_PARAMS_ADDR as usize);
    core::ptr::copy_nonoverlapping(
        kernel_ptr.add(0x1F1),
        bp.add(0x1F1),
        setup_hdr_size as usize,
    );

    // Re-set fields that the header copy overwrote (matching original TinyEMU)
    // Command line pointer at offset 0x228
    write_u32(bp.add(0x228), CMDLINE_ADDR as u32);
    // Type of loader at offset 0x210 (0xFF = undefined bootloader)
    *bp.add(0x210) = 0xFF;
    // Loadflags at offset 0x211: keep LOADED_HIGH from bzImage, add CAN_USE_HEAP
    *bp.add(0x211) = *bp.add(0x211) | 0x80; // set CAN_USE_HEAP bit
    // Heap end pointer at offset 0x224
    write_u16(bp.add(0x224), 0xFE00);

    true
}

// Helpers for unaligned writes to arbitrary memory locations
#[inline(always)]
unsafe fn write_u16(ptr: *mut u8, val: u16) {
    core::ptr::write_unaligned(ptr as *mut u16, val);
}

#[inline(always)]
unsafe fn write_u32(ptr: *mut u8, val: u32) {
    core::ptr::write_unaligned(ptr as *mut u32, val);
}

#[inline(always)]
unsafe fn write_u64(ptr: *mut u8, val: u64) {
    core::ptr::write_unaligned(ptr as *mut u64, val);
}
