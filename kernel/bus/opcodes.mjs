// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/bus/opcodes.mjs — Syscall Bus opcode registry (spec §5.2).
//
// Opcodes are u16: high byte = namespace, low byte = operation.
// Every opcode is available on both planes (sync SAB / async MessagePort)
// with identical request/response schemas; the plane is a transport choice.
//
// Adding an opcode requires: an entry here, a capability mapping in
// kernel/caps/caps.mjs, a handler in the hub, and a conformance test.

const PROTOCOL_MAJOR = 1;
const PROTOCOL_MINOR = 0;

const NS = {
  fs: 0x01,
  proc: 0x02,
  net: 0x03,
  svc: 0x04,
  env: 0x05,
  sys: 0x06,
};

/** @param {number} ns @param {number} op */
const code = (ns, op) => (ns << 8) | op;

const OP = {
  // fs.* — §5.2
  "fs.open": code(NS.fs, 0x01),
  "fs.read": code(NS.fs, 0x02),
  "fs.write": code(NS.fs, 0x03),
  "fs.close": code(NS.fs, 0x04),
  "fs.stat": code(NS.fs, 0x05),
  "fs.lstat": code(NS.fs, 0x06),
  "fs.fstat": code(NS.fs, 0x07),
  "fs.readdir": code(NS.fs, 0x08),
  "fs.mkdir": code(NS.fs, 0x09),
  "fs.unlink": code(NS.fs, 0x0a),
  "fs.rename": code(NS.fs, 0x0b),
  "fs.symlink": code(NS.fs, 0x0c),
  "fs.readlink": code(NS.fs, 0x0d),
  "fs.realpath": code(NS.fs, 0x0e),
  "fs.link": code(NS.fs, 0x0f),
  "fs.truncate": code(NS.fs, 0x10),
  "fs.chmod": code(NS.fs, 0x11),
  "fs.utimes": code(NS.fs, 0x12),
  "fs.copyfile": code(NS.fs, 0x13),
  "fs.watch": code(NS.fs, 0x14),
  "fs.unwatch": code(NS.fs, 0x15),
  "fs.access": code(NS.fs, 0x16),

  // proc.*
  "proc.spawn": code(NS.proc, 0x01),
  "proc.waitpid": code(NS.proc, 0x02),
  "proc.exit": code(NS.proc, 0x03),
  "proc.kill": code(NS.proc, 0x04),
  "proc.getcwd": code(NS.proc, 0x05),
  "proc.chdir": code(NS.proc, 0x06),
  "proc.pipe": code(NS.proc, 0x07),
  "proc.dup": code(NS.proc, 0x08),
  "proc.list": code(NS.proc, 0x09),
  "proc.stdio_write": code(NS.proc, 0x0a),
  "proc.stdio_read": code(NS.proc, 0x0b),
  "proc.pipe_write": code(NS.proc, 0x0c),
  "proc.pipe_read": code(NS.proc, 0x0d),
  "proc.pipe_close": code(NS.proc, 0x0e),

  // net.*
  "net.listen": code(NS.net, 0x01),
  "net.close_listener": code(NS.net, 0x02),
  "net.connect_loopback": code(NS.net, 0x03),
  "net.accept": code(NS.net, 0x04),
  "net.sock_read": code(NS.net, 0x05),
  "net.sock_write": code(NS.net, 0x06),
  "net.sock_shutdown": code(NS.net, 0x07),
  "net.resolve": code(NS.net, 0x08),
  "net.fetch_open": code(NS.net, 0x09),
  "net.fetch_read": code(NS.net, 0x0a),
  "net.fetch_abort": code(NS.net, 0x0b),

  // svc.*
  "svc.invoke": code(NS.svc, 0x01),
  "svc.open_session": code(NS.svc, 0x02),
  "svc.close_session": code(NS.svc, 0x03),
  "svc.list": code(NS.svc, 0x04),

  // env.*
  "env.get_all": code(NS.env, 0x01),
  "env.get": code(NS.env, 0x02),
  "env.set": code(NS.env, 0x03),

  // sys.*
  "sys.clock": code(NS.sys, 0x01),
  "sys.hrtime": code(NS.sys, 0x02),
  "sys.random": code(NS.sys, 0x03),
  "sys.log": code(NS.sys, 0x04),
  "sys.caps_query": code(NS.sys, 0x05),
  "sys.arm_wake": code(NS.sys, 0x06), // Kernel-armed timer wake (nodert loop backstop)
};

// opcode number → dotted name
const OP_NAMES = {};
for (const [name, num] of Object.entries(OP)) OP_NAMES[num] = name;

/** @param {number} opcode */
const opNamespace = (opcode) => opcode >> 8;

export { PROTOCOL_MAJOR, PROTOCOL_MINOR, NS, OP, OP_NAMES, opNamespace };
