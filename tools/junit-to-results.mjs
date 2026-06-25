// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Convert a cargo-nextest JUnit report into a userland-results.json for the
// status hub. Maps each test to a registry feature via the `__feat__<id>` suffix
// in the test name (dots → underscores), falling back to test/feature-map.json.
//
//   node tools/junit-to-results.mjs target/nextest/ci/junit.xml \
//     --source nano --suite cargo-unit --map test/feature-map.json > userland-results.json

import { readFileSync, existsSync } from "node:fs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const junitPath = process.argv[2];
const source = arg("source", "nano");
const suite = arg("suite", "cargo-unit");
const mapPath = arg("map", "");

if (!junitPath || !existsSync(junitPath)) {
  console.error(`junit-to-results: report not found: ${junitPath}`);
  process.exit(1);
}
const xml = readFileSync(junitPath, "utf8");
const fallback = mapPath && existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")).map ?? {} : {};

// Recover feature ids from a `__feat__a_b_c` suffix → "a.b.c". A test may carry
// several (`__feat__x__feat__y`). Underscores inside a segment are ambiguous, so
// the convention is: dashes in ids are kept as `-`, dots become `__`-delimited
// segments. We restore by splitting on the literal token boundaries.
function featsFromName(name) {
  const ids = [];
  const re = /__feat__([a-z0-9_-]+?)(?=__feat__|$)/g;
  let m;
  while ((m = re.exec(name)) !== null) ids.push(m[1].replace(/_/g, "."));
  return ids;
}

// nextest emits classname="<binary>" and name="<module>::tests::<test>", so the
// feature map is keyed by `name` prefix (e.g. "decode::tests::"). The `__feat__`
// suffix is supported too, but the map is authoritative because it can express
// ids with hyphens (which a Rust identifier cannot).
function featsFor(name) {
  for (const prefix of Object.keys(fallback)) if (name.startsWith(prefix)) return fallback[prefix];
  const fromName = featsFromName(name);
  if (fromName.length) return fromName;
  return [];
}

// Minimal JUnit <testcase> scan (nextest emits flat testcases with classname).
const results = [];
const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
const attr = (s, k) => {
  const m = new RegExp(`${k}="([^"]*)"`).exec(s);
  return m ? m[1] : "";
};
let c;
while ((c = caseRe.exec(xml)) !== null) {
  const head = c[1];
  const inner = c[3] ?? "";
  const name = attr(head, "name");
  const time = parseFloat(attr(head, "time") || "0");
  const reruns = (inner.match(/<rerun/g) || []).length;
  let status = "passed";
  if (/<failure|<error/.test(inner)) status = "failed";
  else if (/<skipped/.test(inner)) status = "skipped";
  else if (reruns > 0) status = "flaky"; // passed after a retry
  const features = featsFor(name);
  if (features.length === 0) {
    console.error(`⚠ no feature mapping for ${name} — skipping (add it to test/feature-map.json or tag @feat)`);
    continue;
  }
  results.push({
    test_id: name,
    features,
    status,
    duration_ms: Math.round(time * 1000),
    retries: reruns,
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
