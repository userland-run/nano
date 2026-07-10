// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/services/rspack.mjs — the Rspack/Rsbuild bundler service (spec §13).
//
// HONEST STATUS: Rspack is a native Rust/napi binary. There is NO browser-wasm
// build of Rspack in existence today, so it cannot run as an in-tab wasm
// Kernel Service. This adapter registers the service contract so tiers can
// probe for it and get a clean, documented ERR_NODERT_UNSUPPORTED rather than a
// silent failure — and so a future wasm build (or a WASI runner) drops in
// behind the same id without touching callers.
//
// The working in-tab bundler path in userland.run is esbuild-wasm (which DOES
// have a browser build); a `createEsbuildService` can register under a distinct
// id when its wasm is wired. Rspack itself stays deferred.

import { ERRNO, KernelError } from "../errno.mjs";

function createRspackService({ backend } = {}) {
  return {
    id: "rspack",
    version: "0.0.0-deferred",
    kind: "wasm-service",
    methods: ["build", "rebuild"],
    invoke(method, payload) {
      if (backend) return backend.invoke(method, payload);
      throw new KernelError(
        ERRNO.ENOTSUP,
        "ERR_NODERT_UNSUPPORTED",
        "rspack has no browser-wasm build; run bundling in the VM (engine:'vm') " +
          "or use the esbuild-wasm service. See kernel/services/rspack.mjs."
      );
    },
    available: () => !!backend,
  };
}

export { createRspackService };
