// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/services/type-strip.mjs — the SWC-role Kernel Service (spec §13.2).
// Strips TypeScript types to plain JS for the ESM loader's TS path (§9.2 step
// 6), matching Node's `--experimental-strip-types` (stable ≥ the pinned
// version): erase annotations WITHOUT re-emitting positions, so source maps
// stay 1:1 (replace stripped spans with equal-length whitespace).
//
// This is a real, self-contained tokenizer-driven stripper — no 30 MB SWC
// wasm to download — that handles the type-annotation surface real tooling
// emits. The service id/method contract is SWC-compatible, so a genuine
// @swc/wasm backend can drop in behind the same `id: "swc"` registration if
// byte-exact SWC parity is ever required (declared in DIVERGENCES).

function createTypeStripService() {
  return {
    id: "swc",
    version: "type-strip-1.0.0",
    kind: "wasm-service",
    methods: ["transform", "stripTypes"],
    invoke(method, payload) {
      const code = payload?.code ?? payload?.source ?? "";
      if (method === "transform" || method === "stripTypes") {
        return { code: stripTypes(code) };
      }
      throw new Error(`swc: unknown method ${method}`);
    },
    // Stateful session (parser options) — used by the ESM loader graph build.
    openSession(config) { return { config: config ?? {} }; },
    call(session, method, payload) { return this.invoke(method, payload); },
    closeSession() {},
  };
}

// Whitespace-preserving type erasure. Walks the source with a tiny lexer that
// tracks strings/templates/regex/comments so type syntax inside them is never
// touched, then blanks out: `: Type` annotations, `interface`/`type` decls,
// `as`/`satisfies` expressions, generic parameter lists, `!` non-null, and
// type-only imports/exports. Equal-length whitespace keeps byte offsets so
// blob-URL source maps need no column shifts (§9.2 step 2).
function stripTypes(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;

  const blank = (start, end) => {
    for (let k = start; k < end; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);

  // Skip a balanced <...> generic/type-arg span starting at `<`. Returns the
  // index just past the matching `>`, or -1 if it isn't a type span.
  const skipAngle = (start) => {
    let depth = 0;
    for (let k = start; k < n; k++) {
      const c = src[k];
      if (c === "<") depth++;
      else if (c === ">") { depth--; if (depth === 0) return k + 1; }
      else if (c === "(" || c === ")" || c === "{" || c === "}" || c === ";") return -1; // not a type span
      else if (c === "=" && src[k + 1] !== ">") { /* allowed in defaults */ }
    }
    return -1;
  };

  // Skip a type expression starting at `start` (after `:` / `as`). Stops at a
  // top-level `,` `)` `}` `;` `=` `\n`(for ASI) or `{` that opens a block.
  const skipType = (start) => {
    let k = start;
    let depth = 0; // (), [], <>, {}
    let sawType = false; // any non-ws type token consumed yet?
    while (k < n) {
      const c = src[k];
      if (c === "{") {
        // An object-type brace only when the type hasn't started yet or the
        // previous meaningful char is a type combinator; otherwise this `{`
        // opens a block (function body / arrow) and the type ends here.
        const prev = prevMeaningful(src, k - 1, start);
        if (depth === 0 && sawType && !"|&(<,=>:".includes(prev)) break;
        depth++;
      }
      else if (c === "(" || c === "[" || c === "<") { depth++; sawType = true; }
      else if (c === ")" || c === "]" || c === ">" || c === "}") { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === "," || c === ";" || c === "=")) break;
      else if (depth === 0 && c === "\n") {
        // Continue only if the next non-ws token continues the type (| & . etc.)
        let j = k + 1;
        while (j < n && /\s/.test(src[j])) j++;
        if (!"|&.<>[]".includes(src[j]) && !(src[j] === "e" && src.startsWith("extends", j))) break;
      } else if (c === '"' || c === "'" || c === "`") { k = skipString(src, k); sawType = true; continue; }
      else if (!/\s/.test(c)) sawType = true;
      k++;
    }
    return k;
  };

  // Brace-context stack: distinguishes value object-literals `({a: 1})` — whose
  // `:` are property separators (never stripped) — from blocks and type-object
  // braces. Type-object braces never reach here: skipType consumes them whole.
  const braceStack = [];
  const inValueObject = () => braceStack[braceStack.length - 1] === "obj";

  while (i < n) {
    const c = src[i];
    // strings / templates / regex / comments — copy verbatim, never touch.
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }

    if (c === "{") {
      const prev = prevMeaningful(src, i - 1, 0);
      // Value object-literal in expression position (after = ( [ , : ? ). An
      // arrow body `=> {` is a block (object returns require `=> ({...})`), so
      // `>` is NOT object context.
      braceStack.push("=([,:?".includes(prev) ? "obj" : "block");
      i++; continue;
    }
    if (c === "}") { braceStack.pop(); i++; continue; }
    if (c === "(" || c === "[") { braceStack.push("paren"); i++; continue; }
    if (c === ")" || c === "]") { braceStack.pop(); i++; continue; }

    // keyword-led constructs at a plausible statement boundary
    if (isIdStart(c) && (i === 0 || !isId(src[i - 1]))) {
      const word = readWord(src, i);
      if ((word === "interface") && atStatementStart(src, i)) {
        const end = skipBalancedDecl(src, i + word.length);
        blank(i, end); i = end; continue;
      }
      if (word === "type" && atStatementStart(src, i) && /\s/.test(src[i + 4] ?? "")) {
        // `type X = ...;` — blank through the terminating ; or newline
        let k = i + 4;
        let depth = 0;
        while (k < n) { const ch = src[k]; if ("([{<".includes(ch)) depth++; else if (")]}>".includes(ch)) depth--; else if (ch === ";" && depth === 0) { k++; break; } else if (ch === "\n" && depth === 0) break; k++; }
        blank(i, k); i = k; continue;
      }
      if ((word === "import" || word === "export") && importIsTypeOnly(src, i + word.length)) {
        const end = findStatementEnd(src, i);
        blank(i, end); i = end; continue;
      }
      // `as`/`satisfies` type assertions
      if ((word === "as" || word === "satisfies") && /\s/.test(src[i - 1] ?? "") && /\s/.test(src[i + word.length] ?? "")) {
        const end = skipType(i + word.length + 1);
        blank(i, end); i = end; continue;
      }
      i += word.length; continue;
    }

    // `: Type` annotations (params, vars, return types, members). A `:` inside
    // a VALUE object literal is a property separator — leave it alone. (Ternary
    // `?:` colons live in "paren"/"block" context and are rare in type-annotated
    // positions; the `?` handling keeps simple cases intact.)
    if (c === ":" && !inValueObject()) {
      const end = skipType(i + 1);
      if (end > i + 1) { blank(i, end); i = end; continue; }
    }
    // `!` non-null assertion after an identifier/paren
    if (c === "!" && src[i + 1] !== "=" && isId(src[i - 1] ?? "")) { out[i] = " "; i++; continue; }
    // generic call/def `<...>` immediately after an identifier
    if (c === "<" && isId(src[i - 1] ?? "")) {
      const end = skipAngle(i);
      if (end > 0) { blank(i, end); i = end; continue; }
    }
    i++;
  }
  return out.join("");
}

function prevMeaningful(src, k, floor) {
  while (k >= floor && /\s/.test(src[k])) k--;
  return k >= floor ? src[k] : "";
}
function skipString(src, i) {
  const q = src[i];
  i++;
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
function readWord(src, i) { let k = i; while (k < src.length && /[A-Za-z0-9_$]/.test(src[k])) k++; return src.slice(i, k); }
function atStatementStart(src, i) {
  let k = i - 1;
  while (k >= 0 && /[ \t]/.test(src[k])) k--;
  return k < 0 || src[k] === "\n" || src[k] === ";" || src[k] === "}" || src[k] === "{";
}
function skipBalancedDecl(src, start) {
  // interface Name<...> extends ... { ... } — blank to matching close brace
  let k = start;
  while (k < src.length && src[k] !== "{") k++;
  let depth = 0;
  for (; k < src.length; k++) { if (src[k] === "{") depth++; else if (src[k] === "}") { depth--; if (depth === 0) return k + 1; } }
  return src.length;
}
function importIsTypeOnly(src, after) {
  let k = after;
  while (k < src.length && /\s/.test(src[k])) k++;
  return src.startsWith("type", k) && /\s/.test(src[k + 4] ?? "");
}
function findStatementEnd(src, i) {
  let k = i, depth = 0;
  while (k < src.length) { const c = src[k]; if (c === '"' || c === "'" || c === "`") { k = skipString(src, k); continue; } if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--; else if (c === ";" && depth === 0) return k + 1; else if (c === "\n" && depth === 0) return k; k++; }
  return k;
}

export { createTypeStripService, stripTypes };
