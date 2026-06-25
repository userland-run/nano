// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

//! Terminal model for Console — the ANSI/`vte` parser plus the cell grid that
//! the guest's stdout byte stream is rendered into. This lives inside nano.wasm
//! (the model half of the spec's model/render split); the `terminal/` front-end
//! reads the grid out of linear memory and draws it.
//!
//! Built `no_std` with `vte` default-features disabled — OSC params use a
//! fixed-size `ArrayVec`, so no global allocator is required. The grid is a
//! single fixed-capacity static (no heap), matching nano's no-heap design.
//!
//! Phase 0 implements a fixed viewport (no scrollback ring yet): print, the C0
//! controls a shell needs (CR/LF/BS/TAB), SGR colours/attributes, cursor moves,
//! and erase. Scrollback, reflow and rich-cell fields come in later phases.

use core::ptr::{addr_of, addr_of_mut};
use vte::{Params, Parser, Perform};

// ---- cell flags (1 byte) ----
const FLAG_BOLD: u8 = 1 << 0;
const FLAG_DIM: u8 = 1 << 1;
const FLAG_ITALIC: u8 = 1 << 2;
const FLAG_UNDERLINE: u8 = 1 << 3;
const FLAG_INVERSE: u8 = 1 << 4;
const FLAG_FG_DEFAULT: u8 = 1 << 5;
const FLAG_BG_DEFAULT: u8 = 1 << 6;

/// One grid cell — 8 bytes, `#[repr(C)]` so the JS renderer can read it directly
/// from linear memory: u32 codepoint, u8 fg palette idx, u8 bg palette idx,
/// u8 flags, u8 pad. `fg`/`bg` are 0..=255 palette indices; the FG/BG_DEFAULT
/// flags tell the renderer to substitute the theme's default colour instead.
#[repr(C)]
#[derive(Clone, Copy)]
struct Cell {
    ch: u32,
    fg: u8,
    bg: u8,
    flags: u8,
    _pad: u8,
}

impl Cell {
    const BLANK: Cell = Cell {
        ch: 0x20,
        fg: 7,
        bg: 0,
        flags: FLAG_FG_DEFAULT | FLAG_BG_DEFAULT,
        _pad: 0,
    };
}

const MAX_COLS: usize = 200;
const MAX_ROWS: usize = 64;
const MAX_CELLS: usize = MAX_COLS * MAX_ROWS;

/// Scrollback ring depth (lines retained above the live viewport). Fixed-capacity
/// to honour nano's no-heap design: 1000 × MAX_COLS × 8 ≈ 1.6 MB of static.
const SCROLL_LINES: usize = 1000;

/// The terminal grid + parser state. A single static instance (`TERM`).
#[repr(C)]
struct Term {
    cols: u32,
    rows: u32,
    cur_row: u32,
    cur_col: u32,
    pen_fg: u8,
    pen_bg: u8,
    pen_flags: u8,
    _pad: u8,
    cells: [Cell; MAX_CELLS],
}

impl Term {
    const NEW: Term = Term {
        cols: 80,
        rows: 25,
        cur_row: 0,
        cur_col: 0,
        pen_fg: 7,
        pen_bg: 0,
        pen_flags: FLAG_FG_DEFAULT | FLAG_BG_DEFAULT,
        _pad: 0,
        cells: [Cell::BLANK; MAX_CELLS],
    };

    #[inline]
    fn idx(&self, r: u32, c: u32) -> usize {
        (r * self.cols + c) as usize
    }

    fn reset_pen(&mut self) {
        self.pen_fg = 7;
        self.pen_bg = 0;
        self.pen_flags = FLAG_FG_DEFAULT | FLAG_BG_DEFAULT;
    }

    /// Reset dimensions and clear the screen. Scrollback is dropped on resize —
    /// stored lines were wrapped at the old width, and reflow is a later phase.
    fn resize(&mut self, cols: u32, rows: u32) {
        self.cols = cols.clamp(1, MAX_COLS as u32);
        self.rows = rows.clamp(1, MAX_ROWS as u32);
        self.cur_row = 0;
        self.cur_col = 0;
        self.reset_pen();
        self.clear_all();
        unsafe { (*addr_of_mut!(SB)).clear(); }
    }

    fn clear_all(&mut self) {
        let n = (self.cols * self.rows) as usize;
        for cell in self.cells[..n].iter_mut() {
            *cell = Cell::BLANK;
        }
    }

    /// Scroll the viewport up by one line, clearing the new bottom row. The
    /// evicted top row is pushed into the scrollback ring so it can be scrolled
    /// back to.
    fn scroll_up(&mut self) {
        let cols = self.cols as usize;
        let rows = self.rows as usize;
        // Capture the top row into scrollback before it is overwritten.
        unsafe { (*addr_of_mut!(SB)).push(&self.cells[0..cols]); }
        for r in 0..rows - 1 {
            let (dst0, src0) = (r * cols, (r + 1) * cols);
            self.cells.copy_within(src0..src0 + cols, dst0);
        }
        let last = (rows - 1) * cols;
        for cell in self.cells[last..last + cols].iter_mut() {
            *cell = Cell::BLANK;
        }
    }

    fn newline(&mut self) {
        self.cur_row += 1;
        if self.cur_row >= self.rows {
            self.scroll_up();
            self.cur_row = self.rows - 1;
        }
    }

    fn put(&mut self, ch: u32) {
        if self.cur_col >= self.cols {
            self.cur_col = 0;
            self.newline();
        }
        let i = self.idx(self.cur_row, self.cur_col);
        self.cells[i] = Cell {
            ch,
            fg: self.pen_fg,
            bg: self.pen_bg,
            flags: self.pen_flags,
            _pad: 0,
        };
        self.cur_col += 1;
    }

    /// Select Graphic Rendition (CSI … m) — update the pen.
    fn sgr(&mut self, params: &Params) {
        // Flatten params (handles both `38;5;1` and `38:5:1` forms) into a
        // small fixed buffer; no heap.
        let mut buf = [0u16; 64];
        let mut n = 0;
        for group in params.iter() {
            for &v in group {
                if n < buf.len() {
                    buf[n] = v;
                    n += 1;
                }
            }
        }
        if n == 0 {
            buf[0] = 0;
            n = 1;
        }
        let mut i = 0;
        while i < n {
            match buf[i] {
                0 => self.reset_pen(),
                1 => self.pen_flags |= FLAG_BOLD,
                2 => self.pen_flags |= FLAG_DIM,
                3 => self.pen_flags |= FLAG_ITALIC,
                4 => self.pen_flags |= FLAG_UNDERLINE,
                7 => self.pen_flags |= FLAG_INVERSE,
                22 => self.pen_flags &= !(FLAG_BOLD | FLAG_DIM),
                23 => self.pen_flags &= !FLAG_ITALIC,
                24 => self.pen_flags &= !FLAG_UNDERLINE,
                27 => self.pen_flags &= !FLAG_INVERSE,
                c @ 30..=37 => {
                    self.pen_fg = (c - 30) as u8;
                    self.pen_flags &= !FLAG_FG_DEFAULT;
                }
                39 => {
                    self.pen_fg = 7;
                    self.pen_flags |= FLAG_FG_DEFAULT;
                }
                c @ 40..=47 => {
                    self.pen_bg = (c - 40) as u8;
                    self.pen_flags &= !FLAG_BG_DEFAULT;
                }
                49 => {
                    self.pen_bg = 0;
                    self.pen_flags |= FLAG_BG_DEFAULT;
                }
                c @ 90..=97 => {
                    self.pen_fg = (c - 90 + 8) as u8;
                    self.pen_flags &= !FLAG_FG_DEFAULT;
                }
                c @ 100..=107 => {
                    self.pen_bg = (c - 100 + 8) as u8;
                    self.pen_flags &= !FLAG_BG_DEFAULT;
                }
                code @ (38 | 48) => {
                    let is_fg = code == 38;
                    if i + 1 < n && buf[i + 1] == 5 && i + 2 < n {
                        let idx = buf[i + 2] as u8;
                        if is_fg {
                            self.pen_fg = idx;
                            self.pen_flags &= !FLAG_FG_DEFAULT;
                        } else {
                            self.pen_bg = idx;
                            self.pen_flags &= !FLAG_BG_DEFAULT;
                        }
                        i += 2;
                    } else if i + 1 < n && buf[i + 1] == 2 && i + 4 < n {
                        // Truecolor — Phase 0 keeps a palette-only renderer, so
                        // just consume r;g;b and leave the pen unchanged.
                        i += 4;
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }

    fn erase_display(&mut self, mode: u16) {
        let (cols, rows) = (self.cols, self.rows);
        match mode {
            // cursor → end of screen
            0 => {
                let start = self.idx(self.cur_row, self.cur_col);
                let end = (cols * rows) as usize;
                for cell in self.cells[start..end].iter_mut() {
                    *cell = Cell::BLANK;
                }
            }
            // start of screen → cursor
            1 => {
                let end = self.idx(self.cur_row, self.cur_col) + 1;
                for cell in self.cells[..end].iter_mut() {
                    *cell = Cell::BLANK;
                }
            }
            // whole screen
            _ => self.clear_all(),
        }
    }

    fn erase_line(&mut self, mode: u16) {
        let row_start = self.idx(self.cur_row, 0);
        let cols = self.cols as usize;
        let col = self.cur_col as usize;
        match mode {
            0 => {
                for cell in self.cells[row_start + col..row_start + cols].iter_mut() {
                    *cell = Cell::BLANK;
                }
            }
            1 => {
                for cell in self.cells[row_start..row_start + col + 1].iter_mut() {
                    *cell = Cell::BLANK;
                }
            }
            _ => {
                for cell in self.cells[row_start..row_start + cols].iter_mut() {
                    *cell = Cell::BLANK;
                }
            }
        }
    }
}

impl Perform for Term {
    fn print(&mut self, c: char) {
        self.put(c as u32);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x0A | 0x0B | 0x0C => self.newline(), // LF / VT / FF
            0x0D => self.cur_col = 0,             // CR
            0x08 => self.cur_col = self.cur_col.saturating_sub(1), // BS
            0x09 => {
                // TAB → next multiple of 8
                let next = (self.cur_col / 8 + 1) * 8;
                self.cur_col = next.min(self.cols - 1);
            }
            _ => {} // BEL and others: ignore
        }
    }

    fn csi_dispatch(&mut self, params: &Params, _intermediates: &[u8], _ignore: bool, action: char) {
        // First parameter (0 if absent), and a helper that applies a default
        // when the parameter is 0/absent.
        let p0 = params
            .iter()
            .next()
            .and_then(|s| s.first().copied())
            .unwrap_or(0);
        let arg1 = if p0 == 0 { 1 } else { p0 as u32 };
        match action {
            'm' => self.sgr(params),
            'H' | 'f' => {
                let mut it = params.iter();
                let r = it.next().and_then(|s| s.first().copied()).unwrap_or(1).max(1) as u32;
                let c = it.next().and_then(|s| s.first().copied()).unwrap_or(1).max(1) as u32;
                self.cur_row = (r - 1).min(self.rows - 1);
                self.cur_col = (c - 1).min(self.cols - 1);
            }
            'A' => self.cur_row = self.cur_row.saturating_sub(arg1),
            'B' => self.cur_row = (self.cur_row + arg1).min(self.rows - 1),
            'C' => self.cur_col = (self.cur_col + arg1).min(self.cols - 1),
            'D' => self.cur_col = self.cur_col.saturating_sub(arg1),
            'G' => self.cur_col = (arg1 - 1).min(self.cols - 1),
            'd' => self.cur_row = (arg1 - 1).min(self.rows - 1),
            'J' => self.erase_display(p0),
            'K' => self.erase_line(p0),
            _ => {}
        }
    }
}

// ============================================================
// Static instance + host-facing exports
// ============================================================

static mut TERM: Term = Term::NEW;
static mut PARSER: Option<Parser> = None;

/// Fixed-capacity scrollback ring of evicted top rows (each padded to MAX_COLS).
struct Scrollback {
    lines: [[Cell; MAX_COLS]; SCROLL_LINES],
    head: usize,  // ring index of the oldest retained line
    count: usize, // number of valid lines (<= SCROLL_LINES)
}

impl Scrollback {
    const NEW: Scrollback = Scrollback {
        lines: [[Cell::BLANK; MAX_COLS]; SCROLL_LINES],
        head: 0,
        count: 0,
    };

    fn clear(&mut self) {
        self.head = 0;
        self.count = 0;
    }

    /// Append one line (the evicted screen top row), overwriting the oldest when full.
    fn push(&mut self, row: &[Cell]) {
        let slot = if self.count == SCROLL_LINES {
            let s = self.head;
            self.head = (self.head + 1) % SCROLL_LINES;
            s
        } else {
            let s = (self.head + self.count) % SCROLL_LINES;
            self.count += 1;
            s
        };
        let line = &mut self.lines[slot];
        *line = [Cell::BLANK; MAX_COLS];
        for (i, &cell) in row.iter().enumerate().take(MAX_COLS) {
            line[i] = cell;
        }
    }

    /// The j-th retained line (0 = oldest).
    #[inline]
    fn line(&self, j: usize) -> &[Cell; MAX_COLS] {
        &self.lines[(self.head + j) % SCROLL_LINES]
    }
}

static mut SB: Scrollback = Scrollback::NEW;

/// Composed viewport buffer, filled by `term_compose` for the renderer to read.
/// Separate from the live `TERM.cells` so scrolling back never disturbs the grid.
static mut VIEW: [Cell; MAX_CELLS] = [Cell::BLANK; MAX_CELLS];

/// Fill `VIEW` with the `rows` visible lines at scroll `offset` (lines scrolled up
/// from the live bottom, clamped to the scrollback depth). `offset == 0` reproduces
/// the live screen exactly.
unsafe fn compose(offset: u32) {
    let term = &*addr_of!(TERM);
    let sb = &*addr_of!(SB);
    let view = &mut *addr_of_mut!(VIEW);
    let cols = term.cols as usize;
    let rows = term.rows as usize;
    let off = (offset as usize).min(sb.count);
    let top = sb.count - off; // first visible absolute line index (into sb ++ screen)
    for vy in 0..rows {
        let line_idx = top + vy;
        for c in 0..cols {
            let cell = if line_idx < sb.count {
                sb.line(line_idx)[c]
            } else {
                term.cells[(line_idx - sb.count) * cols + c]
            };
            view[vy * cols + c] = cell;
        }
    }
}

#[inline]
unsafe fn parser_mut() -> &'static mut Parser {
    let p = &mut *addr_of_mut!(PARSER);
    if p.is_none() {
        *p = Some(Parser::new());
    }
    p.as_mut().unwrap()
}

/// (Re)initialise the terminal grid to `cols`×`rows` and clear it. Call once
/// before feeding, and again on resize.
#[no_mangle]
pub extern "C" fn term_reset(cols: u32, rows: u32) {
    unsafe {
        (*addr_of_mut!(TERM)).resize(cols, rows);
        let _ = parser_mut(); // ensure parser exists
    }
}

/// Feed `len` bytes of guest stdout (at linear-memory address `ptr`) through the
/// parser into the grid. `ptr`/`len` are exactly the values nano passes to the
/// `console_write` host import, so the JS tap forwards them here with no copy.
#[no_mangle]
pub unsafe extern "C" fn term_feed(ptr: u32, len: u32) {
    let bytes = core::slice::from_raw_parts(ptr as *const u8, len as usize);
    let term = &mut *addr_of_mut!(TERM);
    parser_mut().advance(term, bytes);
}

/// Pointer to the contiguous cell array (row-major, stride = `term_cols()`,
/// 8 bytes/cell). Valid for `term_cols() * term_rows()` cells.
#[no_mangle]
pub extern "C" fn term_cells_ptr() -> u32 {
    unsafe { addr_of!(TERM.cells) as u32 }
}

#[no_mangle]
pub extern "C" fn term_cols() -> u32 {
    unsafe { addr_of!(TERM.cols).read() }
}

#[no_mangle]
pub extern "C" fn term_rows() -> u32 {
    unsafe { addr_of!(TERM.rows).read() }
}

#[no_mangle]
pub extern "C" fn term_cursor_row() -> u32 {
    unsafe { addr_of!(TERM.cur_row).read() }
}

#[no_mangle]
pub extern "C" fn term_cursor_col() -> u32 {
    unsafe { addr_of!(TERM.cur_col).read() }
}

/// Maximum scroll offset (number of scrollback lines available above the live top).
#[no_mangle]
pub extern "C" fn term_scroll_max() -> u32 {
    unsafe { (*addr_of!(SB)).count as u32 }
}

/// Compose the viewport for scroll `offset` into the `VIEW` buffer. Call before
/// reading `term_view_ptr()`; `offset` is clamped to `term_scroll_max()`.
#[no_mangle]
pub extern "C" fn term_compose(offset: u32) {
    unsafe { compose(offset) }
}

/// Pointer to the composed viewport (row-major, stride = `term_cols()`, 8 bytes/
/// cell). Valid for `term_cols() * term_rows()` cells after `term_compose`.
#[no_mangle]
pub extern "C" fn term_view_ptr() -> u32 {
    unsafe { addr_of!(VIEW) as u32 }
}
