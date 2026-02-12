// VirtIO console device (type 3) — console=hvc0
// Queue 0: RX (host → guest) — device writes received characters here
// Queue 1: TX (guest → host) — device reads characters to send here
//
// When the guest writes to hvc0, data goes into TX queue descriptors.
// On queue_notify(1), we read those descriptors and call console_write.
// When the host receives keyboard input, we write into RX queue descriptors.

use crate::types::*;
use crate::host;
use crate::virtio;

// VirtIO console feature bits
const VIRTIO_CONSOLE_F_SIZE: u64 = 1 << 0;      // Console size (cols/rows) in config
const VIRTIO_CONSOLE_F_MULTIPORT: u64 = 1 << 1;  // Multiple ports
const VIRTIO_CONSOLE_F_EMERG_WRITE: u64 = 1 << 2; // Emergency write

// Descriptor flags
const VIRTQ_DESC_F_NEXT: u16 = 1;
const VIRTQ_DESC_F_WRITE: u16 = 2; // Device writes (RX buffer from guest)

/// Read VirtIO console device-specific config.
/// Offset 0x00: cols (u16), 0x02: rows (u16), 0x04: max_nr_ports (u32), 0x08: emerg_wr (u32)
pub unsafe fn config_read(offset: u16, _size: u8) -> u32 {
    match offset {
        0 => 80,    // cols
        2 => 25,    // rows
        4 => 1,     // max_nr_ports
        _ => 0,
    }
}

/// Write VirtIO console device-specific config (mostly ignored).
pub unsafe fn config_write(_offset: u16, _val: u32, _size: u8) {
    // Console config is read-only from guest perspective
}

/// Handle queue notification from the guest driver.
pub unsafe fn queue_notify(queue_idx: u16) {
    match queue_idx {
        0 => {
            // RX queue: guest has posted receive buffers.
            // Nothing to do right now — we'll fill them when we have input.
        }
        1 => {
            // TX queue: guest has data to send to the host console.
            process_tx_queue();
        }
        _ => {}
    }
}

/// Process the TX queue — read guest data and send to host console.
unsafe fn process_tx_queue() {
    let mach = &mut *crate::exports::get_machine();
    let ram = mach.ram;
    let ram_size = mach.ram_size;
    let vq = &mut mach.virtio_console.queues[1];

    if !vq.ready {
        return;
    }

    let mut processed = false;

    while let Some(desc_idx) = virtio::virtq_get_avail(ram, ram_size, vq) {
        let mut idx = desc_idx;
        let mut total_len = 0u32;

        // Walk the descriptor chain
        loop {
            let desc = virtio::virtq_read_desc(ram, ram_size, vq.desc_addr, idx);

            // TX descriptor should be device-readable (not WRITE flag)
            if desc.flags & VIRTQ_DESC_F_WRITE == 0 {
                let buf_addr = desc.addr;
                let buf_len = desc.len;
                if buf_addr + buf_len as u64 <= ram_size as u64 {
                    let ptr = (ram as usize + buf_addr as usize) as u32;
                    host::console_write(0, ptr, buf_len);
                }
                total_len += buf_len;
            }

            if desc.flags & VIRTQ_DESC_F_NEXT != 0 {
                idx = desc.next;
            } else {
                break;
            }
        }

        // Add to used ring
        virtio::virtq_put_used(ram, ram_size, vq, desc_idx, total_len);
        processed = true;
    }

    if processed {
        // Raise interrupt to notify guest that TX is complete
        virtio::raise_irq(virtio::VIRTIO_DEV_CONSOLE);
    }
}

/// Inject a received character into the VirtIO console RX queue.
/// Called when the host has keyboard input for the guest.
pub unsafe fn recv_char(mach: &mut Machine, ch: u8) {
    let vq = &mut mach.virtio_console.queues[0]; // RX queue
    if !vq.ready {
        return;
    }

    let ram = mach.ram;
    let ram_size = mach.ram_size;

    // Get an available RX buffer descriptor from the guest
    if let Some(desc_idx) = virtio::virtq_get_avail(ram, ram_size, vq) {
        let desc = virtio::virtq_read_desc(ram, ram_size, vq.desc_addr, desc_idx);

        // RX descriptor should be device-writable (WRITE flag set)
        if desc.flags & VIRTQ_DESC_F_WRITE != 0 && desc.len >= 1 {
            if desc.addr < ram_size as u64 {
                // Write the character into the descriptor buffer
                *((ram as usize + desc.addr as usize) as *mut u8) = ch;
            }

            // Add to used ring with length 1
            virtio::virtq_put_used(ram, ram_size, vq, desc_idx, 1);

            // Raise interrupt to notify guest of received data
            mach.virtio_console.common.isr |= 1;
            crate::pic::set_irq(&mut mach.cpu, mach.virtio_console.common.irq, true);
        }
    }
    // If no RX buffers available, character is dropped.
    // This is normal early in boot before the driver is initialized.
}
