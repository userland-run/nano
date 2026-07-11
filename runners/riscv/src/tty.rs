// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

//! In-VM tty line discipline + stdin ring (Console).
//!
//! The host pushes raw input bytes (keystrokes) via `vm_stdin_push`. This module
//! applies the line discipline implied by the guest's termios — cooked mode
//! (ICANON): echo, erase, ^C/^D, line buffering; raw mode: pass bytes straight
//! through (the program, e.g. ash's line editor, echoes itself) — and exposes
//! the readable bytes to `read()` and `ppoll()`.
//!
//! Owning stdin in the VM (rather than the JS host queue) is what makes `read`
//! and `ppoll` consistent: ash's line editor `ppoll`s stdin before reading, so
//! poll must see the same availability the ring exposes to read.

use crate::host;
use crate::mem;
use crate::types::Vm;

// termios c_lflag bits
const ICANON: u32 = 0x0002;
const ECHO: u32 = 0x0008;
const ISIG: u32 = 0x0001;

const SIGINT: u32 = 2;

/// "Would block" sentinel returned by try_read/try_poll when interactive stdin
/// has no data yet — the caller parks (FS_PENDING) and retries via vm_io_retry.
pub const WAIT: i64 = -0x7000_0000;

const RING_CAP: usize = 8192;
static mut RING: [u8; RING_CAP] = [0; RING_CAP];
static mut RING_HEAD: usize = 0; // first unread byte
static mut RING_TAIL: usize = 0; // one past last byte

const LINE_CAP: usize = 4096;
static mut LINE: [u8; LINE_CAP] = [0; LINE_CAP]; // cooked line being edited
static mut LINE_LEN: usize = 0;

static mut STDIN_EOF: bool = false;
static mut INTERACTIVE: bool = false; // park-on-empty vs EOF-on-empty

static mut ECHO_BUF: [u8; 8] = [0; 8];

/// Reset all stdin state (called between program runs).
pub unsafe fn reset() {
    RING_HEAD = 0;
    RING_TAIL = 0;
    LINE_LEN = 0;
    STDIN_EOF = false;
    // INTERACTIVE is host-controlled; leave it as the host set it.
}

pub unsafe fn set_interactive(on: bool) {
    INTERACTIVE = on;
}

pub unsafe fn set_eof() {
    STDIN_EOF = true;
}

#[inline]
unsafe fn ring_avail() -> usize {
    RING_TAIL - RING_HEAD
}

unsafe fn ring_push(b: u8) {
    if RING_TAIL >= RING_CAP {
        // Compact: shift unread bytes to the front.
        let len = RING_TAIL - RING_HEAD;
        core::ptr::copy(RING.as_ptr().add(RING_HEAD), RING.as_mut_ptr(), len);
        RING_HEAD = 0;
        RING_TAIL = len;
        if RING_TAIL >= RING_CAP {
            return; // full — drop (overflow)
        }
    }
    RING[RING_TAIL] = b;
    RING_TAIL += 1;
}

/// Echo bytes back to the terminal (guest stdout, fd 1).
unsafe fn echo(bytes: &[u8]) {
    let n = bytes.len().min(ECHO_BUF.len());
    let mut i = 0;
    while i < n {
        ECHO_BUF[i] = bytes[i];
        i += 1;
    }
    host::console_write(1, ECHO_BUF.as_ptr() as i32, n as i32);
}

/// Push raw host input through the line discipline.
pub unsafe fn stdin_push(vm: &mut Vm, bytes: &[u8]) {
    let tty = vm.tty_enabled != 0;
    let cooked = tty && (vm.c_lflag & ICANON) != 0;
    let do_echo = tty && (vm.c_lflag & ECHO) != 0;
    let isig = tty && (vm.c_lflag & ISIG) != 0;
    let vintr = vm.c_cc[0];
    let verase = vm.c_cc[2];
    let veof = vm.c_cc[4];

    for &b in bytes {
        if isig && b == vintr {
            // ^C with ISIG: generate SIGINT; the byte is not passed to the program.
            crate::syscall::raise_signal(vm, SIGINT);
            LINE_LEN = 0;
            if do_echo {
                echo(b"^C\r\n");
            }
            continue;
        }
        if !cooked {
            // Raw mode: deliver immediately, no echo, no editing.
            ring_push(b);
            continue;
        }
        // Cooked mode.
        if b == veof {
            if LINE_LEN > 0 {
                let n = LINE_LEN;
                let mut i = 0;
                while i < n {
                    ring_push(LINE[i]);
                    i += 1;
                }
                LINE_LEN = 0;
            } else {
                STDIN_EOF = true;
            }
            continue;
        }
        if b == b'\r' || b == b'\n' {
            if LINE_LEN < LINE_CAP {
                LINE[LINE_LEN] = b'\n';
                LINE_LEN += 1;
            }
            if do_echo {
                echo(b"\r\n");
            }
            let n = LINE_LEN;
            let mut i = 0;
            while i < n {
                ring_push(LINE[i]);
                i += 1;
            }
            LINE_LEN = 0;
            continue;
        }
        if b == verase || b == 0x08 {
            if LINE_LEN > 0 {
                LINE_LEN -= 1;
                if do_echo {
                    echo(b"\x08 \x08");
                }
            }
            continue;
        }
        // Printable / other: buffer + echo.
        if LINE_LEN < LINE_CAP {
            LINE[LINE_LEN] = b;
            LINE_LEN += 1;
            if do_echo {
                echo(&[b]);
            }
        }
    }
}

/// Attempt a stdin read into guest `buf` (max `count` bytes). Returns the number
/// of bytes read, 0 for EOF, or `WAIT` if interactive and no data is available.
pub unsafe fn try_read(vm: &Vm, buf: u64, count: u32) -> i64 {
    let avail = ring_avail();
    if avail > 0 {
        let n = avail.min(count as usize);
        let mut i = 0;
        while i < n {
            mem::write_u8(vm.ram_base, buf + i as u64, RING[RING_HEAD]);
            RING_HEAD += 1;
            i += 1;
        }
        if RING_HEAD >= RING_TAIL {
            RING_HEAD = 0;
            RING_TAIL = 0;
        }
        return n as i64;
    }
    if STDIN_EOF {
        STDIN_EOF = false;
        return 0;
    }
    if INTERACTIVE {
        WAIT
    } else {
        0 // batch: empty stdin is EOF
    }
}

/// Is stdin readable now (for poll/select)?
pub unsafe fn pollin() -> bool {
    ring_avail() > 0 || STDIN_EOF
}

pub unsafe fn interactive() -> bool {
    INTERACTIVE
}
