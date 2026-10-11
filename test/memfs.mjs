// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// The test runner (run.mjs) and the MemFS unit tests (test_memfs.mjs) exercise
// the SHIPPED MemFS — the kernel one the browser host re-exports — instead of a
// separate test-only copy that could drift from what actually runs.

export { MemFS, FSNode } from "../kernel/vfs/memfs.mjs";
