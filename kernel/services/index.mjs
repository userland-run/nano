// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/services/index.mjs — register the built-in Kernel Services on a
// Kernel (spec §13). Services that need a heavy wasm backend (DuckDB) accept
// an injectable backend so registration never triggers a download; production
// wires the real backend via the SDK/catalog wasm-service artifacts.

import { createZlibService } from "./zlib.mjs";
import { createTypeStripService } from "./type-strip.mjs";
import { createDuckDbService } from "./duckdb.mjs";
import { createRspackService } from "./rspack.mjs";

/**
 * @param {import("../kernel.mjs").Kernel} kernel
 * @param {{ duckdbBackend?: any, rspackBackend?: any, include?: string[] }} [opts]
 */
async function registerBuiltinServices(kernel, opts = {}) {
  const include = opts.include ?? ["zlib", "swc", "duckdb", "rspack"];
  const registered = [];
  const add = (svc) => { kernel.services.register(svc); registered.push(svc.id); };

  if (include.includes("zlib")) add(await createZlibService());
  if (include.includes("swc")) add(createTypeStripService());
  if (include.includes("duckdb")) add(createDuckDbService({ backend: opts.duckdbBackend }));
  if (include.includes("rspack")) add(createRspackService({ backend: opts.rspackBackend }));
  return registered;
}

export {
  registerBuiltinServices,
  createZlibService,
  createTypeStripService,
  createDuckDbService,
  createRspackService,
};
