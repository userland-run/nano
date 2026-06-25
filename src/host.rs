// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

extern "C" {
    pub fn debug_log(val: i32);
    pub fn abort_js() -> !;
    pub fn emscripten_random() -> f32;
    pub fn emscripten_date_now() -> f64;
    pub fn console_write(fd: i32, ptr: i32, len: i32);
}
