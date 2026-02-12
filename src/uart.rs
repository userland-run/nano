// 16550 UART (Serial Console) — COM1 at ports 0x3F8-0x3FF
// This is the primary console output path: kernel writes here, we call console_write.

use crate::types::*;
use crate::host;

pub unsafe fn io_read(_cpu: &mut Cpu, _ram: *mut u8, _ram_size: u32, port: u16, _size: u8) -> u32 {
    let mach = &mut *(crate::exports::get_machine());
    let offset = port - 0x3F8;
    let uart = &mut mach.uart;

    if uart.lcr & 0x80 != 0 && offset <= 1 {
        // DLAB set — divisor latch access
        return match offset {
            0 => uart.dll as u32,
            1 => uart.dlh as u32,
            _ => 0,
        };
    }

    match offset {
        0 => {
            // RBR — receive buffer register
            let ch = mach.console_fifo.pop().unwrap_or(0);
            // Update LSR: clear data ready if FIFO empty
            if mach.console_fifo.is_empty() {
                uart.lsr &= !0x01;
            }
            ch as u32
        }
        1 => uart.ier as u32,       // IER
        2 => uart.iir as u32,       // IIR
        3 => uart.lcr as u32,       // LCR
        4 => uart.mcr as u32,       // MCR
        5 => {
            // LSR — line status register
            let mut lsr = uart.lsr;
            // Data ready if FIFO has data
            if !mach.console_fifo.is_empty() {
                lsr |= 0x01;
            }
            // THR empty + transmitter idle always set (we write instantly)
            lsr |= 0x60;
            lsr as u32
        }
        6 => uart.msr as u32,       // MSR
        7 => uart.scr as u32,       // SCR
        _ => 0,
    }
}

pub unsafe fn io_write(_cpu: &mut Cpu, _ram: *mut u8, _ram_size: u32, port: u16, val: u32, _size: u8) {
    let mach = &mut *(crate::exports::get_machine());
    let offset = port - 0x3F8;
    let uart = &mut mach.uart;
    let v = val as u8;

    if uart.lcr & 0x80 != 0 && offset <= 1 {
        // DLAB set — divisor latch access
        match offset {
            0 => uart.dll = v,
            1 => uart.dlh = v,
            _ => {}
        }
        return;
    }

    match offset {
        0 => {
            // THR — transmit holding register
            // Send character to host console
            let buf = [v];
            let buf_ptr = buf.as_ptr() as u32;
            host::console_write(0, buf_ptr, 1);
        }
        1 => uart.ier = v,     // IER
        2 => uart.fcr = v,     // FCR
        3 => uart.lcr = v,     // LCR
        4 => uart.mcr = v,     // MCR
        7 => uart.scr = v,     // SCR
        _ => {}
    }
}

/// Called when a character is received from the host (keyboard input).
pub unsafe fn on_char_received(mach: &mut Machine) {
    // Set LSR data ready bit
    mach.uart.lsr |= 0x01;
    // Trigger UART IRQ (IRQ 4) if receive data interrupt is enabled
    if mach.uart.ier & 0x01 != 0 {
        crate::pic::set_irq(&mut mach.cpu, 4, true);
        crate::pic::set_irq(&mut mach.cpu, 4, false);
    }
}
