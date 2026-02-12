// VirtIO common infrastructure — virtqueue management and PCI legacy transport.
// The PCI legacy transport uses BAR0 I/O ports for device register access.
// Shared by all VirtIO device types (console, 9p, block, net).

use crate::types::*;
use crate::mem;

// VirtIO PCI Legacy register offsets (relative to BAR0 I/O base)
const VIRTIO_PCI_HOST_FEATURES: u16 = 0x00;   // 4 bytes, R
const VIRTIO_PCI_GUEST_FEATURES: u16 = 0x04;  // 4 bytes, RW
const VIRTIO_PCI_QUEUE_PFN: u16 = 0x08;       // 4 bytes, RW
const VIRTIO_PCI_QUEUE_NUM: u16 = 0x0C;       // 2 bytes, R
const VIRTIO_PCI_QUEUE_SEL: u16 = 0x0E;       // 2 bytes, RW
const VIRTIO_PCI_QUEUE_NOTIFY: u16 = 0x10;    // 2 bytes, RW (write triggers queue processing)
const VIRTIO_PCI_STATUS: u16 = 0x12;          // 1 byte, RW
const VIRTIO_PCI_ISR: u16 = 0x13;             // 1 byte, R (read clears)
const VIRTIO_PCI_CONFIG: u16 = 0x14;          // device-specific config starts here

// I/O port bases for VirtIO devices
pub const VIRTIO_IO_BASE_CONSOLE: u16 = 0xC000;
pub const VIRTIO_IO_BASE_9P: u16 = 0xC040;
pub const VIRTIO_IO_SIZE: u16 = 0x40;

// VirtIO device type indices (for dispatch)
pub const VIRTIO_DEV_CONSOLE: usize = 0;
pub const VIRTIO_DEV_9P: usize = 1;

// ============================================================
// Internal helpers to access device state via raw pointers
// (avoids borrow checker issues with Machine's multiple fields)
// ============================================================

unsafe fn get_common_ptr(dev_type: usize) -> *mut VirtioCommon {
    let mach = crate::exports::get_machine();
    match dev_type {
        VIRTIO_DEV_CONSOLE => &mut (*mach).virtio_console.common,
        VIRTIO_DEV_9P => &mut (*mach).virtio_9p.common,
        _ => core::ptr::null_mut(),
    }
}

unsafe fn get_queue_ptr(dev_type: usize, idx: u32) -> *mut Virtqueue {
    let mach = crate::exports::get_machine();
    match dev_type {
        VIRTIO_DEV_CONSOLE => {
            if (idx as usize) < 2 {
                &mut (*mach).virtio_console.queues[idx as usize]
            } else {
                core::ptr::null_mut()
            }
        }
        VIRTIO_DEV_9P => {
            if idx == 0 {
                &mut (*mach).virtio_9p.queues[0]
            } else {
                core::ptr::null_mut()
            }
        }
        _ => core::ptr::null_mut(),
    }
}

unsafe fn num_queues(dev_type: usize) -> u32 {
    match dev_type {
        VIRTIO_DEV_CONSOLE => 2,
        VIRTIO_DEV_9P => 1,
        _ => 0,
    }
}

// ============================================================
// VirtIO PCI Legacy I/O port handlers
// ============================================================

/// Read from VirtIO PCI legacy I/O port (offset relative to BAR0 base).
pub unsafe fn io_read(dev_type: usize, offset: u16, size: u8) -> u32 {
    let common = get_common_ptr(dev_type);
    if common.is_null() {
        return 0;
    }

    match offset {
        0x00 => (*common).device_features as u32,   // HOST_FEATURES
        0x04 => (*common).driver_features as u32,    // GUEST_FEATURES
        0x08 => {                                    // QUEUE_PFN
            let q = get_queue_ptr(dev_type, (*common).queue_sel);
            if !q.is_null() {
                ((*q).desc_addr >> 12) as u32
            } else {
                0
            }
        }
        0x0C => {                                    // QUEUE_NUM
            let q = get_queue_ptr(dev_type, (*common).queue_sel);
            if !q.is_null() {
                (*q).num
            } else {
                0
            }
        }
        0x0E => (*common).queue_sel,                 // QUEUE_SEL
        0x12 => (*common).status,                    // STATUS
        0x13 => {                                    // ISR (read clears)
            let isr = (*common).isr;
            (*common).isr = 0;
            if isr != 0 {
                let irq = (*common).irq;
                let mach = &mut *crate::exports::get_machine();
                crate::pic::set_irq(&mut mach.cpu, irq, false);
            }
            isr
        }
        _ if offset >= VIRTIO_PCI_CONFIG => {
            let config_offset = offset - VIRTIO_PCI_CONFIG;
            match dev_type {
                VIRTIO_DEV_CONSOLE => crate::virtio_console::config_read(config_offset, size),
                VIRTIO_DEV_9P => crate::virtio_9p::config_read(config_offset, size),
                _ => 0,
            }
        }
        _ => 0,
    }
}

/// Write to VirtIO PCI legacy I/O port (offset relative to BAR0 base).
pub unsafe fn io_write(dev_type: usize, offset: u16, val: u32, size: u8) {
    let common = get_common_ptr(dev_type);
    if common.is_null() {
        return;
    }

    match offset {
        0x04 => {                                    // GUEST_FEATURES
            (*common).driver_features = val as u64;
        }
        0x08 => {                                    // QUEUE_PFN
            let q = get_queue_ptr(dev_type, (*common).queue_sel);
            if !q.is_null() {
                let pfn = val as u64;
                let num = (*q).num as u64;
                if pfn != 0 {
                    let base_addr = pfn * 4096;
                    (*q).desc_addr = base_addr;
                    (*q).avail_addr = base_addr + num * 16;
                    // Used ring starts at next page-aligned boundary after available ring
                    let avail_end = (*q).avail_addr + 6 + num * 2;
                    (*q).used_addr = (avail_end + 4095) & !4095;
                    (*q).ready = true;
                } else {
                    (*q).desc_addr = 0;
                    (*q).avail_addr = 0;
                    (*q).used_addr = 0;
                    (*q).ready = false;
                }
            }
        }
        0x0E => {                                    // QUEUE_SEL
            (*common).queue_sel = val & 0xFFFF;
        }
        0x10 => {                                    // QUEUE_NOTIFY
            let queue_idx = val as u16;
            match dev_type {
                VIRTIO_DEV_CONSOLE => crate::virtio_console::queue_notify(queue_idx),
                VIRTIO_DEV_9P => crate::virtio_9p::queue_notify(queue_idx),
                _ => {}
            }
        }
        0x12 => {                                    // STATUS
            if val == 0 {
                // Device reset
                (*common).status = 0;
                (*common).driver_features = 0;
                (*common).isr = 0;
                (*common).queue_sel = 0;
                // Reset all queues
                let nq = num_queues(dev_type);
                for i in 0..nq {
                    let q = get_queue_ptr(dev_type, i);
                    if !q.is_null() {
                        (*q).desc_addr = 0;
                        (*q).avail_addr = 0;
                        (*q).used_addr = 0;
                        (*q).last_avail_idx = 0;
                        (*q).ready = false;
                    }
                }
            } else {
                (*common).status = val;
            }
        }
        _ if offset >= VIRTIO_PCI_CONFIG => {
            let config_offset = offset - VIRTIO_PCI_CONFIG;
            match dev_type {
                VIRTIO_DEV_CONSOLE => crate::virtio_console::config_write(config_offset, val, size),
                VIRTIO_DEV_9P => crate::virtio_9p::config_write(config_offset, val, size),
                _ => {}
            }
        }
        _ => {}
    }
}

/// Raise a VirtIO device interrupt (used ring update).
pub unsafe fn raise_irq(dev_type: usize) {
    let common = get_common_ptr(dev_type);
    if !common.is_null() {
        (*common).isr |= 1; // bit 0: used ring update
        let irq = (*common).irq;
        let mach = &mut *crate::exports::get_machine();
        crate::pic::set_irq(&mut mach.cpu, irq, true);
    }
}

// ============================================================
// Virtqueue utility functions
// ============================================================

/// Read a descriptor from the virtqueue descriptor table.
pub unsafe fn virtq_read_desc(
    ram: *mut u8,
    ram_size: u32,
    desc_addr: u64,
    idx: u16,
) -> VirtqDesc {
    let addr = desc_addr + (idx as u64) * 16;
    VirtqDesc {
        addr: mem::phys_read_u64(ram, ram_size, addr),
        len: mem::phys_read_u32(ram, ram_size, addr + 8),
        flags: mem::phys_read_u32(ram, ram_size, addr + 12) as u16,
        next: (mem::phys_read_u32(ram, ram_size, addr + 12) >> 16) as u16,
    }
}

/// Read the next available descriptor index.
pub unsafe fn virtq_get_avail(
    ram: *mut u8,
    ram_size: u32,
    vq: &mut Virtqueue,
) -> Option<u16> {
    let avail_idx = mem::phys_read_u32(ram, ram_size, vq.avail_addr + 2) as u16;
    if vq.last_avail_idx == avail_idx {
        return None;
    }
    let ring_idx = (vq.last_avail_idx % vq.num as u16) as u64;
    let desc_idx = mem::phys_read_u32(ram, ram_size, vq.avail_addr + 4 + ring_idx * 2) as u16;
    vq.last_avail_idx = vq.last_avail_idx.wrapping_add(1);
    Some(desc_idx)
}

/// Write a used descriptor to the used ring.
pub unsafe fn virtq_put_used(
    ram: *mut u8,
    ram_size: u32,
    vq: &Virtqueue,
    desc_idx: u16,
    len: u32,
) {
    let used_idx = mem::phys_read_u32(ram, ram_size, vq.used_addr + 2) as u16;
    let ring_idx = (used_idx % vq.num as u16) as u64;
    let entry_addr = vq.used_addr + 4 + ring_idx * 8;
    mem::phys_write_u32(ram, ram_size, entry_addr, desc_idx as u32);
    mem::phys_write_u32(ram, ram_size, entry_addr + 4, len);
    mem::phys_write_u32(ram, ram_size, vq.used_addr + 2, used_idx.wrapping_add(1) as u32);
}
