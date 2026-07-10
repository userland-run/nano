// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/caps/profiles.mjs — capability profiles (spec §7.3).
// TRUSTED_DEV keeps current behavior for Shell-spawned vm/node processes;
// BOA_DEFAULT mirrors scripting mode's deny-by-default.

/** @returns {import("../types.d.mts").Capabilities} */
function trustedDev() {
  return {
    fs: { mode: "readwrite" },
    net: { fetchHosts: "all", listen: true, loopbackConnect: true },
    spawn: { node: true, vm: true, boa: true, wasm: true },
    services: ["*"],
    env: "inherit",
    stdio: "inherit",
  };
}

/** @returns {import("../types.d.mts").Capabilities} */
function boaDefault() {
  return {
    fs: { mode: "none" },
    net: { fetchHosts: "none", listen: false, loopbackConnect: false },
    spawn: { node: false, vm: false, boa: false, wasm: false },
    services: [],
    env: "none",
    stdio: "pipe",
  };
}

/** @returns {import("../types.d.mts").Capabilities} */
function none() {
  return boaDefault();
}

/**
 * Map scripting mode's ExposeConfig (sdk/src/types.ts) onto Capabilities so
 * the Boa bridge boundary can be described in caps terms (spec §7.3).
 * @param {{ fs?: "none"|"readonly"|"readwrite", run?: boolean, node?: boolean }} expose
 */
function fromExposeConfig(expose = {}) {
  const caps = boaDefault();
  if (expose.fs) caps.fs.mode = expose.fs;
  caps.spawn.vm = !!expose.run;
  caps.spawn.node = !!expose.node;
  return caps;
}

export { trustedDev, boaDefault, none, fromExposeConfig };
