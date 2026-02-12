// 8254 PIT (Programmable Interval Timer)
// Channel 0: system timer (IRQ 0)
// Channel 1: DRAM refresh (unused)
// Channel 2: speaker (unused)
//
// PIT runs at 1.193182 MHz. The kernel programs channel 0 with a reload value;
// we track elapsed time and fire IRQ 0 when the count expires.

use crate::types::*;

const PIT_FREQ_HZ: f64 = 1193182.0;

pub unsafe fn io_read(_cpu: &Cpu, port: u16, _size: u8) -> u32 {
    let mach = &mut *(crate::exports::get_machine());
    let channel = (port - 0x40) as usize;

    if channel >= 3 {
        return 0; // port 0x43 reads are undefined
    }

    let ch = &mut mach.pit.channels[channel];

    if ch.latched {
        // Return latched value
        let val = match ch.read_state {
            0 => {
                // Low byte
                ch.read_state = 1;
                ch.latch as u8
            }
            _ => {
                // High byte
                ch.latched = false;
                ch.read_state = 0;
                (ch.latch >> 8) as u8
            }
        };
        val as u32
    } else {
        // Return current count
        let count = ch.count;
        match ch.rw_mode {
            1 => count as u8 as u32,                    // low byte only
            2 => (count >> 8) as u8 as u32,             // high byte only
            3 => {
                // Low then high
                let val = match ch.read_state {
                    0 => {
                        ch.read_state = 1;
                        count as u8
                    }
                    _ => {
                        ch.read_state = 0;
                        (count >> 8) as u8
                    }
                };
                val as u32
            }
            _ => 0,
        }
    }
}

pub unsafe fn io_write(_cpu: &mut Cpu, port: u16, val: u32, _size: u8) {
    let mach = &mut *(crate::exports::get_machine());

    if port == 0x43 {
        // Control word
        let v = val as u8;
        let channel = ((v >> 6) & 3) as usize;

        if channel == 3 {
            // Read-back command (not fully implemented)
            return;
        }

        let rw = (v >> 4) & 3;
        let mode = (v >> 1) & 7;

        if rw == 0 {
            // Counter latch command
            if channel < 3 {
                let ch = &mut mach.pit.channels[channel];
                ch.latch = ch.count;
                ch.latched = true;
                ch.read_state = 0;
            }
            return;
        }

        if channel < 3 {
            let ch = &mut mach.pit.channels[channel];
            ch.rw_mode = rw;
            ch.mode = mode;
            ch.write_state = 0;
            ch.read_state = 0;
        }
    } else {
        let channel = (port - 0x40) as usize;
        if channel >= 3 {
            return;
        }

        let ch = &mut mach.pit.channels[channel];
        let v = val as u8;

        match ch.rw_mode {
            1 => {
                // Low byte only
                ch.reload = v as u16;
                ch.count = ch.reload;
            }
            2 => {
                // High byte only
                ch.reload = (v as u16) << 8;
                ch.count = ch.reload;
            }
            3 => {
                // Low then high
                match ch.write_state {
                    0 => {
                        ch.reload = (ch.reload & 0xFF00) | v as u16;
                        ch.write_state = 1;
                    }
                    _ => {
                        ch.reload = (ch.reload & 0x00FF) | ((v as u16) << 8);
                        ch.write_state = 0;
                        // Reload takes effect now
                        ch.count = if ch.reload == 0 { 0u16 } else { ch.reload };
                    }
                }
            }
            _ => {}
        }
    }
}

/// Called periodically (at yield points) to advance PIT timers and fire IRQ 0.
/// `now_ms` is the current wall-clock time from the host (Date.now()).
pub unsafe fn tick(cpu: &mut Cpu, now_ms: f64) {
    let mach = &mut *(crate::exports::get_machine());

    if mach.pit.last_time_ms == 0.0 {
        mach.pit.last_time_ms = now_ms;
        return;
    }

    let elapsed_ms = now_ms - mach.pit.last_time_ms;
    if elapsed_ms <= 0.0 {
        return;
    }
    mach.pit.last_time_ms = now_ms;

    // Channel 0: system timer
    let ch = &mut mach.pit.channels[0];
    if ch.reload == 0 {
        return;
    }

    // How many PIT ticks elapsed?
    let ticks = (elapsed_ms * PIT_FREQ_HZ / 1000.0) as u32;
    if ticks == 0 {
        return;
    }

    let reload = if ch.reload == 0 { 0x10000u32 } else { ch.reload as u32 };

    // Check if counter would wrap (fire IRQ)
    let current = ch.count as u32;
    if ticks >= current {
        // Timer expired — fire IRQ 0
        let remaining = ticks - current;
        ch.count = (reload - (remaining % reload)) as u16;
        // Fire IRQ 0
        crate::pic::set_irq(cpu, 0, true);
        // Edge-triggered: de-assert after setting
        crate::pic::set_irq(cpu, 0, false);
    } else {
        ch.count = (current - ticks) as u16;
    }
}
