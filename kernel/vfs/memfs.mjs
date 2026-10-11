// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * In-memory POSIX-like filesystem for NanoVM.
 * Provides FSNode (inode) and MemFS (filesystem operations) classes.
 * Browser-compatible (uses DecompressionStream for gzip).
 */

// Fallback ino counter for FSNodes constructed without an owning MemFS.
// Each MemFS instance keeps its own counter (`fs._nextIno`) so that
// deserializing a snapshot cannot clash with other live instances.
let _nextIno = 1;

class FSNode {
  constructor(name, parent, mode, owner) {
    this.name = name;
    this.parent = parent;
    this.mode = mode;        // full mode including type bits (S_IFDIR, S_IFREG, etc.)
    this._buf = null;        // file backing store; capacity may exceed `size`
    this.children = null;    // Map<string, FSNode> for directories
    this.target = null;      // string for symlinks
    this.ino = owner ? owner._nextIno++ : _nextIno++;
    this.nlink = 1;
    this.size = 0;           // logical file length
    this.mtime = null;       // seconds since epoch; null = report "now" in stat
  }

  /**
   * File contents as a Uint8Array of exactly `size` bytes (a view onto the
   * backing store, which grows geometrically so appends are amortized O(1)
   * instead of an exact-size realloc + full copy per write). Readers keep using
   * `node.data` / `data.length` unchanged. Assigning replaces the backing store
   * and sets `size` to its length. Bytes in [size, capacity) are always zero.
   */
  get data() {
    const b = this._buf;
    return b && b.length !== this.size ? b.subarray(0, this.size) : b;
  }

  set data(v) {
    this._buf = v;
    if (v) this.size = v.length;
  }

  get isDir()     { return (this.mode & 0o170000) === 0o040000; }
  get isFile()    { return (this.mode & 0o170000) === 0o100000; }
  get isSymlink() { return (this.mode & 0o170000) === 0o120000; }
}

// Open flags (RISC-V Linux / generic)
const O_RDONLY    = 0;
const O_WRONLY    = 1;
const O_RDWR      = 2;
const O_CREAT     = 0x40;
const O_EXCL      = 0x80;
const O_TRUNC     = 0x200;
const O_APPEND    = 0x400;
const O_DIRECTORY = 0x10000;

// Errors
const EPERM    = -1;
const ENOENT   = -2;
const EBADF    = -9;
const EEXIST   = -17;
const ENOTDIR  = -20;
const EISDIR   = -21;
const EINVAL   = -22;
const EMFILE   = -24;
const ENOSPC   = -28;
const EFBIG    = -27;
const ENOTEMPTY = -39;

// Largest file MemFS will grow (a JS typed array must fit it, and a guest
// pwrite at a huge offset must fail cleanly instead of throwing RangeError).
const MAX_FILE_SIZE = 2 ** 31;

/** Grow node's backing store to hold `end` bytes (geometric, zero-filled). */
function ensureCapacity(node, end) {
  const buf = node._buf;
  if (buf && end <= buf.length) return;
  const cap = Math.min(MAX_FILE_SIZE, Math.max(end, buf ? buf.length * 2 : 0, 64));
  const nb = new Uint8Array(cap);
  if (buf) nb.set(buf.subarray(0, node.size));
  node._buf = nb; // size unchanged: the new tail is zero
}

class MemFS {
  constructor() {
    this._nextIno = 1;
    this.root = new FSNode("", null, 0o040755, this);
    this.root.children = new Map();
    this.root.parent = this.root;
    // hostFd -> open-file description { node, flags, offset, dirEntries? }.
    // The VM's guest fds point at these: dup'd / forked fds share ONE entry, so
    // they share the file offset and status flags (POSIX semantics). The VM
    // host closes an entry only once no guest fd references it any more.
    this.openFiles = new Map();
    this.nextHostFd = 100;
    // Nullable mutation hook installed by KernelVfs: (path, kind) with kind
    // "rename" (create/delete/move) or "change" (content/metadata) — the
    // fs.watch event vocabulary. MemFS itself stays dependency-free.
    this.onMutate = null;
  }

  _notify(path, kind) {
    if (this.onMutate) this.onMutate(path, kind);
  }

  /** Canonical path of a live node (hardlinks report their primary name). */
  _pathOf(node) {
    if (node === this.root) return "/";
    const parent = this._parentPath(node);
    return parent === "/" ? "/" + node.name : parent + "/" + node.name;
  }

  // --- Path resolution ---

  resolve(path, followSymlinks = true, maxDepth = 32) {
    if (!path || path === "") return null;
    const parts = path.split("/").filter(Boolean);
    let node = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (!node.isDir) return null;
      const p = parts[i];
      if (p === ".") continue;
      if (p === "..") { node = node.parent || node; continue; }
      if (!node.children.has(p)) return null;
      node = node.children.get(p);
      if (node.isSymlink && (followSymlinks || i < parts.length - 1)) {
        if (maxDepth <= 0) return null;
        const target = node.target.startsWith("/")
          ? node.target
          : this._parentPath(node) + "/" + node.target;
        node = this.resolve(target, true, maxDepth - 1);
        if (!node) return null;
      }
    }
    return node;
  }

  /**
   * Resolve the directory that will hold `path`'s final component — the parent
   * is resolved like any other path, so ".", "..", and symlinked directories
   * work. Returns { dir, name } (name "" for "/"), or a negative errno.
   */
  _parentOf(path) {
    const parts = String(path).split("/").filter(Boolean);
    const name = parts.pop() || "";
    if (!name) return { dir: this.root, name: "" };
    const dir = this.resolve("/" + parts.join("/"), true);
    if (!dir) return ENOENT;
    if (!dir.isDir) return ENOTDIR;
    return { dir, name };
  }

  /** Canonical path of entry `name` inside directory `dir`. */
  _childPath(dir, name) {
    const p = this._pathOf(dir);
    return p === "/" ? "/" + name : p + "/" + name;
  }

  _parentPath(node) {
    const parts = [];
    let n = node.parent;
    while (n && n !== this.root) {
      parts.unshift(n.name);
      n = n.parent;
    }
    return "/" + parts.join("/");
  }

  // --- File operations ---

  open(path, flags, mode, depth = 8) {
    if ((flags & O_CREAT) && (flags & O_EXCL) && this.resolve(path, false)) return EEXIST;
    let node = this.resolve(path);

    if (!node) {
      if (!(flags & O_CREAT)) return ENOENT;
      const where = this._parentOf(path);
      if (typeof where === "number") return where;
      const { dir, name } = where;
      if (!name || name === "." || name === "..") return EISDIR;
      // Present but unresolvable → a dangling symlink: create its target (as
      // Linux does), never clobber the link itself.
      const link = dir.children.get(name);
      if (link) {
        if (!link.isSymlink || depth <= 0) return ENOENT;
        const target = link.target.startsWith("/") ? link.target : this._childPath(dir, link.target);
        return this.open(target, flags, mode, depth - 1);
      }
      node = new FSNode(name, dir, 0o100000 | ((mode & 0o7777) || 0o644), this);
      node.data = new Uint8Array(0);
      node.size = 0;
      dir.children.set(name, node);
      this._notify(this._pathOf(node), "rename");
    }

    if ((flags & O_DIRECTORY) && !node.isDir) return ENOTDIR;

    if (node.isDir) {
      const hostFd = this.nextHostFd++;
      const entries = [".", "..", ...node.children.keys()];
      this.openFiles.set(hostFd, { node, flags, offset: 0, dirEntries: entries });
      return hostFd;
    }

    if ((flags & O_TRUNC) && node.isFile) {
      node.data = new Uint8Array(0);
      node.size = 0;
      node.mtime = Math.floor(Date.now() / 1000);
      this._notify(this._pathOf(node), "change");
    }

    const hostFd = this.nextHostFd++;
    this.openFiles.set(hostFd, { node, flags, offset: 0 });
    return hostFd;
  }

  close(hostFd) {
    if (!this.openFiles.has(hostFd)) return EBADF;
    this.openFiles.delete(hostFd);
    return 0;
  }

  pread(hostFd, wasmMem, bufPhys, count, offset) {
    const e = this.openFiles.get(hostFd);
    if (!e) return EBADF;
    if (!e.node.isFile) return EISDIR;
    const data = e.node.data || new Uint8Array(0);
    if (offset >= data.length) return 0; // EOF
    const avail = Math.min(count, data.length - offset);
    new Uint8Array(wasmMem.buffer, bufPhys, avail).set(
      data.subarray(offset, offset + avail)
    );
    return avail;
  }

  pwrite(hostFd, wasmMem, bufPhys, count, offset) {
    const e = this.openFiles.get(hostFd);
    if (!e) return EBADF;
    if (!e.node.isFile) return EISDIR;
    if (!(offset >= 0) || !(count >= 0)) return EINVAL;
    const end = offset + count;
    if (end > MAX_FILE_SIZE) return EFBIG;
    const src = new Uint8Array(wasmMem.buffer, bufPhys, count);
    ensureCapacity(e.node, end);
    e.node._buf.set(src, offset);
    e.node.size = Math.max(e.node.size, end);
    e.node.mtime = Math.floor(Date.now() / 1000);
    this._notify(this._pathOf(e.node), "change");
    return count;
  }

  // --- Stat ---

  _writeStat(node, wasmMem, bufPhys) {
    new Uint8Array(wasmMem.buffer, bufPhys, 128).fill(0);
    const dv = new DataView(wasmMem.buffer, bufPhys, 128);
    const now = node.mtime != null ? node.mtime : Math.floor(Date.now() / 1000);
    const blocks = Math.ceil(node.size / 512);

    dv.setBigUint64(0, 1n, true);                        // st_dev
    dv.setBigUint64(8, BigInt(node.ino), true);           // st_ino
    dv.setUint32(16, node.mode, true);                    // st_mode
    dv.setUint32(20, node.nlink, true);                   // st_nlink
    dv.setUint32(24, 0, true);                            // st_uid
    dv.setUint32(28, 0, true);                            // st_gid
    dv.setBigUint64(32, 0n, true);                        // st_rdev
    dv.setBigUint64(40, 0n, true);                        // __pad1
    dv.setBigInt64(48, BigInt(node.size), true);           // st_size
    dv.setInt32(56, 4096, true);                          // st_blksize
    dv.setBigInt64(64, BigInt(blocks), true);              // st_blocks
    dv.setBigInt64(72, BigInt(now), true);                 // st_atime
    dv.setBigInt64(88, BigInt(now), true);                 // st_mtime
    dv.setBigInt64(104, BigInt(now), true);                // st_ctime
    return 0;
  }

  _writeCharDevStat(wasmMem, bufPhys) {
    new Uint8Array(wasmMem.buffer, bufPhys, 128).fill(0);
    const dv = new DataView(wasmMem.buffer, bufPhys, 128);
    const now = Math.floor(Date.now() / 1000);
    dv.setBigUint64(0, 5n, true);                         // st_dev
    dv.setBigUint64(8, 1n, true);                         // st_ino
    dv.setUint32(16, 0o020666, true);                     // st_mode (S_IFCHR | 0666)
    dv.setUint32(20, 1, true);                            // st_nlink
    dv.setInt32(56, 1024, true);                          // st_blksize
    dv.setBigInt64(72, BigInt(now), true);                 // st_atime
    dv.setBigInt64(88, BigInt(now), true);                 // st_mtime
    dv.setBigInt64(104, BigInt(now), true);                // st_ctime
    return 0;
  }

  _writeCharDevStatx(wasmMem, bufPhys) {
    new Uint8Array(wasmMem.buffer, bufPhys, 256).fill(0);
    const dv = new DataView(wasmMem.buffer, bufPhys, 256);
    const now = Math.floor(Date.now() / 1000);
    dv.setUint32(0, 0x0fff, true);                       // stx_mask (STATX_ALL)
    dv.setUint32(4, 1024, true);                          // stx_blksize
    dv.setUint32(16, 1, true);                            // stx_nlink
    dv.setUint16(28, 0o020666, true);                     // stx_mode (S_IFCHR | 0666)
    dv.setBigUint64(32, 1n, true);                        // stx_ino
    for (const o of [64, 80, 96, 112]) dv.setBigInt64(o, BigInt(now), true); // a/b/c/mtime
    dv.setUint32(136, 5, true);                           // stx_dev_major
    return 0;
  }

  _writeStatx(node, wasmMem, bufPhys) {
    new Uint8Array(wasmMem.buffer, bufPhys, 256).fill(0);
    const dv = new DataView(wasmMem.buffer, bufPhys, 256);
    const now = node.mtime != null ? node.mtime : Math.floor(Date.now() / 1000);
    const blocks = Math.ceil(node.size / 512);

    const STATX_ALL = 0x0fff;
    dv.setUint32(0, STATX_ALL, true);                    // stx_mask
    dv.setUint32(4, 4096, true);                          // stx_blksize
    dv.setUint32(16, node.nlink, true);                   // stx_nlink
    dv.setUint32(20, 0, true);                            // stx_uid
    dv.setUint32(24, 0, true);                            // stx_gid
    dv.setUint16(28, node.mode, true);                    // stx_mode
    dv.setBigUint64(32, BigInt(node.ino), true);          // stx_ino
    dv.setBigUint64(40, BigInt(node.size), true);         // stx_size
    dv.setBigUint64(48, BigInt(blocks), true);            // stx_blocks
    dv.setBigInt64(64, BigInt(now), true);                 // stx_atime
    dv.setBigInt64(80, BigInt(now), true);                 // stx_btime
    dv.setBigInt64(96, BigInt(now), true);                 // stx_ctime
    dv.setBigInt64(112, BigInt(now), true);                // stx_mtime
    dv.setUint32(136, 0, true);                           // stx_dev_major
    dv.setUint32(140, 1, true);                           // stx_dev_minor
    return 0;
  }

  fstat(hostFd, wasmMem, bufPhys) {
    const e = this.openFiles.get(hostFd);
    if (!e) return EBADF;
    return this._writeStat(e.node, wasmMem, bufPhys);
  }

  stat(path, wasmMem, bufPhys, flags) {
    const followSymlinks = !(flags & 0x100); // AT_SYMLINK_NOFOLLOW
    const node = this.resolve(path, followSymlinks);
    if (!node) return ENOENT;
    return this._writeStat(node, wasmMem, bufPhys);
  }

  statx(path, wasmMem, bufPhys, flags) {
    const followSymlinks = !(flags & 0x100);
    const node = this.resolve(path, followSymlinks);
    if (!node) return ENOENT;
    return this._writeStatx(node, wasmMem, bufPhys);
  }

  // --- Directory entries ---

  getdents(hostFd, wasmMem, bufPhys, bufSize, cookie) {
    const e = this.openFiles.get(hostFd);
    if (!e || !e.node.isDir) return ENOTDIR;
    const entries = e.dirEntries || [];
    let off = 0;
    let idx = cookie;
    const enc = new TextEncoder();

    while (idx < entries.length && off < bufSize) {
      const name = entries[idx];
      let ino, dtype;
      if (name === ".") {
        ino = e.node.ino;
        dtype = 4;
      } else if (name === "..") {
        ino = (e.node.parent || e.node).ino;
        dtype = 4;
      } else {
        const child = e.node.children.get(name);
        if (!child) { idx++; continue; }
        ino = child.ino;
        dtype = child.isDir ? 4 : child.isSymlink ? 10 : 8;
      }

      const nameBytes = enc.encode(name);
      const reclen = (19 + nameBytes.length + 1 + 7) & ~7;
      if (off + reclen > bufSize) break;

      const dv = new DataView(wasmMem.buffer, bufPhys + off, reclen);
      dv.setBigUint64(0, BigInt(ino), true);
      dv.setBigInt64(8, BigInt(idx + 1), true);
      dv.setUint16(16, reclen, true);
      dv.setUint8(18, dtype);

      const nameTarget = new Uint8Array(wasmMem.buffer, bufPhys + off + 19, nameBytes.length + 1);
      nameTarget.set(nameBytes);
      nameTarget[nameBytes.length] = 0;

      off += reclen;
      idx++;
    }

    return { bytes: off, nextCookie: idx };
  }

  // --- Symlinks ---

  readlink(path, wasmMem, bufPhys, count) {
    const node = this.resolve(path, false);
    if (!node) return ENOENT;
    if (!node.isSymlink) return EINVAL;
    const enc = new TextEncoder();
    const tb = enc.encode(node.target);
    const len = Math.min(tb.length, count);
    new Uint8Array(wasmMem.buffer, bufPhys, len).set(tb.subarray(0, len));
    return len;
  }

  // --- Access / mkdir / unlink / rename ---

  access(path) {
    const node = this.resolve(path);
    return node ? 0 : ENOENT;
  }

  mkdir(path, mode) {
    const where = this._parentOf(path);
    if (typeof where === "number") return where;
    const { dir, name } = where;
    // No final component means the path is "/" (root), which already exists;
    // "." / ".." name an existing directory too. Return EEXIST (not EINVAL) so
    // `mkdir -p` treats it as a no-op, not fatal.
    if (!name || name === "." || name === "..") return EEXIST;
    if (dir.children.has(name)) return EEXIST;
    const newDir = new FSNode(name, dir, 0o040000 | ((mode & 0o7777) || 0o755), this);
    newDir.children = new Map();
    newDir.nlink = 2;
    dir.children.set(name, newDir);
    this._notify(this._pathOf(newDir), "rename");
    return 0;
  }

  unlink(path, flags) {
    const where = this._parentOf(path);
    if (typeof where === "number") return where;
    const { dir, name } = where;
    if (!name || name === "." || name === "..") return EINVAL;
    if (!dir.children.has(name)) return ENOENT;
    const node = dir.children.get(name);
    const canon = this._childPath(dir, name);
    if (flags & 0x200) {
      if (!node.isDir) return ENOTDIR;
      if (node.children.size > 0) return ENOTEMPTY;
    } else {
      if (node.isDir) return EISDIR;
      if (node.nlink > 0) node.nlink--;
    }
    dir.children.delete(name);
    this._notify(canon, "rename");
    return 0;
  }

  rename(oldpath, newpath) {
    const src = this._parentOf(oldpath);
    if (typeof src === "number") return src;
    if (!src.name || src.name === "." || src.name === "..") return EINVAL;
    const node = src.dir.children.get(src.name);
    if (!node) return ENOENT;
    const dst = this._parentOf(newpath);
    if (typeof dst === "number") return dst;
    if (!dst.name || dst.name === "." || dst.name === "..") return EINVAL;

    // A directory can't move into itself or its own subtree (that would detach
    // the subtree into an unreachable cycle).
    if (node.isDir) {
      for (let d = dst.dir; ; d = d.parent) {
        if (d === node) return EINVAL;
        if (!d.parent || d.parent === d) break;
      }
    }

    const existing = dst.dir.children.get(dst.name);
    if (existing === node) return 0; // same entry (or a hardlink alias): no-op
    if (existing) {
      if (node.isDir) {
        if (!existing.isDir) return ENOTDIR;
        if (existing.children.size > 0) return ENOTEMPTY;
      } else if (existing.isDir) {
        return EISDIR;
      } else if (existing.nlink > 0) {
        existing.nlink--;
      }
    }

    const oldCanon = this._childPath(src.dir, src.name);
    const newCanon = this._childPath(dst.dir, dst.name);
    src.dir.children.delete(src.name);
    node.name = dst.name;
    node.parent = dst.dir;
    dst.dir.children.set(dst.name, node);
    this._notify(oldCanon, "rename");
    this._notify(newCanon, "rename");
    return 0;
  }

  lseekSize(hostFd) {
    const e = this.openFiles.get(hostFd);
    if (!e) return EBADF;
    return e.node.size;
  }

  // --- Object-returning variants for Syscall Bus clients (spec §5) ---
  // The wasmMem-writing methods above are the frozen VM contract; bus
  // clients (nodert) marshal through plain objects/Uint8Arrays instead.

  /** Plain stat object, or negative errno. */
  statObj(path, followSymlinks = true) {
    const node = this.resolve(path, followSymlinks);
    if (!node) return ENOENT;
    return {
      ino: node.ino,
      mode: node.mode,
      nlink: node.nlink,
      size: node.size,
      mtime: node.mtime != null ? node.mtime : Math.floor(Date.now() / 1000),
      isDir: node.isDir,
      isFile: node.isFile,
      isSymlink: node.isSymlink,
    };
  }

  /** Read up to len bytes at file position pos into dest[destOff..]. */
  readInto(hostFd, dest, destOff, len, pos) {
    const e = this.openFiles.get(hostFd);
    if (!e) return EBADF;
    if (!e.node.isFile) return EISDIR;
    const data = e.node.data || new Uint8Array(0);
    if (pos >= data.length) return 0; // EOF
    const avail = Math.min(len, data.length - pos);
    dest.set(data.subarray(pos, pos + avail), destOff);
    return avail;
  }

  /** Write src bytes at file position pos; grows the file as needed. */
  writeFrom(hostFd, src, pos) {
    const e = this.openFiles.get(hostFd);
    if (!e) return EBADF;
    if (!e.node.isFile) return EISDIR;
    if (!(pos >= 0)) return EINVAL;
    const end = pos + src.length;
    if (end > MAX_FILE_SIZE) return EFBIG;
    ensureCapacity(e.node, end);
    e.node._buf.set(src, pos);
    e.node.size = Math.max(e.node.size, end);
    e.node.mtime = Math.floor(Date.now() / 1000);
    this._notify(this._pathOf(e.node), "change");
    return src.length;
  }

  /** Directory entry names (no "."/".."), or negative errno. */
  readdirNames(path) {
    const node = this.resolve(path);
    if (!node) return ENOENT;
    if (!node.isDir) return ENOTDIR;
    return [...node.children.keys()];
  }

  // --- Hardlinks / metadata ops (Kernel extraction, spec §6.1) ---

  link(oldPath, newPath) {
    const node = this.resolve(oldPath, false);
    if (!node) return ENOENT;
    if (node.isDir) return EPERM; // hardlinks to directories are not allowed
    const where = this._parentOf(newPath);
    if (typeof where === "number") return where;
    const { dir, name } = where;
    if (!name || name === "." || name === "..") return EEXIST;
    if (dir.children.has(name)) return EEXIST;
    dir.children.set(name, node);
    node.nlink++;
    this._notify(newPath, "rename");
    return 0;
  }

  /** Canonical path of `path` after following symlinks, or ENOENT. */
  realpath(path) {
    const node = this.resolve(path);
    if (!node) return ENOENT;
    if (node === this.root) return "/";
    const parent = this._parentPath(node);
    return parent === "/" ? "/" + node.name : parent + "/" + node.name;
  }

  chmod(path, mode) {
    const node = this.resolve(path);
    if (!node) return ENOENT;
    node.mode = (node.mode & ~0o7777) | (mode & 0o7777);
    this._notify(path, "change");
    return 0;
  }

  /** Set mtime (seconds since epoch). atime is not stored. */
  utimes(path, mtimeSec) {
    const node = this.resolve(path);
    if (!node) return ENOENT;
    node.mtime = mtimeSec;
    this._notify(path, "change");
    return 0;
  }

  _truncateNode(node, length) {
    if (!node.isFile) return EISDIR;
    if (!(length >= 0)) return EINVAL;
    if (length > MAX_FILE_SIZE) return EFBIG;
    if (length < node.size) {
      // Shrink in place, re-zeroing the cut tail (keeps the zero-past-size
      // invariant the geometric backing store relies on).
      if (node._buf) node._buf.fill(0, length, node.size);
    } else if (length > node.size) {
      ensureCapacity(node, length);
    }
    node.size = length;
    node.mtime = Math.floor(Date.now() / 1000);
    this._notify(this._pathOf(node), "change");
    return 0;
  }

  truncate(path, length) {
    const node = this.resolve(path);
    if (!node) return ENOENT;
    return this._truncateNode(node, length);
  }

  ftruncate(hostFd, length) {
    const e = this.openFiles.get(hostFd);
    if (!e) return EBADF;
    return this._truncateNode(e.node, length);
  }

  // --- Snapshot serialization ---

  serialize() {
    const nodes = [];
    const seen = new Set();
    // One entry per directory entry, keyed by the directory-map name — a
    // hardlinked node emits an entry per alias (same id, possibly different
    // name/parent); only the first carries the data payload.
    const walk = (node, name, parentIno) => {
      const first = !seen.has(node.ino);
      seen.add(node.ino);
      const entry = {
        id: node.ino,
        parentId: parentIno,
        name,
        mode: node.mode,
        nlink: node.nlink,
        size: node.size,
      };
      if (node.mtime != null) entry.mtime = node.mtime;
      if (first && node.data) entry.data = node.data.slice();
      if (node.target !== null) entry.target = node.target;
      nodes.push(entry);
      if (first && node.children) {
        for (const [childName, child] of node.children) {
          walk(child, childName, node.ino);
        }
      }
    };
    walk(this.root, this.root.name, 0);
    return nodes;
  }

  static deserialize(data) {
    const fs = new MemFS();
    // Pass 1: create all nodes by ino. A hardlinked node appears once per
    // directory entry with the same id — the first entry wins, later ones
    // only add extra parent links in pass 2.
    const byId = new Map();
    let maxIno = 0;
    for (const entry of data) {
      if (byId.has(entry.id)) continue;
      const node = new FSNode(entry.name, null, entry.mode, fs);
      node.ino = entry.id;
      node.nlink = entry.nlink;
      node.size = entry.size;
      if (entry.mtime !== undefined) node.mtime = entry.mtime;
      if (entry.data) node.data = new Uint8Array(entry.data);
      if (entry.target !== undefined) node.target = entry.target;
      if (node.isDir) node.children = new Map();
      byId.set(entry.id, node);
      if (entry.id > maxIno) maxIno = entry.id;
    }
    // Pass 2: wire parent/child relationships. Use entry.name as the
    // directory key — a hardlink alias may carry a different basename
    // than node.name.
    for (const entry of data) {
      const node = byId.get(entry.id);
      const parent = entry.parentId ? byId.get(entry.parentId) : node;
      if (!node.parent || node.parent === node) node.parent = parent;
      if (parent && parent !== node && parent.children) {
        parent.children.set(entry.name, node);
      }
    }
    // Set root (first entry is always root)
    fs.root = byId.get(data[0].id);
    fs.root.parent = fs.root;
    // Advance this instance's ino counter past all serialized nodes
    fs._nextIno = maxIno + 1;
    return fs;
  }

  // --- Tar.gz extraction ---

  async loadTarGz(compressedBuffer) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    const chunks = [];
    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();

    writer.write(compressedBuffer);
    writer.close();
    await readAll;

    const totalLen = chunks.reduce((a, c) => a + c.length, 0);
    const tar = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of chunks) {
      tar.set(chunk, pos);
      pos += chunk.length;
    }

    this._parseTar(tar);
  }

  loadTar(tarBuffer) {
    this._parseTar(tarBuffer instanceof Uint8Array ? tarBuffer : new Uint8Array(tarBuffer));
  }

  _parseTar(tar) {
    let offset = 0;
    const decoder = new TextDecoder();
    let gnuLongName = "";
    let gnuLongLink = "";

    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(b => b === 0)) break;

      const nameRaw = decoder.decode(header.subarray(0, 100)).replace(/\0.*/, "");
      const sizeOctal = decoder.decode(header.subarray(124, 136)).replace(/\0.*/, "").trim();
      const typeFlag = String.fromCharCode(header[156]);
      const linkName = decoder.decode(header.subarray(157, 257)).replace(/\0.*/, "");
      const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*/, "");

      const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
      offset += 512;

      // GNU long name extension (type 'L')
      if (typeFlag === "L") {
        gnuLongName = decoder.decode(tar.subarray(offset, offset + size)).replace(/\0.*/, "");
        offset += Math.ceil(size / 512) * 512;
        continue;
      }

      // GNU long link extension (type 'K')
      if (typeFlag === "K") {
        gnuLongLink = decoder.decode(tar.subarray(offset, offset + size)).replace(/\0.*/, "");
        offset += Math.ceil(size / 512) * 512;
        continue;
      }

      const fullName = gnuLongName || (prefix ? prefix + "/" + nameRaw : nameRaw);
      const effectiveLinkName = gnuLongLink || linkName;
      gnuLongName = "";
      gnuLongLink = "";

      const path = "/" + fullName.replace(/^\.\//, "").replace(/\/$/, "");

      if (path === "/" || path === "/.") {
        offset += Math.ceil(size / 512) * 512;
        continue;
      }

      switch (typeFlag) {
        case "5":
          this.createDir(path);
          break;
        case "2":
          this.createSymlink(path, effectiveLinkName);
          break;
        case "0":
        case "\0":
        default: {
          const data = tar.subarray(offset, offset + size);
          const node = this.createFile(path, data);
          const modeOctal = decoder.decode(header.subarray(100, 108)).replace(/\0.*/, "").trim();
          if (modeOctal) {
            const mode = parseInt(modeOctal, 8);
            if (mode & 0o111) node.mode = 0o100755;
          }
          break;
        }
      }

      offset += Math.ceil(size / 512) * 512;
    }
  }

  // --- Seed helpers ---

  createFile(path, content, mode) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    let dir = this.root;
    for (const p of parts) {
      if (!dir.children.has(p)) {
        const d = new FSNode(p, dir, 0o040755, this);
        d.children = new Map();
        d.nlink = 2;
        dir.children.set(p, d);
        dir = d;
      } else {
        dir = dir.children.get(p);
      }
    }
    const enc = new TextEncoder();
    const data = typeof content === "string" ? enc.encode(content) : content;
    // Honor an explicit permission mode when given (e.g. the catalog installer
    // passes 0o755 for executables); default to a regular 0o644 file otherwise.
    const perm = typeof mode === "number" ? mode & 0o7777 : 0o644;
    const node = new FSNode(name, dir, 0o100000 | perm, this);
    node.data = new Uint8Array(data);
    node.size = data.length;
    dir.children.set(name, node);
    this._notify(path, "rename");
    return node;
  }

  createExecutable(path, content) {
    const node = this.createFile(path, content || "");
    node.mode = 0o100755;
    return node;
  }

  createDir(path) {
    const parts = path.split("/").filter(Boolean);
    let dir = this.root;
    for (const p of parts) {
      if (!dir.children.has(p)) {
        const d = new FSNode(p, dir, 0o040755, this);
        d.children = new Map();
        d.nlink = 2;
        dir.children.set(p, d);
        dir = d;
      } else {
        dir = dir.children.get(p);
      }
    }
    return dir;
  }

  createSymlink(path, target) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    let dir = this.root;
    for (const p of parts) {
      if (!dir.children.has(p)) {
        const d = new FSNode(p, dir, 0o040755, this);
        d.children = new Map();
        d.nlink = 2;
        dir.children.set(p, d);
        dir = d;
      } else {
        dir = dir.children.get(p);
      }
    }
    const node = new FSNode(name, dir, 0o120777, this);
    node.target = target;
    node.size = target.length;
    dir.children.set(name, node);
    this._notify(path, "rename");
    return node;
  }
}

export { MemFS, FSNode };
