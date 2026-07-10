#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// Upstream-fidelity test (spec P2): runs Node's real lib/*.js modules VERBATIM
// on the host engine over the nodert bindings, and checks behavior. Every
// module here is byte-identical vendored upstream code — nothing reimplemented.

import { Kernel, registerBuiltinServices } from "../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

let passed = 0, failed = 0;

async function check(name, src, expect) {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel);
  const r = await runNode(kernel, { argv: ["node", "-e", src], source: src, cwd: "/", env: {}, timeoutMs: 20000 });
  const got = r.stdout.trim();
  if (r.exitCode === 0 && got === expect) { passed++; console.log(`  PASS: ${name}`); }
  else {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    got: ${JSON.stringify(got)} (exit ${r.exitCode}) want ${JSON.stringify(expect)}`);
    if (r.stderr) console.error(`    stderr: ${r.stderr.split("\n").slice(0, 3).join(" | ")}`);
  }
}

// upstream events (EventEmitter)
await check("events: on/emit/once/listenerCount",
  `const EE=require("events"); const e=new EE(); let o=[]; e.on("x",(a,b)=>o.push(a+b)); e.emit("x",2,3); e.once("y",()=>o.push("Y")); e.emit("y"); e.emit("y"); console.log(o.join(","), e.listenerCount("x"))`,
  "5,Y 1");
await check("events: removeListener",
  `const EE=require("events"); const e=new EE(); const f=()=>console.log("nope"); e.on("z",f); e.removeListener("z",f); e.emit("z"); console.log("removed", e.listenerCount("z"))`,
  "removed 0");

// upstream querystring
await check("querystring: stringify/parse",
  `const qs=require("querystring"); console.log(qs.stringify({a:1,b:"x y"}), JSON.stringify(qs.parse("a=1&b=2")))`,
  `a=1&b=x%20y {"a":"1","b":"2"}`);

// upstream punycode
await check("punycode: toASCII",
  `const p=require("punycode"); console.log(p.toASCII("mañana.example"))`,
  "xn--maana-pta.example");

// upstream string_decoder (multibyte across chunks)
await check("string_decoder: split multibyte",
  `const {StringDecoder}=require("string_decoder"); const d=new StringDecoder("utf8"); const b=Buffer.from("héllo"); let out=d.write(b.subarray(0,2))+d.write(b.subarray(2))+d.end(); console.log(out)`,
  "héllo");

// upstream assert
await check("assert: strictEqual + throws",
  `const a=require("assert"); a.strictEqual(2+2,4); a.throws(()=>a.strictEqual(1,2)); console.log("assert-ok")`,
  "assert-ok");

// upstream path (already proven, re-checked here for the report)
await check("path: join/relative/parse",
  `const p=require("path"); console.log(p.join("/a/b","../c"), p.relative("/a/b","/a/c"), p.parse("/x/y.js").ext)`,
  "/a/c ../c .js");

// url (host WHATWG URL shim — DIV-URL-M0)
await check("url: URL + searchParams",
  `const {URL}=require("url"); const u=new URL("https://a.com:8080/p?x=1#h"); console.log(u.hostname, u.port, u.pathname, u.searchParams.get("x"))`,
  "a.com 8080 /p 1");

console.log(`\n=== nodert upstream-verbatim: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
