// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/errno.mjs — Linux errno numbering shared by every tier.
//
// The VM guest, MemFS, and the Syscall Bus all speak Linux errno values
// (spec UL-SPEC/nodert §5.3). MemFS historically returns them as negative
// integers; the bus carries them positive inside KernelError. Keep both
// conventions convertible through this single table.

const ERRNO = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  ECHILD: 10,
  EAGAIN: 11,
  ENOMEM: 12,
  EACCES: 13,
  EFAULT: 14,
  ENOTBLK: 15,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  ENOTTY: 25,
  ETXTBSY: 26,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  EPIPE: 32,
  EDOM: 33,
  ERANGE: 34,
  EDEADLK: 35,
  ENAMETOOLONG: 36,
  ENOLCK: 37,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  ENOMSG: 42,
  EOVERFLOW: 75,
  ENOTSOCK: 88,
  EDESTADDRREQ: 89,
  EMSGSIZE: 90,
  EPROTOTYPE: 91,
  ENOPROTOOPT: 92,
  EPROTONOSUPPORT: 93,
  ENOTSUP: 95,
  EOPNOTSUPP: 95,
  EAFNOSUPPORT: 97,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  ENETUNREACH: 101,
  ECONNABORTED: 103,
  ECONNRESET: 104,
  ENOBUFS: 105,
  EISCONN: 106,
  ENOTCONN: 107,
  ETIMEDOUT: 110,
  ECONNREFUSED: 111,
  EHOSTUNREACH: 113,
  EALREADY: 114,
  EINPROGRESS: 115,
  ECANCELED: 125,
};

// errno number → symbolic name (first name wins for aliases like ENOTSUP).
const ERRNO_NAMES = {};
for (const [name, num] of Object.entries(ERRNO)) {
  if (!(num in ERRNO_NAMES)) ERRNO_NAMES[num] = name;
}

/**
 * Kernel-level error carried across the Syscall Bus (§5.3).
 * `errno` is the positive Linux number; `name` the symbolic name
 * (or a machine-readable override such as "ERR_CAP_DENIED").
 * Capability denials set `capability` so tooling can distinguish
 * policy from filesystem permissions.
 */
class KernelError extends Error {
  /**
   * @param {number} errno positive Linux errno
   * @param {string} [name] symbolic name override
   * @param {string} [message]
   * @param {string} [capability] capability facet that denied the op
   */
  constructor(errno, name, message, capability) {
    super(message || name || ERRNO_NAMES[errno] || `errno ${errno}`);
    this.errno = errno;
    this.name = name || ERRNO_NAMES[errno] || `E${errno}`;
    // Node's errors expose `.code` (the string errno name, e.g. "ENOENT");
    // libraries branch on it (y18n, graceful-fs, …). Mirror it so guest code
    // treating a Kernel error like a Node error works.
    this.code = this.name;
    if (capability !== undefined) this.capability = capability;
  }

  /** Negative-integer convention used by MemFS/the VM a0 register. */
  get negative() {
    return -this.errno;
  }

  /** Build from a MemFS-style negative return value. */
  static fromNegative(value, message) {
    return new KernelError(-value, undefined, message);
  }

  /** Capability denial per §5.3: EACCES + ERR_CAP_DENIED + capability. */
  static capDenied(capability, message) {
    return new KernelError(ERRNO.EACCES, "ERR_CAP_DENIED", message, capability);
  }

  /** Plain-object form for structured-clone transports. */
  toJSON() {
    const o = { errno: this.errno, name: this.name };
    if (this.message && this.message !== this.name) o.message = this.message;
    if (this.capability !== undefined) o.capability = this.capability;
    return o;
  }

  /** @param {{errno:number,name?:string,message?:string,capability?:string}} o */
  static fromJSON(o) {
    return new KernelError(o.errno, o.name, o.message, o.capability);
  }
}

export { ERRNO, ERRNO_NAMES, KernelError };
