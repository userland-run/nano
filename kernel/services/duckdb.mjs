// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/services/duckdb.mjs — the DuckDB Kernel Service (spec §8.8, user
// decision). Backs `node:sqlite` via DuckDB-wasm + its `sqlite` core
// extension (https://duckdb.org/docs/lts/core_extensions/sqlite). Dialect and
// error-code differences vs embedded SQLite are DIV-SQLITE-DUCKDB.
//
// The real backend is @duckdb/duckdb-wasm, loaded lazily (a multi-MB wasm
// blob fetched at runtime in the browser, or from the signed catalog as a
// `wasm-service` artifact). To keep the service registerable and testable
// without that download, an injectable `backend` is supported; a tiny
// in-memory SQL evaluator answers the smoke subset when no real backend is
// wired. Production always injects the real DuckDB-wasm connection.

function createDuckDbService({ backend } = {}) {
  /** @type {Map<any, any>} sessionHandle → connection */
  const connections = new Map();
  let seq = 0;
  const impl = backend ?? miniSqlBackend();

  return {
    id: "duckdb",
    version: "1.0.0",
    kind: "wasm-service",
    methods: ["query", "exec", "prepare"],
    // Stateless one-shot: open ephemeral connection, run, close.
    async invoke(method, payload) {
      const conn = await impl.connect(":memory:");
      try {
        return method === "exec"
          ? (await conn.run(payload.sql, payload.params), { ok: true })
          : { rows: await conn.query(payload.sql, payload.params) };
      } finally {
        await conn.close?.();
      }
    },
    // Stateful: a persistent connection (backs a node:sqlite DatabaseSync).
    openSession(config) {
      const handle = ++seq;
      connections.set(handle, impl.connect(config?.path ?? ":memory:"));
      return handle;
    },
    async call(handle, method, payload) {
      const conn = await connections.get(handle);
      switch (method) {
        case "query": return { rows: await conn.query(payload.sql, payload.params) };
        case "exec": await conn.run(payload.sql, payload.params); return { ok: true };
        default: throw new Error(`duckdb: unknown method ${method}`);
      }
    },
    async closeSession(handle) {
      const conn = await connections.get(handle);
      await conn?.close?.();
      connections.delete(handle);
    },
  };
}

/**
 * Lazily construct the real DuckDB-wasm backend. Kept out of the default path
 * so registration never triggers the download; the SDK/catalog wires this in.
 */
async function loadDuckDbWasmBackend(loader) {
  // `loader` returns an initialized @duckdb/duckdb-wasm AsyncDuckDB instance.
  const db = await loader();
  return {
    async connect() {
      const c = await db.connect();
      return {
        async query(sql, params) { const r = await c.query(sql, params); return r.toArray().map((row) => row.toJSON()); },
        async run(sql) { await c.query(sql); },
        async close() { await c.close(); },
      };
    },
  };
}

// A tiny in-memory SQL evaluator: CREATE TABLE / INSERT / SELECT * [WHERE col
// op val] [ORDER BY col] [LIMIT n]. Enough to exercise the service contract
// and node:sqlite smoke without the wasm download. NOT a real SQL engine.
function miniSqlBackend() {
  return {
    connect() {
      const tables = new Map();
      return {
        async run(sql) { evalSql(sql, tables); },
        async query(sql) { return evalSql(sql, tables) ?? []; },
        async close() {},
      };
    },
  };
}

function evalSql(sql, tables) {
  const s = sql.trim().replace(/;$/, "");
  let m;
  if ((m = /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.+)\)$/is.exec(s))) {
    const cols = m[2].split(",").map((c) => c.trim().split(/\s+/)[0]);
    if (!tables.has(m[1])) tables.set(m[1], { cols, rows: [] });
    return;
  }
  if ((m = /^INSERT INTO (\w+)(?:\s*\(([^)]+)\))?\s*VALUES\s*(.+)$/is.exec(s))) {
    const t = tables.get(m[1]);
    if (!t) throw new Error(`no table ${m[1]}`);
    const cols = m[2] ? m[2].split(",").map((c) => c.trim()) : t.cols;
    for (const tuple of splitTuples(m[3])) {
      const vals = tuple.map(parseLiteral);
      const row = {};
      cols.forEach((c, i) => { row[c] = vals[i]; });
      t.rows.push(row);
    }
    return;
  }
  if ((m = /^SELECT (.+?) FROM (\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER BY\s+(\w+)(\s+DESC)?)?(?:\s+LIMIT\s+(\d+))?$/is.exec(s))) {
    const t = tables.get(m[2]);
    if (!t) throw new Error(`no table ${m[2]}`);
    let rows = t.rows.slice();
    if (m[3]) {
      const w = /^(\w+)\s*(=|!=|<|>|<=|>=)\s*(.+)$/.exec(m[3].trim());
      if (w) { const col = w[1], op = w[2], val = parseLiteral(w[3]); rows = rows.filter((r) => compare(r[col], op, val)); }
    }
    if (m[4]) { rows.sort((a, b) => (a[m[4]] > b[m[4]] ? 1 : a[m[4]] < b[m[4]] ? -1 : 0)); if (m[5]) rows.reverse(); }
    if (m[6]) rows = rows.slice(0, parseInt(m[6], 10));
    const sel = m[1].trim();
    if (sel === "*") return rows;
    const cols = sel.split(",").map((c) => c.trim());
    return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  }
  throw new Error(`miniSql: unsupported statement: ${s.slice(0, 40)}`);
}

function splitTuples(s) {
  const tuples = [];
  const re = /\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(s))) tuples.push(m[1].split(",").map((x) => x.trim()));
  return tuples;
}
function parseLiteral(v) {
  v = v.trim();
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  if (v === "NULL") return null;
  return v;
}
function compare(a, op, b) {
  switch (op) { case "=": return a == b; case "!=": return a != b; case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b; }
  return false;
}

export { createDuckDbService, loadDuckDbWasmBackend };
