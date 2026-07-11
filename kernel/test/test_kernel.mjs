#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Unit tests for the Kernel scaffold (kernel/): errno table, KernelError,
 * opcode registry, Kernel construction. Pure Node.js — no WASM needed.
 *
 * Usage: node test/kernel/test_kernel.mjs
 */
import {
  Kernel,
  ERRNO,
  ERRNO_NAMES,
  KernelError,
  PROTOCOL_MAJOR,
  NS,
  OP,
  OP_NAMES,
  opNamespace,
} from "../index.mjs";

let passed = 0;
let failed = 0;
let current = "";

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${current} - ${msg}`);
    failed++;
    return false;
  }
  return true;
}

function assertEqual(a, b, msg) {
  if (a !== b) {
    console.error(`  FAIL: ${current} - ${msg}: expected ${b}, got ${a}`);
    failed++;
    return false;
  }
  return true;
}

function test(name, fn) {
  current = name;
  const before = failed;
  try {
    fn();
    if (failed === before) {
      passed++;
      console.log(`  PASS: ${name}`);
    }
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name} - threw ${e.message}`);
  }
}

// ============================================================
// errno
// ============================================================

test("errno numbers match Linux (and MemFS negatives)", () => {
  // The values MemFS hardcodes as negatives (container/memfs.mjs).
  assertEqual(ERRNO.ENOENT, 2, "ENOENT");
  assertEqual(ERRNO.EBADF, 9, "EBADF");
  assertEqual(ERRNO.EEXIST, 17, "EEXIST");
  assertEqual(ERRNO.ENOTDIR, 20, "ENOTDIR");
  assertEqual(ERRNO.EISDIR, 21, "EISDIR");
  assertEqual(ERRNO.EINVAL, 22, "EINVAL");
  assertEqual(ERRNO.EMFILE, 24, "EMFILE");
  assertEqual(ERRNO.ENOSPC, 28, "ENOSPC");
  assertEqual(ERRNO.ENOTEMPTY, 39, "ENOTEMPTY");
  // Values nanovm.mjs uses in the run loop / execve.
  assertEqual(ERRNO.EINTR, 4, "EINTR");
  assertEqual(ERRNO.ENOEXEC, 8, "ENOEXEC");
  assertEqual(ERRNO.ECHILD, 10, "ECHILD");
  assertEqual(ERRNO.EACCES, 13, "EACCES");
});

test("errno reverse map prefers canonical names", () => {
  assertEqual(ERRNO_NAMES[2], "ENOENT", "2 → ENOENT");
  assertEqual(ERRNO_NAMES[95], "ENOTSUP", "95 → ENOTSUP (not EOPNOTSUPP)");
});

// ============================================================
// KernelError
// ============================================================

test("KernelError basic shape", () => {
  const e = new KernelError(ERRNO.ENOENT);
  assertEqual(e.errno, 2, "errno");
  assertEqual(e.name, "ENOENT", "name");
  assertEqual(e.negative, -2, "negative form");
  assert(e instanceof Error, "instanceof Error");
});

test("KernelError.fromNegative round-trips MemFS returns", () => {
  const e = KernelError.fromNegative(-17);
  assertEqual(e.errno, 17, "errno");
  assertEqual(e.name, "EEXIST", "name");
});

test("KernelError.capDenied per §5.3", () => {
  const e = KernelError.capDenied("fs.scopes", "denied /etc");
  assertEqual(e.errno, ERRNO.EACCES, "EACCES");
  assertEqual(e.name, "ERR_CAP_DENIED", "machine-readable name");
  assertEqual(e.capability, "fs.scopes", "capability field");
});

test("KernelError JSON round-trip (structured-clone transport)", () => {
  const e = KernelError.capDenied("net.fetchHosts", "blocked host");
  const back = KernelError.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  assertEqual(back.errno, e.errno, "errno");
  assertEqual(back.name, e.name, "name");
  assertEqual(back.capability, e.capability, "capability");
  assertEqual(back.message, e.message, "message");
});

// ============================================================
// opcodes
// ============================================================

test("opcode namespaces per §5.2", () => {
  assertEqual(opNamespace(OP["fs.open"]), NS.fs, "fs.open in fs ns");
  assertEqual(opNamespace(OP["proc.spawn"]), NS.proc, "proc.spawn in proc ns");
  assertEqual(opNamespace(OP["net.fetch_open"]), NS.net, "net.fetch_open in net ns");
  assertEqual(opNamespace(OP["svc.invoke"]), NS.svc, "svc.invoke in svc ns");
  assertEqual(opNamespace(OP["env.get"]), NS.env, "env.get in env ns");
  assertEqual(opNamespace(OP["sys.caps_query"]), NS.sys, "sys.caps_query in sys ns");
});

test("opcodes are unique u16 values with a complete reverse map", () => {
  const values = Object.values(OP);
  const unique = new Set(values);
  assertEqual(unique.size, values.length, "no duplicate opcode values");
  for (const v of values) {
    assert(Number.isInteger(v) && v > 0 && v <= 0xffff, `u16 range: ${v}`);
    assert(OP_NAMES[v] !== undefined, `reverse map has ${v}`);
  }
  for (const [name, v] of Object.entries(OP)) {
    assertEqual(OP_NAMES[v], name, `reverse(${v}) === ${name}`);
  }
});

// ============================================================
// Kernel
// ============================================================

test("Kernel constructs with defaults", () => {
  const k = new Kernel();
  assertEqual(k.protocol.major, PROTOCOL_MAJOR, "protocol major");
  assert(k.opts !== undefined, "opts stored");
  // Subsystems are phase-gated; scaffold exposes the slots.
  for (const slot of ["vfs", "proc", "caps", "hub", "ports", "fetchBridge", "signals", "services"]) {
    assert(slot in k, `has slot ${slot}`);
  }
});

// ============================================================
// Summary
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
