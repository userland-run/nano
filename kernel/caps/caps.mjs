// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/caps/caps.mjs — the capability engine (spec §7.3).
// Enforcement point is the Syscall Bus dispatch (P4): checkCap() runs in the
// Kernel before any subsystem handler. Attenuation (capsIsSubset) runs at
// proc.spawn — a child's capabilities must be a subset of its parent's.

import { KernelError } from "../errno.mjs";
import { NS, opNamespace, OP } from "../bus/opcodes.mjs";
import { boaDefault } from "./profiles.mjs";

const FS_MODE_RANK = { none: 0, readonly: 1, readwrite: 2 };

/** Fill a partial Capabilities record with deny-by-default values. */
function normalizeCaps(partial) {
  const base = boaDefault();
  if (!partial) return base;
  return {
    fs: { ...base.fs, ...partial.fs },
    net: { ...base.net, ...partial.net },
    spawn: { ...base.spawn, ...partial.spawn },
    services: partial.services ?? base.services,
    env: partial.env ?? base.env,
    stdio: partial.stdio ?? base.stdio,
  };
}

/** Is `path` inside one of `scopes` (path prefixes)? Absent scopes = whole tree. */
function inScopes(scopes, path) {
  if (!scopes) return true;
  return scopes.some((s) => path === s || path.startsWith(s.endsWith("/") ? s : s + "/"));
}

function scopesCover(parentScopes, childScopes) {
  if (!parentScopes) return true; // parent covers the whole tree
  if (!childScopes) return false; // child asks for the whole tree, parent is scoped
  return childScopes.every((c) => inScopes(parentScopes, c));
}

function listenCovers(parent, child) {
  if (parent === true) return true;
  if (child === false) return true;
  if (parent === false) return false;
  if (child === true) return false; // child wants any port, parent has a whitelist
  return child.every((p) => parent.includes(p));
}

function fetchHostsCover(parent, child) {
  if (parent === "all") return true;
  if (child === "none") return true;
  if (parent === "none") return false;
  if (child === "all") return false;
  return child.every((h) => parent.includes(h));
}

function servicesCover(parent, child) {
  if (parent.includes("*")) return true;
  return child.every((s) => s !== "*" && parent.includes(s));
}

function envCovers(parent, child) {
  if (child === "none") return true;
  if (parent === "none") return false;
  return true; // inherit/explicit records under an inherit/record parent
}

/**
 * @param {import("../types.d.mts").Capabilities} child
 * @param {import("../types.d.mts").Capabilities} parent
 * @returns {string | null} the violated facet, or null if child ⊆ parent
 */
function capsSubsetViolation(child, parent) {
  if (FS_MODE_RANK[child.fs.mode] > FS_MODE_RANK[parent.fs.mode]) return "fs.mode";
  if (child.fs.mode !== "none" && !scopesCover(parent.fs.scopes, child.fs.scopes)) return "fs.scopes";
  if (!fetchHostsCover(parent.net.fetchHosts, child.net.fetchHosts)) return "net.fetchHosts";
  if (!listenCovers(parent.net.listen, child.net.listen)) return "net.listen";
  if (child.net.loopbackConnect && !parent.net.loopbackConnect) return "net.loopbackConnect";
  for (const tier of ["node", "vm", "boa", "wasm"]) {
    if (child.spawn[tier] && !parent.spawn[tier]) return `spawn.${tier}`;
  }
  if (!servicesCover(parent.services, child.services)) return "services";
  if (!envCovers(parent.env, child.env)) return "env";
  return null;
}

const capsIsSubset = (child, parent) => capsSubsetViolation(child, parent) === null;

// fs opcodes that mutate (need readwrite; the rest need readonly).
const FS_WRITE_OPS = new Set(
  ["fs.write", "fs.mkdir", "fs.unlink", "fs.rename", "fs.symlink", "fs.link",
   "fs.truncate", "fs.chmod", "fs.utimes", "fs.copyfile"].map((n) => OP[n])
);

/**
 * Check one bus request against a process's capabilities (spec P4).
 * @param {number} opcode
 * @param {any} args decoded request args (path/url/port/tier/service fields)
 * @param {import("../types.d.mts").Capabilities} caps
 * @throws {KernelError} EACCES/ERR_CAP_DENIED with the capability facet
 */
function checkCap(opcode, args, caps) {
  const ns = opNamespace(opcode);
  switch (ns) {
    case NS.fs: {
      const need = FS_WRITE_OPS.has(opcode) ? "readwrite" : "readonly";
      if (FS_MODE_RANK[caps.fs.mode] < FS_MODE_RANK[need]) {
        throw KernelError.capDenied("fs.mode", `fs requires ${need}`);
      }
      for (const p of [args?.path, args?.path2]) {
        if (p !== undefined && !inScopes(caps.fs.scopes, p)) {
          throw KernelError.capDenied("fs.scopes", `${p} outside fs scopes`);
        }
      }
      return;
    }
    case NS.net: {
      if (opcode === OP["net.listen"]) {
        const l = caps.net.listen;
        const ok = l === true || (Array.isArray(l) && l.includes(args?.port));
        if (!ok) throw KernelError.capDenied("net.listen", `port ${args?.port}`);
        return;
      }
      if (opcode === OP["net.connect_loopback"]) {
        if (!caps.net.loopbackConnect) throw KernelError.capDenied("net.loopbackConnect");
        return;
      }
      if (opcode === OP["net.fetch_open"]) {
        const hosts = caps.net.fetchHosts;
        if (hosts === "all") return;
        let host = "";
        try {
          host = new URL(args?.url).hostname;
        } catch {
          throw KernelError.capDenied("net.fetchHosts", `bad url ${args?.url}`);
        }
        if (hosts === "none" || !hosts.includes(host)) {
          throw KernelError.capDenied("net.fetchHosts", host);
        }
        return;
      }
      return; // reads on established sockets/streams were checked at open
    }
    case NS.proc: {
      if (opcode === OP["proc.spawn"]) {
        const tier = args?.tier ?? "vm";
        if (!caps.spawn[tier]) throw KernelError.capDenied(`spawn.${tier}`);
      }
      return;
    }
    case NS.svc: {
      if (opcode === OP["svc.invoke"] || opcode === OP["svc.open_session"]) {
        if (!servicesCover(caps.services, [args?.service])) {
          throw KernelError.capDenied("services", args?.service);
        }
      }
      return;
    }
    default:
      return; // env.* / sys.* are always allowed
  }
}

export { normalizeCaps, capsIsSubset, capsSubsetViolation, checkCap, inScopes };
