// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/vfs/vfs.mjs — the Kernel VFS (spec §6): mount table with
// longest-prefix resolution, a kernel-global fd table, and watch fan-out.
// Guests see one tree; mounts are a Kernel-internal concept.
//
// K2 scope: single backend kind "mem" (MemFS). The kernel fd table is an
// identity-style wrapper over backend fds so the VM's direct-MemFS path
// stays untouched; bus clients (K4+) go through KernelVfs exclusively.
// opfs/cas backends land in K8.

import { MemFS } from "./memfs.mjs";
import { WatchRegistry } from "./watch.mjs";
import { ERRNO, KernelError } from "../errno.mjs";

class KernelVfs {
  /**
   * @param {import("../types.d.mts").KernelOptions["mounts"]} [mounts]
   */
  constructor(mounts) {
    /** @type {Array<{ prefix: string, backend: MemFS, kind: string }>} sorted longest-prefix-first */
    this._mounts = [];
    this.watch = new WatchRegistry();
    /** @type {Map<number, { mount: { prefix: string, backend: MemFS }, backendFd: number }>} */
    this._fds = new Map();
    this._nextFd = 1000;

    // Default: one in-memory root. Named mounts (opfs/cas) are K8.
    this._addMount("/", new MemFS(), "mem");
    if (mounts) {
      for (const [prefix, spec] of Object.entries(mounts)) {
        if (prefix === "/") continue; // the root mem mount is implicit
        if (spec.backend !== "mem") {
          throw new KernelError(ERRNO.ENOSYS, undefined, `backend ${spec.backend} lands in K8`);
        }
        this._addMount(prefix, new MemFS(), spec.backend);
      }
    }
  }

  _addMount(prefix, backend, kind) {
    backend.onMutate = (path, eventKind) =>
      this.watch.emit(prefix === "/" ? path : prefix + path, eventKind);
    this._mounts.push({ prefix, backend, kind });
    // Longest prefix first so resolveMount finds the most specific mount.
    this._mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /** The root mem backend — the VM's direct MemFS (frozen contract). */
  get rootMem() {
    return this._mounts.find((m) => m.prefix === "/").backend;
  }

  /**
   * Swap the root mem backend (snapshot restore path): rewires the watch
   * hook and invalidates kernel fds that pointed into the old backend.
   * @param {MemFS} memfs
   */
  replaceRootMem(memfs) {
    const mount = this._mounts.find((m) => m.prefix === "/");
    const old = mount.backend;
    mount.backend = memfs;
    memfs.onMutate = (path, kind) => this.watch.emit(path, kind);
    if (old) old.onMutate = null;
    for (const [fd, e] of this._fds) {
      if (e.mount.prefix === "/") this._fds.delete(fd);
    }
  }

  /** @returns {{ prefix: string, backend: MemFS, kind: string, rel: string }} */
  resolveMount(path) {
    for (const m of this._mounts) {
      if (m.prefix === "/") return { ...m, rel: path };
      if (path === m.prefix || path.startsWith(m.prefix + "/")) {
        const rel = path.slice(m.prefix.length) || "/";
        return { ...m, rel };
      }
    }
    return { ...this._mounts[this._mounts.length - 1], rel: path };
  }

  mounts() {
    return this._mounts.map((m) => ({ prefix: m.prefix, kind: m.kind }));
  }

  // --- fd-based surface (bus clients) ---

  /** @returns {number} kernel fd, or throws KernelError */
  open(path, flags, mode) {
    const m = this.resolveMount(path);
    const backendFd = m.backend.open(m.rel, flags, mode);
    if (backendFd < 0) throw KernelError.fromNegative(backendFd, path);
    const fd = this._nextFd++;
    this._fds.set(fd, { mount: m, backendFd });
    return fd;
  }

  close(fd) {
    const e = this._takeFd(fd);
    const r = e.mount.backend.close(e.backendFd);
    if (r < 0) throw KernelError.fromNegative(r);
  }

  /** Read into dest at destOff; returns bytes read (0 = EOF). */
  read(fd, dest, destOff, len, pos) {
    const e = this._getFd(fd);
    const r = e.mount.backend.readInto(e.backendFd, dest, destOff, len, pos);
    if (r < 0) throw KernelError.fromNegative(r);
    return r;
  }

  /** Write src at pos; returns bytes written. */
  write(fd, src, pos) {
    const e = this._getFd(fd);
    const r = e.mount.backend.writeFrom(e.backendFd, src, pos);
    if (r < 0) throw KernelError.fromNegative(r);
    return r;
  }

  _getFd(fd) {
    const e = this._fds.get(fd);
    if (!e) throw new KernelError(ERRNO.EBADF);
    return e;
  }

  _takeFd(fd) {
    const e = this._getFd(fd);
    this._fds.delete(fd);
    return e;
  }

  // --- path-based surface (bus clients); throws KernelError on failure ---

  stat(path, followSymlinks = true) {
    const m = this.resolveMount(path);
    const r = m.backend.statObj(m.rel, followSymlinks);
    if (typeof r === "number") throw KernelError.fromNegative(r, path);
    return r;
  }

  readdir(path) {
    const m = this.resolveMount(path);
    const r = m.backend.readdirNames(m.rel);
    if (typeof r === "number") throw KernelError.fromNegative(r, path);
    return r;
  }

  realpath(path) {
    const m = this.resolveMount(path);
    const r = m.backend.realpath(m.rel);
    if (typeof r === "number") throw KernelError.fromNegative(r, path);
    return m.prefix === "/" ? r : m.prefix + (r === "/" ? "" : r);
  }

  readlinkString(path) {
    const m = this.resolveMount(path);
    const node = m.backend.resolve(m.rel, false);
    if (!node) throw new KernelError(ERRNO.ENOENT, undefined, path);
    if (!node.isSymlink) throw new KernelError(ERRNO.EINVAL, undefined, path);
    return node.target;
  }

  mkdir(path, mode) { this._num(path, (b, rel) => b.mkdir(rel, mode)); }
  unlink(path, flags = 0) { this._num(path, (b, rel) => b.unlink(rel, flags)); }
  link(oldPath, newPath) {
    // Cross-mount hardlinks are EXDEV, as on Linux.
    const a = this.resolveMount(oldPath);
    const b = this.resolveMount(newPath);
    if (a.prefix !== b.prefix) throw new KernelError(ERRNO.EXDEV);
    this._num(oldPath, (backend) => backend.link(a.rel, b.rel));
  }
  rename(oldPath, newPath) {
    const a = this.resolveMount(oldPath);
    const b = this.resolveMount(newPath);
    if (a.prefix !== b.prefix) throw new KernelError(ERRNO.EXDEV);
    this._num(oldPath, (backend) => backend.rename(a.rel, b.rel));
  }
  symlink(target, path) { this._num(path, (b, rel) => (b.createSymlink(rel, target), 0)); }
  chmod(path, mode) { this._num(path, (b, rel) => b.chmod(rel, mode)); }
  utimes(path, mtimeSec) { this._num(path, (b, rel) => b.utimes(rel, mtimeSec)); }
  truncate(path, length) { this._num(path, (b, rel) => b.truncate(rel, length)); }

  _num(path, fn) {
    const m = this.resolveMount(path);
    const r = fn(m.backend, m.rel);
    if (typeof r === "number" && r < 0) throw KernelError.fromNegative(r, path);
  }
}

export { KernelVfs };
