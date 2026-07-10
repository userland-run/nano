// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/index.mjs — public entry for the Kernel (spec UL-SPEC/nodert §4).

export { Kernel } from "./kernel.mjs";
export { FetchBridge, NET_BUFFER_MAX } from "./net/fetch-bridge.mjs";
export { PortTable } from "./net/ports.mjs";
export { ServiceRegistry } from "./services/registry.mjs";
export {
  registerBuiltinServices,
  createZlibService,
  createTypeStripService,
  createDuckDbService,
  createRspackService,
} from "./services/index.mjs";
export { stripTypes } from "./services/type-strip.mjs";
export { BusClient } from "./bus/client.mjs";
export { SyncCaller } from "./bus/sab-channel.mjs";
export { ERRNO, ERRNO_NAMES, KernelError } from "./errno.mjs";
export {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  NS,
  OP,
  OP_NAMES,
  opNamespace,
} from "./bus/opcodes.mjs";
