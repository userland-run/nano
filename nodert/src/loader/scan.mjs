// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/loader/scan.mjs — a lean ES-module specifier scanner for the
// blob-URL loader (spec §9.2 step 2). Finds static import/export-from
// specifier strings (to rewrite to module URLs), dynamic import() calls (to
// route through the loader at runtime), and import.meta usage. String-aware:
// specifiers inside strings/templates/comments/regex are never matched.

/**
 * @param {string} src
 * @returns {{ statics: Array<{start:number,end:number,spec:string}>,
 *             dynamics: Array<{argStart:number,argEnd:number,spec:string|null}>,
 *             hasImportMeta: boolean, hasTLA: boolean }}
 */
function scanEsm(src) {
  const statics = [];
  const dynamics = [];
  let hasImportMeta = false;
  const n = src.length;
  let i = 0;

  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  const atBoundary = (pos) => {
    // preceding non-space char is a statement separator (or start)
    let k = pos - 1;
    while (k >= 0 && /[ \t]/.test(src[k])) k--;
    return k < 0 || "\n;{}()".includes(src[k]);
  };

  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }

    if ((c === "i" || c === "e") && (i === 0 || !isId(src[i - 1]))) {
      const word = readWord(src, i);
      if (word === "import") {
        // import.meta
        let j = i + 6;
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] === ".") { hasImportMeta = true; i += 6; continue; }
        if (src[j] === "(") {
          // dynamic import — capture the (possibly literal) specifier
          const arg = readCallArg(src, j);
          dynamics.push(arg);
          i = j + 1;
          continue;
        }
        // static import statement (only at a statement boundary)
        if (atBoundary(i)) { i = collectStatic(src, i + 6, statics); continue; }
        i += word.length; continue;
      }
      if (word === "export" && atBoundary(i)) {
        // export ... from "spec"  /  export * from "spec"
        i = collectExportFrom(src, i + 6, statics);
        continue;
      }
      i += word.length; continue;
    }
    i++;
  }

  const hasTLA = /(^|[\n;{(])\s*await\b/.test(stripStrings(src));
  return { statics, dynamics, hasImportMeta, hasTLA };
}

// After `import`, find the `from "spec"` (or the bare `import "spec"`).
function collectStatic(src, pos, statics) {
  const n = src.length;
  let i = pos;
  while (i < n && /\s/.test(src[i])) i++;
  // bare `import "spec"`
  if (src[i] === '"' || src[i] === "'") { pushSpec(src, i, statics); return skipString(src, i); }
  // scan the clause to the `from` keyword, then the spec string
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue; }
    if (c === ";" || c === "\n") return i;
    if ((c === "f") && src.startsWith("from", i) && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? "") && !/[A-Za-z0-9_$]/.test(src[i + 4] ?? "")) {
      let j = i + 4;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '"' || src[j] === "'") { pushSpec(src, j, statics); return skipString(src, j); }
      return j;
    }
    i++;
  }
  return i;
}

function collectExportFrom(src, pos, statics) {
  const n = src.length;
  let i = pos;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue; }
    if (c === ";" || c === "\n" || c === "{") {
      if (c === "{") { // export { ... } from "spec" — skip the braces
        let depth = 0;
        for (; i < n; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
        continue;
      }
      // reached end without `from` → not a re-export
      if (c !== "{") return i;
    }
    if (src.startsWith("from", i) && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? "") && !/[A-Za-z0-9_$]/.test(src[i + 4] ?? "")) {
      let j = i + 4;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '"' || src[j] === "'") { pushSpec(src, j, statics); return skipString(src, j); }
      return j;
    }
    i++;
  }
  return i;
}

function readCallArg(src, parenPos) {
  let j = parenPos + 1;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src[j] === '"' || src[j] === "'") {
    const end = skipString(src, j);
    return { argStart: j, argEnd: end, spec: src.slice(j + 1, end - 1) };
  }
  return { argStart: j, argEnd: j, spec: null }; // dynamic expression
}

function pushSpec(src, quotePos, statics) {
  const end = skipString(src, quotePos);
  statics.push({ start: quotePos, end, spec: src.slice(quotePos + 1, end - 1) });
}

function readWord(src, i) { let k = i; while (k < src.length && /[A-Za-z0-9_$]/.test(src[k])) k++; return src.slice(i, k); }
function skipString(src, i) {
  const q = src[i]; i++;
  if (q === "`") {
    while (i < src.length) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") return i + 1;
      if (src[i] === "$" && src[i + 1] === "{") { let d = 1; i += 2; while (i < src.length && d) { if (src[i] === "{") d++; else if (src[i] === "}") d--; i++; } continue; }
      i++;
    }
    return i;
  }
  while (i < src.length) { if (src[i] === "\\") { i += 2; continue; } if (src[i] === q) return i + 1; i++; }
  return i;
}
function stripStrings(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { const e = skipString(src, i); out += " ".repeat(e - i); i = e; }
    else { out += c; i++; }
  }
  return out;
}

export { scanEsm };
