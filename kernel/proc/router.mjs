// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/proc/router.mjs — the spawn routing table (spec §12.1 and
// UL-SPEC/applets §3). The table is DATA, not code: embedders pin tools to
// tiers (routing: { jest: "vm" }); tiers register spawn delegates. Until a
// non-vm delegate exists every route resolves to "vm", which keeps the
// execve seam a behavior no-op (K7).

class SpawnRouter {
  /** @param {Record<string, string>} [pins] command basename → tier */
  constructor(pins = {}) {
    /** @type {Map<string, string>} */
    this._pins = new Map(Object.entries(pins));
    /** @type {Map<string, Function>} tier → spawn delegate */
    this._delegates = new Map();
  }

  /**
   * Register a tier's spawn delegate, e.g. the nodert worker factory
   * (spec §14.2) or the Boa script runner. Returns an unregister fn.
   */
  registerDelegate(tier, fn) {
    this._delegates.set(tier, fn);
    return () => this._delegates.delete(tier);
  }

  delegateFor(tier) {
    return this._delegates.get(tier) ?? null;
  }

  /** Pin (or unpin with null) a command to a tier — S4 revertibility. */
  pin(command, tier) {
    if (tier) this._pins.set(command, tier);
    else this._pins.delete(command);
  }

  /** Enumerable active routing (UL-SPEC/applets S4). */
  routing() {
    return Object.fromEntries(this._pins);
  }

  /**
   * Resolve argv to a tier (spec §12.1 table).
   * @param {string[]} argv
   * @param {{ shebang?: string }} [hints] first line of the resolved target
   * @returns {{ tier: string, command: string }}
   */
  route(argv, hints = {}) {
    const command = basename(argv?.[0] ?? "");
    const pinned = this._pins.get(command);
    if (pinned) return { tier: pinned, command };
    // Shebang forms: "#!/usr/bin/node", "#!/usr/bin/env node" (§12.1).
    if (command === "node" || /(^|[/\s])node\b/.test((hints.shebang ?? "").replace(/^#!\s*/, ""))) {
      // The common fast path — but only when a nodert delegate exists;
      // otherwise the VM stays authoritative.
      return { tier: this._delegates.has("node") ? "node" : "vm", command };
    }
    return { tier: "vm", command };
  }
}

function basename(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}

export { SpawnRouter };
