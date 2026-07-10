// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/boot/console.mjs — a lean console (M0) writing to the stdio
// pipes via the boot's write callbacks. Upstream lib/internal/console/* runs
// verbatim in M1 once Writable streams land (needs stream_wrap). Divergence:
// DIV-CONSOLE-M0 (no color, lean util.inspect).

import { leanFormat } from "./boot.mjs";

function makeConsole({ write, writeErr }) {
  const counts = new Map();
  const timers = new Map();
  const c = {
    log: (...a) => write(leanFormat(a) + "\n"),
    info: (...a) => write(leanFormat(a) + "\n"),
    debug: (...a) => write(leanFormat(a) + "\n"),
    warn: (...a) => writeErr(leanFormat(a) + "\n"),
    error: (...a) => writeErr(leanFormat(a) + "\n"),
    trace: (...a) => writeErr("Trace: " + leanFormat(a) + "\n"),
    dir: (obj, opts) => write(leanFormat([obj]) + "\n"),
    assert: (cond, ...a) => { if (!cond) writeErr("Assertion failed" + (a.length ? ": " + leanFormat(a) : "") + "\n"); },
    count: (label = "default") => { const n = (counts.get(label) ?? 0) + 1; counts.set(label, n); write(`${label}: ${n}\n`); },
    countReset: (label = "default") => counts.delete(label),
    group: (...a) => { if (a.length) write(leanFormat(a) + "\n"); },
    groupCollapsed: (...a) => { if (a.length) write(leanFormat(a) + "\n"); },
    groupEnd: () => {},
    table: (data) => write(leanFormat([data]) + "\n"),
    time: (label = "default") => timers.set(label, performance.now()),
    timeEnd: (label = "default") => { const t = timers.get(label); if (t !== undefined) { write(`${label}: ${(performance.now() - t).toFixed(3)}ms\n`); timers.delete(label); } },
    timeLog: (label = "default", ...a) => { const t = timers.get(label); if (t !== undefined) write(`${label}: ${(performance.now() - t).toFixed(3)}ms ${leanFormat(a)}\n`); },
    clear: () => {},
  };
  c.Console = function Console() { return c; };
  return c;
}

export { makeConsole };
