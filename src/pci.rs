// PCI Configuration Space — address port 0xCF8, data port 0xCFC
// Includes BAR size probing support for VirtIO device discovery.

use crate::types::*;

pub unsafe fn io_read(_cpu: &mut Cpu, _ram: *mut u8, _ram_size: u32, port: u16, size: u8) -> u32 {
    let mach = &mut *(crate::exports::get_machine());

    match port {
        0xCF8 => mach.pci_addr,
        0xCFC..=0xCFF => {
            if mach.pci_addr & 0x80000000 == 0 {
                return 0xFFFFFFFF;
            }
            let bus = (mach.pci_addr >> 16) & 0xFF;
            let dev = (mach.pci_addr >> 11) & 0x1F;
            let func = (mach.pci_addr >> 8) & 0x7;
            let reg = (mach.pci_addr & 0xFC) + (port - 0xCFC) as u32;

            if bus != 0 || func != 0 || (dev as usize) >= PCI_MAX_DEVICES {
                return 0xFFFFFFFF;
            }

            let pci_dev = &mach.pci_devices[dev as usize];
            if !pci_dev.active {
                return 0xFFFFFFFF;
            }

            if reg + (size as u32) <= 256 {
                let mut val = 0u32;
                for i in 0..size as usize {
                    val |= (pci_dev.config[(reg as usize) + i] as u32) << (i * 8);
                }
                val
            } else {
                0xFFFFFFFF
            }
        }
        _ => 0xFFFFFFFF,
    }
}

pub unsafe fn io_write(_cpu: &mut Cpu, _ram: *mut u8, _ram_size: u32, port: u16, val: u32, size: u8) {
    let mach = &mut *(crate::exports::get_machine());

    match port {
        0xCF8 => {
            mach.pci_addr = val;
        }
        0xCFC..=0xCFF => {
            if mach.pci_addr & 0x80000000 == 0 {
                return;
            }
            let bus = (mach.pci_addr >> 16) & 0xFF;
            let dev = (mach.pci_addr >> 11) & 0x1F;
            let func = (mach.pci_addr >> 8) & 0x7;
            let reg = (mach.pci_addr & 0xFC) + (port - 0xCFC) as u32;

            if bus != 0 || func != 0 || (dev as usize) >= PCI_MAX_DEVICES {
                return;
            }

            let pci_dev = &mut mach.pci_devices[dev as usize];
            if !pci_dev.active {
                return;
            }

            if reg + (size as u32) <= 256 {
                for i in 0..size as usize {
                    let offset = (reg as usize) + i;
                    match offset {
                        0x00..=0x03 => {} // Vendor/Device ID — read only
                        _ => {
                            pci_dev.config[offset] = (val >> (i * 8)) as u8;
                        }
                    }
                }

                // BAR registers (0x10-0x27): apply size mask after write
                // This enables the kernel's BAR size probing (write 0xFFFFFFFF, read back mask)
                let reg_start = reg as usize;
                let reg_end = reg_start + size as usize;
                for bar_idx in 0..6usize {
                    let bar_offset = 0x10 + bar_idx * 4;
                    if reg_start <= bar_offset && reg_end > bar_offset && pci_dev.bar_size[bar_idx] > 0 {
                        let bsz = pci_dev.bar_size[bar_idx];
                        let mut bar_val = u32::from_le_bytes([
                            pci_dev.config[bar_offset],
                            pci_dev.config[bar_offset + 1],
                            pci_dev.config[bar_offset + 2],
                            pci_dev.config[bar_offset + 3],
                        ]);
                        // I/O BAR: bit 0 hardwired to 1, address bits masked by size
                        let mask = !(bsz - 1);
                        bar_val = (bar_val & mask) | 0x01; // I/O space indicator
                        pci_dev.config[bar_offset] = bar_val as u8;
                        pci_dev.config[bar_offset + 1] = (bar_val >> 8) as u8;
                        pci_dev.config[bar_offset + 2] = (bar_val >> 16) as u8;
                        pci_dev.config[bar_offset + 3] = (bar_val >> 24) as u8;
                    }
                }
            }
        }
        _ => {}
    }
}

/// Register a basic PCI device at a given slot.
pub unsafe fn register_device(mach: &mut Machine, slot: usize, vendor: u16, device: u16, class: u32) {
    if slot >= PCI_MAX_DEVICES {
        return;
    }
    let dev = &mut mach.pci_devices[slot];
    dev.active = true;
    // Vendor ID (0x00)
    dev.config[0] = vendor as u8;
    dev.config[1] = (vendor >> 8) as u8;
    // Device ID (0x02)
    dev.config[2] = device as u8;
    dev.config[3] = (device >> 8) as u8;
    // Class code (0x09-0x0B)
    dev.config[9] = (class >> 8) as u8;
    dev.config[10] = (class >> 16) as u8;
    dev.config[11] = (class >> 24) as u8;
}

/// Register a VirtIO PCI device with full config (BAR0, IRQ, subsystem IDs).
pub unsafe fn register_virtio_device(
    mach: &mut Machine,
    slot: usize,
    device_type: u16,
    io_base: u16,
    io_size: u16,
    irq: u8,
) {
    if slot >= PCI_MAX_DEVICES {
        return;
    }
    let dev = &mut mach.pci_devices[slot];
    dev.active = true;

    // Vendor ID (0x00): Red Hat
    dev.config[0] = 0xF4;
    dev.config[1] = 0x1A;
    // Device ID (0x02): 0x1000 + device_type (transitional)
    let dev_id = 0x1000 + device_type;
    dev.config[2] = dev_id as u8;
    dev.config[3] = (dev_id >> 8) as u8;
    // Command (0x04): I/O space enable + bus master
    dev.config[4] = 0x07;
    dev.config[5] = 0x00;
    // Status (0x06): no capabilities for legacy
    dev.config[6] = 0x00;
    dev.config[7] = 0x00;
    // Revision (0x08): 0 for transitional
    dev.config[8] = 0;
    // Class code: depends on device type
    let class_code: u32 = match device_type {
        1 => 0x02000000,   // Network controller
        2 => 0x01800000,   // Mass storage
        3 => 0x07800000,   // Communication controller (console)
        9 => 0x00020000,   // 9p filesystem
        _ => 0x00FF0000,   // Other
    };
    dev.config[9] = (class_code >> 8) as u8;
    dev.config[10] = (class_code >> 16) as u8;
    dev.config[11] = (class_code >> 24) as u8;
    // Header type (0x0E): 0 (normal)
    dev.config[0x0E] = 0x00;
    // BAR0 (0x10): I/O port base | 0x01 (I/O space indicator)
    let bar0 = (io_base as u32) | 0x01;
    dev.config[0x10] = bar0 as u8;
    dev.config[0x11] = (bar0 >> 8) as u8;
    dev.config[0x12] = (bar0 >> 16) as u8;
    dev.config[0x13] = (bar0 >> 24) as u8;
    dev.bar_size[0] = io_size as u32;
    // Subsystem vendor ID (0x2C): Red Hat
    dev.config[0x2C] = 0xF4;
    dev.config[0x2D] = 0x1A;
    // Subsystem device ID (0x2E): device type
    dev.config[0x2E] = device_type as u8;
    dev.config[0x2F] = (device_type >> 8) as u8;
    // Interrupt line (0x3C)
    dev.config[0x3C] = irq;
    // Interrupt pin (0x3D): INTA# = 1
    dev.config[0x3D] = 0x01;
}
