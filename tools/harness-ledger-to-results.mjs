// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Convert the NDJSON ledger emitted by test/run_tests.sh (RESULTS_NDJSON=...) into
// a userland-results.json for the status hub. Each ledger line is
// {"name":"...","status":"passed|failed|skipped"}; names are mapped to registry
// feature ids via test/harness-feature-map.json (longest-prefix match).
//
//   RESULTS_NDJSON=ledger.ndjson bash test/run_tests.sh --devenv
//   node tools/harness-ledger-to-results.mjs ledger.ndjson \
//     --source nano --suite node-harness --map test/harness-feature-map.json > userland-results.json

import { readFileSync, existsSync } from "node:fs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ledgerPath = process.argv[2];
const source = arg("source", "nano");
const suite = arg("suite", "node-harness");
const mapPath = arg("map", "test/harness-feature-map.json");

if (!ledgerPath || !existsSync(ledgerPath)) {
  console.error(`harness-ledger-to-results: ledger not found: ${ledgerPath}`);
  process.exit(1);
}
const map = JSON.parse(readFileSync(mapPath, "utf8")).map ?? {};
// longest key first so "busybox sort" wins over any shorter prefix
const keys = Object.keys(map).sort((a, b) => b.length - a.length);

function featuresFor(name) {
  for (const k of keys) if (name === k || name.startsWith(k)) return map[k];
  return null;
}

const results = [];
const seen = new Set();
for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t) continue;
  let entry;
  try {
    entry = JSON.parse(t);
  } catch {
    console.error(`⚠ skipping malformed ledger line: ${t}`);
    continue;
  }
  const features = featuresFor(entry.name);
  if (!features) {
    console.error(`⚠ no feature mapping for "${entry.name}" — skipping`);
    continue;
  }
  // de-dupe repeated names (keep the first/most-severe seen)
  if (seen.has(entry.name)) continue;
  seen.add(entry.name);
  results.push({
    test_id: entry.name,
    features,
    status: ["passed", "failed", "skipped", "flaky"].includes(entry.status) ? entry.status : "failed",
    retries: 0,
    trace_url: process.env.GITHUB_RUN_ID ? `https://github.com/userland-run/nano/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined,
  });
}

const out = {
  contract: 1,
  source,
  suite,
  commit: process.env.GITHUB_SHA?.slice(0, 7) || "local",
  branch: process.env.GITHUB_REF_NAME || "local",
  run_id: process.env.GITHUB_RUN_ID || "local",
  finished_at: new Date().toISOString(),
  results,
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
console.error(`✓ ${results.length} results → ${source}/${suite}`);
