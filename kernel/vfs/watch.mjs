// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/vfs/watch.mjs — fs.watch semantics for the Kernel VFS (spec §6.1):
// coalesced "rename"/"change" events per watched path, delivered
// asynchronously. A watcher on a directory also receives events for its
// direct children (with `filename` = basename), matching Node's fs.watch.
// inotify-precision is not promised (divergence registry).

/**
 * @typedef {{ path: string, kind: "rename" | "change", filename: string }} WatchEvent
 */

class WatchRegistry {
  constructor() {
    /** @type {Map<number, { path: string, listener: (ev: WatchEvent) => void }>} */
    this._watchers = new Map();
    this._nextId = 1;
    /** @type {Map<string, WatchEvent>} pending, keyed by watcherId:path:kind */
    this._pending = new Map();
    this._flushQueued = false;
  }

  /**
   * @param {string} path absolute path (file or directory)
   * @param {(ev: WatchEvent) => void} listener
   * @returns {number} watch id
   */
  watch(path, listener) {
    const id = this._nextId++;
    this._watchers.set(id, { path: normalize(path), listener });
    return id;
  }

  /** @param {number} id */
  unwatch(id) {
    return this._watchers.delete(id);
  }

  get size() {
    return this._watchers.size;
  }

  /**
   * Report a mutation. Events are coalesced per (watcher, path, kind) within
   * a microtask turn: a burst of writes to one file delivers one "change".
   * @param {string} path @param {"rename"|"change"} kind
   */
  emit(path, kind) {
    if (this._watchers.size === 0) return;
    const p = normalize(path);
    const dir = parentOf(p);
    const base = basenameOf(p);
    for (const [id, w] of this._watchers) {
      let filename = null;
      if (w.path === p) filename = base;
      else if (w.path === dir) filename = base;
      else continue;
      this._pending.set(`${id}:${p}:${kind}`, {
        listener: w.listener,
        ev: { path: p, kind, filename },
      });
    }
    if (this._pending.size > 0 && !this._flushQueued) {
      this._flushQueued = true;
      queueMicrotask(() => this._flush());
    }
  }

  _flush() {
    this._flushQueued = false;
    const batch = [...this._pending.values()];
    this._pending.clear();
    for (const { listener, ev } of batch) {
      try {
        listener(ev);
      } catch {
        // A throwing listener must not break delivery to the others.
      }
    }
  }
}

function normalize(path) {
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}
function parentOf(path) {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}
function basenameOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export { WatchRegistry };
