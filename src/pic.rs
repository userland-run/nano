// 8259 PIC (Programmable Interrupt Controller) — dual master/slave
// Also serves as the I/O port dispatch hub for all devices.
//
// Master: ports 0x20-0x21, IRQ 0-7, vectors at irq_base (typically 0x20)
// Slave:  ports 0xA0-0xA1, IRQ 8-15, vectors at irq_base (typically 0x28)
// Slave is cascaded on master's IRQ 2.

use crate::types::*;

/// Top-level I/O port read dispatcher
pub unsafe fn io_read(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, port: u16, size: u8) -> u32 {
    match port {
        // PIC master
        0x20 => pic_read(&get_machine().pic_master, 0),
        0x21 => pic_read(&get_machine().pic_master, 1),
        // PIC slave
        0xA0 => pic_read(&get_machine().pic_slave, 0),
        0xA1 => pic_read(&get_machine().pic_slave, 1),
        // PIT
        0x40..=0x43 => crate::pit::io_read(cpu, port, size),
        // UART (COM1)
        0x3F8..=0x3FF => crate::uart::io_read(cpu, ram, ram_size, port, size),
        // PCI
        0xCF8..=0xCFF => crate::pci::io_read(cpu, ram, ram_size, port, size),
        // VirtIO console (BAR0 at 0xC000)
        0xC000..=0xC03F => crate::virtio::io_read(crate::virtio::VIRTIO_DEV_CONSOLE, port - 0xC000, size),
        // VirtIO 9p (BAR0 at 0xC040)
        0xC040..=0xC07F => crate::virtio::io_read(crate::virtio::VIRTIO_DEV_9P, port - 0xC040, size),
        // CMOS/RTC
        0x70..=0x71 => 0,
        // DMA
        0x00..=0x0F | 0xC0..=0xDF | 0x80..=0x8F => 0,
        // Keyboard controller (8042)
        0x60 | 0x64 => 0,
        // VGA
        0x3C0..=0x3DA => 0,
        // ELCR
        0x4D0 => get_machine().pic_master.elcr as u32,
        0x4D1 => get_machine().pic_slave.elcr as u32,
        _ => 0xFF,
    }
}

/// Top-level I/O port write dispatcher
pub unsafe fn io_write(cpu: &mut Cpu, ram: *mut u8, ram_size: u32, port: u16, val: u32, size: u8) {
    match port {
        // PIC master
        0x20 => pic_write_port(&mut get_machine().pic_master, 0, val as u8),
        0x21 => pic_write_port(&mut get_machine().pic_master, 1, val as u8),
        // PIC slave
        0xA0 => pic_write_port(&mut get_machine().pic_slave, 0, val as u8),
        0xA1 => pic_write_port(&mut get_machine().pic_slave, 1, val as u8),
        // PIT
        0x40..=0x43 => crate::pit::io_write(cpu, port, val, size),
        // UART (COM1)
        0x3F8..=0x3FF => crate::uart::io_write(cpu, ram, ram_size, port, val, size),
        // PCI
        0xCF8..=0xCFF => crate::pci::io_write(cpu, ram, ram_size, port, val, size),
        // VirtIO console (BAR0 at 0xC000)
        0xC000..=0xC03F => crate::virtio::io_write(crate::virtio::VIRTIO_DEV_CONSOLE, port - 0xC000, val, size),
        // VirtIO 9p (BAR0 at 0xC040)
        0xC040..=0xC07F => crate::virtio::io_write(crate::virtio::VIRTIO_DEV_9P, port - 0xC040, val, size),
        // CMOS/RTC
        0x70..=0x71 => {}
        // DMA
        0x00..=0x0F | 0xC0..=0xDF | 0x80..=0x8F => {}
        // Keyboard controller
        0x60 | 0x64 => {}
        // VGA
        0x3C0..=0x3DA => {}
        // ELCR
        0x4D0 => get_machine().pic_master.elcr = val as u8,
        0x4D1 => get_machine().pic_slave.elcr = val as u8,
        _ => {}
    }
}

unsafe fn get_machine() -> &'static mut Machine {
    &mut *(crate::exports::get_machine())
}

// ============================================================
// PIC implementation — 8259 ICW/OCW state machine
// ============================================================

/// Read from a PIC (offset 0 = port 0x20/0xA0, offset 1 = port 0x21/0xA1)
unsafe fn pic_read(pic: &PicState, offset: u8) -> u32 {
    match offset {
        0 => {
            // Read IRR or ISR depending on OCW3 setting
            if pic.read_isr { pic.isr as u32 } else { pic.irr as u32 }
        }
        1 => {
            // Read IMR
            pic.imr as u32
        }
        _ => 0,
    }
}

/// Write to a PIC (offset 0 = command port, offset 1 = data port)
unsafe fn pic_write_port(pic: &mut PicState, offset: u8, val: u8) {
    if offset == 0 {
        // Command port (0x20 / 0xA0)
        if val & 0x10 != 0 {
            // ICW1: begin initialization sequence
            pic.icw[0] = val;
            pic.icw_idx = 1;
            pic.init = true;
            pic.imr = 0;
            pic.isr = 0;
            pic.irr = 0;
            pic.auto_eoi = false;
            pic.rotate_on_auto_eoi = false;
            pic.special_fully_nested = false;
            pic.special_mask = false;
            pic.read_isr = false;
        } else if val & 0x08 != 0 {
            // OCW3
            if val & 0x02 != 0 {
                pic.read_isr = val & 0x01 != 0;
            }
            if val & 0x40 != 0 {
                pic.special_mask = val & 0x20 != 0;
            }
        } else {
            // OCW2 — EOI commands
            let op = (val >> 5) & 7;
            match op {
                1 => {
                    // Non-specific EOI: clear highest priority ISR bit
                    let isr = pic.isr;
                    if isr != 0 {
                        pic.isr &= !(1 << isr.trailing_zeros());
                    }
                }
                3 => {
                    // Specific EOI: clear specified IRQ
                    let irq = val & 7;
                    pic.isr &= !(1 << irq);
                }
                5 => {
                    // Rotate on non-specific EOI
                    let isr = pic.isr;
                    if isr != 0 {
                        let bit = isr.trailing_zeros();
                        pic.isr &= !(1 << bit);
                    }
                }
                _ => {
                    // Other EOI variants (rotate, set priority) — simplified
                }
            }
        }
    } else {
        // Data port (0x21 / 0xA1)
        if pic.init {
            // In initialization sequence — accept ICW2/3/4
            match pic.icw_idx {
                1 => {
                    // ICW2: vector base (upper 5 bits)
                    pic.irq_base = val & 0xF8;
                    pic.icw[1] = val;
                    pic.icw_idx = 2;
                }
                2 => {
                    // ICW3: cascade configuration
                    pic.icw[2] = val;
                    if pic.icw[0] & 0x01 != 0 {
                        // ICW4 will follow
                        pic.icw_idx = 3;
                    } else {
                        pic.init = false;
                    }
                }
                3 => {
                    // ICW4: mode configuration
                    pic.icw[3] = val;
                    pic.auto_eoi = val & 0x02 != 0;
                    pic.special_fully_nested = val & 0x10 != 0;
                    pic.init = false;
                }
                _ => {
                    pic.init = false;
                }
            }
        } else {
            // OCW1: write IMR
            pic.imr = val;
        }
    }
}

/// Set an IRQ line (called by devices).
/// For IRQ 0-7: master PIC. For IRQ 8-15: slave PIC (mapped through master IRQ 2).
///
/// Edge vs level triggering (controlled by ELCR):
///   Edge-triggered (ELCR bit=0, default): IRR latches on rising edge, stays set
///   until CPU acknowledges via ack_irq. Deasserting the line is a no-op.
///   Level-triggered (ELCR bit=1): IRR reflects the line level directly.
pub unsafe fn set_irq(_cpu: &mut Cpu, irq: u8, level: bool) {
    let mach = get_machine();
    if irq < 8 {
        let mask = 1u8 << irq;
        if level {
            mach.pic_master.irr |= mask;
        } else if mach.pic_master.elcr & mask != 0 {
            // Level-triggered: clear IRR when line goes low
            mach.pic_master.irr &= !mask;
        }
        // Edge-triggered: IRR stays latched (cleared only by ack_irq)
    } else if irq < 16 {
        let slave_irq = irq - 8;
        let mask = 1u8 << slave_irq;
        if level {
            mach.pic_slave.irr |= mask;
            // Cascade: slave asserts master IRQ 2
            mach.pic_master.irr |= 1 << 2;
        } else if mach.pic_slave.elcr & mask != 0 {
            // Level-triggered: clear IRR when line goes low
            mach.pic_slave.irr &= !mask;
            // If no slave IRQs pending, de-assert cascade
            if mach.pic_slave.irr & !mach.pic_slave.imr == 0 {
                mach.pic_master.irr &= !(1 << 2);
            }
        }
        // Edge-triggered: IRR stays latched
    }
}

/// Get the highest priority pending interrupt vector.
/// Returns None if no unmasked, un-serviced interrupt is pending.
pub unsafe fn get_pending_irq(_cpu: &Cpu) -> Option<u8> {
    let mach = get_machine();
    // Check master PIC
    let pending = mach.pic_master.irr & !mach.pic_master.imr & !mach.pic_master.isr;
    if pending == 0 {
        return None;
    }
    let irq = pending.trailing_zeros() as u8;

    if irq == 2 {
        // Cascade — check slave PIC
        let slave_pending = mach.pic_slave.irr & !mach.pic_slave.imr & !mach.pic_slave.isr;
        if slave_pending == 0 {
            return None;
        }
        let slave_irq = slave_pending.trailing_zeros() as u8;
        Some(mach.pic_slave.irq_base + slave_irq)
    } else {
        Some(mach.pic_master.irq_base + irq)
    }
}

/// Acknowledge an IRQ: set ISR bit, clear IRR bit.
/// Called when the CPU accepts the interrupt.
pub unsafe fn ack_irq(_cpu: &mut Cpu, vector: u8) {
    let mach = get_machine();

    // Determine if this is a master or slave IRQ
    let master_base = mach.pic_master.irq_base;
    let slave_base = mach.pic_slave.irq_base;

    if vector >= slave_base && vector < slave_base + 8 {
        // Slave PIC IRQ
        let irq = vector - slave_base;
        mach.pic_slave.irr &= !(1 << irq);
        if !mach.pic_slave.auto_eoi {
            mach.pic_slave.isr |= 1 << irq;
        }
        // Also acknowledge cascade on master (IRQ 2)
        mach.pic_master.irr &= !(1 << 2);
        if !mach.pic_master.auto_eoi {
            mach.pic_master.isr |= 1 << 2;
        }
    } else if vector >= master_base && vector < master_base + 8 {
        // Master PIC IRQ
        let irq = vector - master_base;
        mach.pic_master.irr &= !(1 << irq);
        if !mach.pic_master.auto_eoi {
            mach.pic_master.isr |= 1 << irq;
        }
    }
}

/// Check if any interrupt is pending (quick check for CPU loop).
pub unsafe fn has_pending_irq() -> bool {
    let mach = get_machine();
    let pending = mach.pic_master.irr & !mach.pic_master.imr & !mach.pic_master.isr;
    pending != 0
}
