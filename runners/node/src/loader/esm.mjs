// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/loader/esm.mjs — the blob-URL ESM loader (spec §9.2). Real host
// ESM semantics (live bindings, TLA, correct order): resolve the graph over
// the VFS, then build module URLs SCC-by-SCC in reverse-topological order.
// Acyclic modules become one URL each with their specifiers rewritten to
// child URLs; a multi-node strongly-connected component (mutually-recursive
// modules) is CONCATENATED into a single module so the cycle is intra-module
// and the host engine resolves it natively (DIV-ESM-CYCLE covers the residual
// differences: shared module scope, so top-level name collisions across cycle
// members are the caller's responsibility). TypeScript is type-stripped via
// the SWC Kernel Service; dynamic import() routes through the loader at
// runtime; import.meta is patched per module.

import { scanEsm, initScanner } from "./scan.mjs";
import { createModuleUrl } from "../platform.mjs";

function createEsmLoader(host) {
  const revokers = [];
  const builtinFacades = new Map();
  const builtinNames = new Map(); // builtin → Set of named imports requested by the graph
  /** @type {Map<string, string>} realpath → module URL (after build) */
  const urls = new Map();

  globalThis.__nodert_require = globalThis.__nodert_require; // set by boot
  globalThis.__nodert_import = async (spec, fromPath) => {
    const resolved = resolveSpec(spec, fromPath);
    if (resolved.builtin) return import(builtinFacade(resolved.builtin));
    const url = await buildFrom(resolved.path);
    return import(url);
  };
  // Curried form so the rewrite can turn `import(` into a span-based prefix
  // without needing the closing paren: `import(X)` → `__nodert_import2(base)(X)`.
  globalThis.__nodert_import2 = (fromPath) => (spec) => globalThis.__nodert_import(spec, fromPath);

  // ---- resolution ----
  function resolveSpec(spec, fromPath) {
    if (spec.startsWith("node:") || isBareBuiltin(spec)) return { builtin: spec.replace(/^node:/, "") };
    if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
      const base = fromPath ? dirname(fromPath) : host.cwd;
      return { path: resolveFile(spec.startsWith("/") ? spec : join(base, spec)) };
    }
    return { path: resolveBare(spec, fromPath ? dirname(fromPath) : host.cwd) };
  }
  function resolveFile(p) {
    p = normalize(p);
    const exts = ["", ".mjs", ".js", ".ts", ".mts", ".json", ".cjs"];
    for (const e of exts) if (host.exists(p + e) && !host.isDir(p + e)) return host.realpath(p + e);
    if (host.isDir(p)) {
      for (const idx of ["/index.mjs", "/index.js", "/index.ts"]) if (host.exists(p + idx)) return host.realpath(p + idx);
      if (host.exists(p + "/package.json")) {
        const pkg = JSON.parse(host.readFile(p + "/package.json"));
        const main = pkg.exports?.["."] ?? pkg.module ?? pkg.main ?? "index.js";
        const m = typeof main === "string" ? main : main?.import ?? main?.default;
        if (m) return resolveFile(join(p, m));
      }
    }
    throw moduleNotFound(p);
  }
  function resolveBare(spec, fromDir) {
    let dir = fromDir;
    for (;;) {
      const base = join(dir, "node_modules/" + spec);
      if (host.exists(base) || host.exists(base + ".mjs") || host.exists(base + ".js")) return resolveFile(base);
      if (dir === "/" || dir === "") break;
      dir = dirname(dir);
    }
    throw moduleNotFound(spec);
  }

  // ---- graph: path → { source(after type-strip), json, cjs, scan, deps:[...] } ----
  function loadModule(path) {
    const raw = host.readFile(path);
    const json = path.endsWith(".json");
    if (json) return { path, json: true, cjs: false, source: `export default ${raw};`, scan: { statics: [], dynamics: [], hasImportMeta: false }, deps: [] };
    let source = raw;
    if (/\.ts$|\.mts$/.test(path)) source = host.stripTypes(source);
    const scan = scanEsm(source);
    // A resolved file with no ESM syntax that uses CommonJS is a CJS dependency
    // (§9.2 step 5): wrap it as an ESM facade re-exporting module.exports.
    const isCjs = !path.endsWith(".mjs") && scan.statics.length === 0 && scan.dynamics.length === 0 &&
      !/(^|\n)\s*export\s/.test(source) && /(module\.exports|exports\.|require\s*\()/.test(source);
    if (isCjs) return { path, json: false, cjs: true, source, scan: { statics: [], dynamics: [], hasImportMeta: false }, deps: [] };
    const deps = scan.statics.map((s) => ({ ...resolveSpec(s.spec, path), spec: s.spec, start: s.start, end: s.end }));
    // Record the NAMED imports requested from each builtin, so its facade can
    // declare exactly those names (missing ones resolve to undefined → the
    // module LINKS and only fails if the name is actually used — real apps
    // import more of a builtin than a lean shim provides).
    for (let i = 0; i < deps.length; i++) {
      if (!deps[i].builtin) continue;
      const set = builtinNames.get(deps[i].builtin) ?? (builtinNames.set(deps[i].builtin, new Set()), builtinNames.get(deps[i].builtin));
      for (const n of namedImportsOf(scan.statics[i].clause ?? "")) set.add(n);
    }
    return { path, json: false, cjs: false, source, scan, deps };
  }

  function resolveGraph(entryPath) {
    const graph = new Map();
    const visit = (path) => {
      if (graph.has(path)) return;
      const mod = loadModule(path);
      graph.set(path, mod);
      for (const d of mod.deps) if (d.path && !d.builtin) visit(d.path);
    };
    visit(entryPath);
    return graph;
  }

  // Tarjan SCC over the path graph.
  function tarjan(graph) {
    let index = 0; const stack = []; const onStack = new Set();
    const idx = new Map(), low = new Map(); const sccs = [];
    const strongconnect = (v) => {
      idx.set(v, index); low.set(v, index); index++; stack.push(v); onStack.add(v);
      for (const d of graph.get(v).deps) {
        const w = d.path; if (!w || d.builtin) continue;
        if (!idx.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = []; let w;
        do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
        sccs.push(comp);
      }
    };
    for (const v of graph.keys()) if (!idx.has(v)) strongconnect(v);
    return sccs; // already in reverse-topological order
  }

  // ---- build module URLs SCC-by-SCC ----
  async function buildFrom(entryPath) {
    if (urls.has(entryPath)) return urls.get(entryPath);
    const graph = resolveGraph(entryPath);
    for (const scc of tarjan(graph)) {
      if (scc.length === 1 && !selfCyclic(graph, scc[0])) buildSingle(graph, scc[0]);
      else buildScc(graph, scc);
    }
    return urls.get(entryPath);
  }

  function selfCyclic(graph, path) {
    return graph.get(path).deps.some((d) => d.path === path);
  }

  function depUrl(graph, dep) {
    if (dep.builtin) return builtinFacade(dep.builtin);
    return urls.get(dep.path); // already built (reverse-topo) or same-SCC (patched)
  }

  function buildSingle(graph, path) {
    const mod = graph.get(path);
    let rewritten;
    if (mod.cjs) rewritten = cjsFacadeSource(path);
    else if (mod.json) rewritten = mod.source;
    else rewritten = rewriteModule(mod, (dep) => JSON.stringify(depUrl(graph, dep)));
    const { url, revoke } = createModuleUrl(rewritten);
    urls.set(path, url); revokers.push(revoke);
  }

  // ESM facade for a CJS user module: default = module.exports, plus named
  // exports for each own identifier-keyed property (cjs-module-lexer-lite).
  function cjsFacadeSource(path) {
    let named = [];
    try {
      const m = globalThis.__nodert_require_path(path);
      named = (m && typeof m === "object") ? Object.keys(m).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default") : [];
    } catch { /* default only */ }
    return `const m = globalThis.__nodert_require_path(${JSON.stringify(path)});\n` +
      `export default (m && m.__esModule && m.default !== undefined) ? m.default : m;\n` +
      named.map((k) => `export const ${k} = m[${JSON.stringify(k)}];`).join("\n") + "\n";
  }

  // Concatenate a multi-node SCC into one module: intra-SCC imports are dropped
  // (their bindings come from a sibling in the same module scope), extra-SCC
  // and builtin imports keep their URLs. Members are wrapped so re-exports and
  // import.meta still work; the entry member's exports become the module's.
  function buildScc(graph, scc) {
    const members = scc.map((p) => graph.get(p));
    const inScc = new Set(scc);
    const pieces = [];
    for (const mod of members) {
      let src = rewriteModule(mod, (dep) =>
        dep.path && inScc.has(dep.path)
          ? null // drop the intra-cycle import statement entirely
          : JSON.stringify(depUrl(graph, dep))
      );
      pieces.push(`// --- ${mod.path} ---\n${src}`);
    }
    const combined = pieces.join("\n");
    const { url, revoke } = createModuleUrl(combined);
    revokers.push(revoke);
    for (const p of scc) urls.set(p, url);
  }

  // Rewrite a module's specifiers using `urlFor(dep) → JSON-string | null`.
  // A null result means "remove this import statement" (intra-SCC edge).
  function rewriteModule(mod, urlFor) {
    let out = mod.source;
    const base = JSON.stringify("file://" + mod.path);
    const edits = [];
    // Static import specifiers → facade/module URLs.
    for (let i = 0; i < mod.scan.statics.length; i++) {
      const s = mod.scan.statics[i];
      const rep = urlFor(mod.deps[i]);
      if (rep === null) edits.push({ removeStatement: true, specStart: s.start, specEnd: s.end });
      else edits.push({ start: s.start, end: s.end, rep });
    }
    // Dynamic import() → the curried host importer. SPAN-BASED off the scanner
    // positions, so `import(` text inside string literals is never touched
    // (a global regex here corrupts real-world minified bundles — "Unexpected
    // string"). `import(` → `globalThis.__nodert_import2(<base>)(`.
    for (const d of mod.scan.dynamics) {
      if (d.keywordStart == null) continue;
      edits.push({ start: d.keywordStart, end: d.parenStart + 1, rep: `globalThis.__nodert_import2(${base})(` });
    }
    // Apply all edits back-to-front on the original source (positions stay valid).
    edits.sort((a, b) => (b.specStart ?? b.start) - (a.specStart ?? a.start));
    for (const e of edits) {
      if (e.removeStatement) {
        const [stmtStart, stmtEnd] = statementSpan(out, e.specStart, e.specEnd);
        out = out.slice(0, stmtStart) + out.slice(stmtEnd);
      } else {
        out = out.slice(0, e.start) + e.rep + out.slice(e.end);
      }
    }
    if (mod.scan.hasImportMeta) {
      // `import.meta` is an identifier, not inside a string in practice; keep the
      // global replace but only outside string spans via a strings-aware pass.
      out = `const __nodert_meta = { url: ${base}, resolve: (s) => new URL(s, ${base}).href };\n` +
        replaceOutsideStrings(out, /\bimport\.meta\b/g, "__nodert_meta");
    }
    return out;
  }

  function builtinFacade(name) {
    if (builtinFacades.has(name)) return builtinFacades.get(name);
    let named = new Set();
    try {
      const mod = globalThis.__nodert_require(name);
      const dflt = mod && mod.__esModule && mod.default !== undefined ? mod.default : mod;
      for (const k of Object.keys(dflt ?? {})) if (/^[A-Za-z_$][\w$]*$/.test(k) && k !== "default") named.add(k);
    } catch { /* default only */ }
    // Also declare the names the graph actually imports from this builtin, even
    // if the lean shim lacks them — they resolve to undefined so the module
    // LINKS (only a real *use* would then fail). Avoids "does not provide an
    // export named X" for real apps that import more than the shim provides.
    for (const k of builtinNames.get(name.replace(/^node:/, "")) ?? []) if (k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k)) named.add(k);
    named = [...named];
    const src =
      `const m0 = globalThis.__nodert_require(${JSON.stringify(name)});\n` +
      `const m = (m0 && m0.__esModule && m0.default !== undefined) ? m0.default : m0;\n` +
      `export default m;\n` +
      named.map((k) => `export const ${k} = m[${JSON.stringify(k)}];`).join("\n") + "\n";
    const { url, revoke } = createModuleUrl(src);
    revokers.push(revoke);
    builtinFacades.set(name, url);
    return url;
  }

  async function run(entryPath) {
    await initScanner(); // the specifier lexer (wasm) must be ready before scanning
    const url = await buildFrom(host.realpath(entryPath));
    return import(url);
  }
  async function evalModule(source, virtualPath = "/[eval].mjs") {
    await initScanner();
    const src = /\.ts$|\.mts$/.test(virtualPath) ? host.stripTypes(source) : source;
    const scan = scanEsm(src);
    const deps = scan.statics.map((s) => ({ ...resolveSpec(s.spec, virtualPath), spec: s.spec, start: s.start, end: s.end }));
    for (const d of deps) if (d.path && !d.builtin) await buildFrom(d.path);
    const mod = { path: virtualPath, source: src, scan, deps, json: false };
    const rewritten = rewriteModule(mod, (dep) => JSON.stringify(dep.builtin ? builtinFacade(dep.builtin) : urls.get(dep.path)));
    const { url } = createModuleUrl(rewritten);
    return import(url);
  }

  function dispose() { for (const r of revokers) try { r(); } catch {} revokers.length = 0; urls.clear(); }
  return { run, evalModule, dispose, _urls: urls };
}

function statementSpan(src, specStart, specEnd) {
  // Widen the specifier span to the whole import/export statement (back to the
  // line-starting import/export keyword, forward past an optional ';').
  let start = specStart;
  while (start > 0 && src[start - 1] !== "\n") start--;
  let end = specEnd;
  while (end < src.length && src[end] !== "\n") { if (src[end] === ";") { end++; break; } end++; }
  return [start, end];
}

// Apply a /g regex replacement to `src` ONLY outside string/template literals
// and comments — so identifier rewrites (import.meta) never touch look-alike
// text inside strings.
function replaceOutsideStrings(src, re, rep) {
  let out = "", i = 0; const n = src.length;
  const skipStr = (s, p) => { const q = s[p]; let k = p + 1; while (k < n) { const ch = s[k]; if (ch === "\\") { k += 2; continue; } if (ch === q) return k + 1; k++; } return n; };
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { const e = skipStr(src, i); out += src.slice(i, e); i = e; continue; }
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); const end = e === -1 ? n : e; out += src.slice(i, end); i = end; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const end = e === -1 ? n : e + 2; out += src.slice(i, end); i = end; continue; }
    let j = i;
    while (j < n) { const d = src[j]; if (d === '"' || d === "'" || d === "`" || (d === "/" && (src[j + 1] === "/" || src[j + 1] === "*"))) break; j++; }
    out += src.slice(i, j).replace(re, rep);
    i = j;
  }
  return out;
}

// Parse the imported (source) names from an import/export clause, e.g.
// `import{createRequire as x, readFile}from` → ["createRequire", "readFile"].
// Only the `{ … }` named group matters (default/namespace never link-fail).
function namedImportsOf(clause) {
  const m = /\{([^}]*)\}/.exec(clause);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

function dirname(p) { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); }
function join(a, b) { if (b.startsWith("/")) return normalize(b); return normalize((a.endsWith("/") ? a : a + "/") + b); }
function normalize(p) {
  const parts = []; const abs = p.startsWith("/");
  for (const seg of p.split("/")) { if (seg === "" || seg === ".") continue; if (seg === "..") parts.pop(); else parts.push(seg); }
  return (abs ? "/" : "") + parts.join("/");
}
// Node's canonical builtin module set (v25), including the subpath forms
// (fs/promises, stream/promises, path/posix, …) real apps import. A name here
// is resolved as a BUILTIN (never a file); whether it is actually implemented
// is a separate concern handled by the binding/shim layer.
const NODE_BUILTINS = new Set([
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns",
  "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2",
  "https", "inspector", "inspector/promises", "module", "net", "os", "path",
  "path/posix", "path/win32", "perf_hooks", "process", "punycode", "querystring",
  "readline", "readline/promises", "repl", "stream", "stream/consumers",
  "stream/promises", "stream/web", "string_decoder", "sys", "timers",
  "timers/promises", "tls", "trace_events", "tty", "url", "util", "util/types",
  "v8", "vm", "wasi", "worker_threads", "zlib",
]);
function isBareBuiltin(spec) {
  return NODE_BUILTINS.has(spec.replace(/^node:/, ""));
}
function moduleNotFound(p) { const e = new Error(`Cannot find module '${p}'`); e.code = "ERR_MODULE_NOT_FOUND"; return e; }

export { createEsmLoader };
