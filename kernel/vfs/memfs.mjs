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
    this.data = null;        // Uint8Array for files
    this.children = null;    // Map<string, FSNode> for directories
    this.target = null;      // string for symlinks
    this.ino = owner ? owner._nextIno++ : _nextIno++;
    this.nlink = 1;
    this.size = 0;
    this.mtime = null;       // seconds since epoch; null = report "now" in stat
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
const ENOTEMPTY = -39;

class MemFS {
  constructor() {
    this._nextIno = 1;
    this.root = new FSNode("", null, 0o040755, this);
    this.root.children = new Map();
    this.root.parent = this.root;
    this.openFiles = new Map(); // hostFd -> { node, flags, dirEntries? }
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

  open(path, flags, mode) {
    let node = this.resolve(path);

    if (!node) {
      if (!(flags & O_CREAT)) return ENOENT;
      const parts = path.split("/").filter(Boolean);
      const name = parts.pop();
      if (!name) return EINVAL;
      let dir = this.root;
      for (const p of parts) {
        if (!dir.children || !dir.children.has(p)) return ENOENT;
        dir = dir.children.get(p);
        if (!dir.isDir) return ENOTDIR;
      }
      node = new FSNode(name, dir, 0o100000 | ((mode & 0o7777) || 0o644), this);
      node.data = new Uint8Array(0);
      node.size = 0;
      dir.children.set(name, node);
      this._notify(this._pathOf(node), "rename");
    }

    if (node.isDir) {
      const hostFd = this.nextHostFd++;
      const entries = [".", "..", ...node.children.keys()];
      this.openFiles.set(hostFd, { node, flags, dirEntries: entries });
      return hostFd;
    }

    if ((flags & O_TRUNC) && node.isFile) {
      node.data = new Uint8Array(0);
      node.size = 0;
      node.mtime = Math.floor(Date.now() / 1000);
      this._notify(this._pathOf(node), "change");
    }

    const hostFd = this.nextHostFd++;
    this.openFiles.set(hostFd, { node, flags });
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
    const src = new Uint8Array(wasmMem.buffer, bufPhys, count);
    const end = offset + count;
    if (!e.node.data || end > e.node.data.length) {
      const newBuf = new Uint8Array(end);
      if (e.node.data) newBuf.set(e.node.data);
      e.node.data = newBuf;
    }
    e.node.data.set(src, offset);
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
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    // No final component means the path is "/" (root), which already exists.
    // Return EEXIST (not EINVAL) so `mkdir -p` treats it as a no-op, not fatal.
    if (!name) return EEXIST;
    let dir = this.root;
    for (const p of parts) {
      if (!dir.children || !dir.children.has(p)) return ENOENT;
      dir = dir.children.get(p);
      if (!dir.isDir) return ENOTDIR;
    }
    if (dir.children.has(name)) return EEXIST;
    const newDir = new FSNode(name, dir, 0o040000 | ((mode & 0o7777) || 0o755), this);
    newDir.children = new Map();
    newDir.nlink = 2;
    dir.children.set(name, newDir);
    this._notify(this._pathOf(newDir), "rename");
    return 0;
  }

  unlink(path, flags) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) return EINVAL;
    let dir = this.root;
    for (const p of parts) {
      if (!dir.children || !dir.children.has(p)) return ENOENT;
      dir = dir.children.get(p);
      if (!dir.isDir) return ENOTDIR;
    }
    if (!dir.children.has(name)) return ENOENT;
    const node = dir.children.get(name);
    if (flags & 0x200) {
      if (!node.isDir) return ENOTDIR;
      if (node.children.size > 0) return ENOTEMPTY;
    } else {
      if (node.isDir) return EISDIR;
      if (node.nlink > 0) node.nlink--;
    }
    dir.children.delete(name);
    this._notify(path, "rename");
    return 0;
  }

  rename(oldpath, newpath) {
    const oldParts = oldpath.split("/").filter(Boolean);
    const oldName = oldParts.pop();
    if (!oldName) return EINVAL;
    let oldDir = this.root;
    for (const p of oldParts) {
      if (!oldDir.children || !oldDir.children.has(p)) return ENOENT;
      oldDir = oldDir.children.get(p);
      if (!oldDir.isDir) return ENOTDIR;
    }
    if (!oldDir.children.has(oldName)) return ENOENT;

    const newParts = newpath.split("/").filter(Boolean);
    const newName = newParts.pop();
    if (!newName) return EINVAL;
    let newDir = this.root;
    for (const p of newParts) {
      if (!newDir.children || !newDir.children.has(p)) return ENOENT;
      newDir = newDir.children.get(p);
      if (!newDir.isDir) return ENOTDIR;
    }

    const node = oldDir.children.get(oldName);
    oldDir.children.delete(oldName);
    node.name = newName;
    node.parent = newDir;
    newDir.children.set(newName, node);
    this._notify(oldpath, "rename");
    this._notify(newpath, "rename");
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
    const end = pos + src.length;
    if (!e.node.data || end > e.node.data.length) {
      const newBuf = new Uint8Array(end);
      if (e.node.data) newBuf.set(e.node.data);
      e.node.data = newBuf;
    }
    e.node.data.set(src, pos);
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
    const parts = newPath.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) return EINVAL;
    let dir = this.root;
    for (const p of parts) {
      if (!dir.children || !dir.children.has(p)) return ENOENT;
      dir = dir.children.get(p);
      if (!dir.isDir) return ENOTDIR;
    }
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
    const data = node.data || new Uint8Array(0);
    if (length !== data.length) {
      const newBuf = new Uint8Array(length);
      newBuf.set(data.subarray(0, Math.min(length, data.length)));
      node.data = newBuf;
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
