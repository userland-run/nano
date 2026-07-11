// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// MemFS moved to kernel/vfs/memfs.mjs as part of the Kernel extraction
// (specs/nano/node-host-engine.md §4.1). This shim keeps the historical
// import path working for the terminal (@container alias), the SDK vendor
// tree, and the web demo.

export { MemFS, FSNode } from "../../../kernel/vfs/memfs.mjs";
