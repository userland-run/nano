// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * In-memory POSIX-like filesystem for NanoVM test runner.
 * Provides FSNode (inode) and MemFS (filesystem operations) classes.
 */

let _nextIno = 1;

class FSNode {
  constructor(name, parent, mode) {
    this.name = name;
    this.parent = parent;
    this.mode = mode;        // full mode including type bits (S_IFDIR, S_IFREG, etc.)
    this.data = null;        // Uint8Array for files
    this.children = null;    // Map<string, FSNode> for directories
    this.target = null;      // string for symlinks
    this.ino = _nextIno++;
    this.nlink = 1;
    this.size = 0;
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
    this.root = new FSNode("", null, 0o040755);
    this.root.children = new Map();
    this.root.parent = this.root;
    this.openFiles = new Map(); // hostFd -> { node, flags, dirEntries? }
    this.nextHostFd = 100;
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
      node = new FSNode(name, dir, 0o100000 | ((mode & 0o7777) || 0o644));
      node.data = new Uint8Array(0);
      node.size = 0;
      dir.children.set(name, node);
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
    return count;
  }

  // --- Stat ---

  _writeStat(node, wasmMem, bufPhys) {
    new Uint8Array(wasmMem.buffer, bufPhys, 128).fill(0);
    const dv = new DataView(wasmMem.buffer, bufPhys, 128);
    const now = Math.floor(Date.now() / 1000);
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
    const followSymlinks = !(flags & 0x100); // AT_SYMLINK_NOFOLLOW
    const node = this.resolve(path, followSymlinks);
    if (!node) return ENOENT;
    return this._writeStatx(node, wasmMem, bufPhys);
  }

  _writeStatx(node, wasmMem, bufPhys) {
    new Uint8Array(wasmMem.buffer, bufPhys, 256).fill(0);
    const dv = new DataView(wasmMem.buffer, bufPhys, 256);
    const now = Math.floor(Date.now() / 1000);
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
    // stx_atime (offset 64): tv_sec=i64, tv_nsec=u32
    dv.setBigInt64(64, BigInt(now), true);
    // stx_btime (offset 80)
    dv.setBigInt64(80, BigInt(now), true);
    // stx_ctime (offset 96)
    dv.setBigInt64(96, BigInt(now), true);
    // stx_mtime (offset 112)
    dv.setBigInt64(112, BigInt(now), true);
    // stx_dev_major/minor (offset 136)
    dv.setUint32(136, 0, true);
    dv.setUint32(140, 1, true);
    return 0;
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
      // For . and .., get the proper inode
      let ino, dtype;
      if (name === ".") {
        ino = e.node.ino;
        dtype = 4; // DT_DIR
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
      const reclen = (19 + nameBytes.length + 1 + 7) & ~7; // align to 8
      if (off + reclen > bufSize) break;

      const dv = new DataView(wasmMem.buffer, bufPhys + off, reclen);
      dv.setBigUint64(0, BigInt(ino), true);       // d_ino
      dv.setBigInt64(8, BigInt(idx + 1), true);     // d_off (next cookie)
      dv.setUint16(16, reclen, true);               // d_reclen
      dv.setUint8(18, dtype);                       // d_type

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
    const node = this.resolve(path, false); // don't follow final component
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
    if (!name) return EINVAL;
    let dir = this.root;
    for (const p of parts) {
      if (!dir.children || !dir.children.has(p)) return ENOENT;
      dir = dir.children.get(p);
      if (!dir.isDir) return ENOTDIR;
    }
    if (dir.children.has(name)) return EEXIST;
    const newDir = new FSNode(name, dir, 0o040000 | ((mode & 0o7777) || 0o755));
    newDir.children = new Map();
    newDir.nlink = 2;
    dir.children.set(name, newDir);
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
    if (flags & 0x200) { // AT_REMOVEDIR
      if (!node.isDir) return ENOTDIR;
      if (node.children.size > 0) return ENOTEMPTY;
    } else {
      if (node.isDir) return EISDIR;
    }
    dir.children.delete(name);
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
    return 0;
  }

  lseekSize(hostFd) {
    const e = this.openFiles.get(hostFd);
    if (!e) return EBADF;
    return e.node.size;
  }

  // --- Tar.gz extraction ---

  /**
   * Load a tar.gz buffer into the filesystem.
   * Uses DecompressionStream (Node 18+) for gzip, then parses tar (512-byte headers).
   */
  async loadTarGz(compressedBuffer) {
    // Decompress gzip
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

    // Concatenate decompressed chunks
    const totalLen = chunks.reduce((a, c) => a + c.length, 0);
    const tar = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of chunks) {
      tar.set(chunk, pos);
      pos += chunk.length;
    }

    // Parse tar format (POSIX ustar)
    this._parseTar(tar);
  }

  /**
   * Load a tar buffer (uncompressed) into the filesystem.
   * Synchronous variant for when decompression is handled externally.
   */
  loadTar(tarBuffer) {
    this._parseTar(tarBuffer instanceof Uint8Array ? tarBuffer : new Uint8Array(tarBuffer));
  }

  _parseTar(tar) {
    let offset = 0;
    const decoder = new TextDecoder();
    let gnuLongName = "";   // GNU ././@LongLink name override
    let gnuLongLink = "";   // GNU ././@LongLink link target override

    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);

      // Check for end-of-archive (two zero blocks)
      if (header.every(b => b === 0)) break;

      // Parse header fields
      const nameRaw = decoder.decode(header.subarray(0, 100)).replace(/\0.*/, "");
      const sizeOctal = decoder.decode(header.subarray(124, 136)).replace(/\0.*/, "").trim();
      const typeFlag = String.fromCharCode(header[156]);
      const linkName = decoder.decode(header.subarray(157, 257)).replace(/\0.*/, "");
      const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*/, "");

      const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;

      offset += 512; // advance past header

      // GNU long name extension (type 'L'): data block contains the long filename
      if (typeFlag === "L") {
        gnuLongName = decoder.decode(tar.subarray(offset, offset + size)).replace(/\0.*/, "");
        offset += Math.ceil(size / 512) * 512;
        continue;
      }

      // GNU long link extension (type 'K'): data block contains the long link target
      if (typeFlag === "K") {
        gnuLongLink = decoder.decode(tar.subarray(offset, offset + size)).replace(/\0.*/, "");
        offset += Math.ceil(size / 512) * 512;
        continue;
      }

      // Use GNU long name if set, otherwise fall back to prefix+name
      const fullName = gnuLongName || (prefix ? prefix + "/" + nameRaw : nameRaw);
      const effectiveLinkName = gnuLongLink || linkName;
      gnuLongName = "";
      gnuLongLink = "";

      // Normalize: remove leading ./ and trailing /
      const path = "/" + fullName.replace(/^\.\//, "").replace(/\/$/, "");

      if (path === "/" || path === "/.") {
        // Skip root entries
        offset += Math.ceil(size / 512) * 512;
        continue;
      }

      switch (typeFlag) {
        case "5": // directory
          this.createDir(path);
          break;

        case "2": // symlink
          this.createSymlink(path, effectiveLinkName);
          break;

        case "0": // regular file
        case "\0": // regular file (legacy)
        default: {
          const data = tar.subarray(offset, offset + size);
          const node = this.createFile(path, data);
          // Preserve executable bit from tar mode field
          const modeOctal = decoder.decode(header.subarray(100, 108)).replace(/\0.*/, "").trim();
          if (modeOctal) {
            const mode = parseInt(modeOctal, 8);
            if (mode & 0o111) {
              node.mode = 0o100755;
            }
          }
          break;
        }
      }

      // Advance past data blocks (rounded up to 512-byte boundary)
      offset += Math.ceil(size / 512) * 512;
    }
  }

  // --- Seed helpers ---

  createFile(path, content) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    let dir = this.root;
    for (const p of parts) {
      if (!dir.children.has(p)) {
        const d = new FSNode(p, dir, 0o040755);
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
    const node = new FSNode(name, dir, 0o100644);
    node.data = new Uint8Array(data);
    node.size = data.length;
    dir.children.set(name, node);
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
        const d = new FSNode(p, dir, 0o040755);
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
        const d = new FSNode(p, dir, 0o040755);
        d.children = new Map();
        d.nlink = 2;
        dir.children.set(p, d);
        dir = d;
      } else {
        dir = dir.children.get(p);
      }
    }
    const node = new FSNode(name, dir, 0o120777);
    node.target = target;
    node.size = target.length;
    dir.children.set(name, node);
    return node;
  }
}

export { MemFS, FSNode };
