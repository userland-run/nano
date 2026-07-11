#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// Smoke test: run scripts on the nodert tier (host engine) via the Kernel and
// a worker_threads worker. Not the differential suite — just "does it run".

import { Kernel, registerBuiltinServices } from "../../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

let passed = 0, failed = 0;

async function run(name, source, expectStdout, expectExit = 0) {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel);
  // Seed a file the fs tests read.
  kernel.vfs.rootMem.createFile("/work/hello.txt", "file contents\n");
  kernel.vfs.mkdir?.("/tmp", 0o777);
  const r = await runNode(kernel, { argv: ["node", "-e", source], source, cwd: "/work", env: { HOME: "/root" }, timeoutMs: 20000 });
  const okOut = typeof expectStdout === "function" ? expectStdout(r.stdout) : r.stdout === expectStdout;
  const okExit = r.exitCode === expectExit;
  if (okOut && okExit) { passed++; console.log(`  PASS: ${name}`); }
  else {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    exit: got ${r.exitCode} want ${expectExit}`);
    console.error(`    stdout: ${JSON.stringify(r.stdout)}`);
    if (r.stderr) console.error(`    stderr: ${r.stderr.slice(0, 400)}`);
    if (r.error) console.error(`    error: ${r.error}`);
  }
}

await run("console.log string", `console.log("hi")`, "hi\n");
await run("console.log multi + number", `console.log("n =", 42, true)`, "n = 42 true\n");
await run("format specifiers", `console.log("%s/%d", "a", 5)`, "a/5\n");
await run("process identity", `console.log(process.version, process.platform, process.arch)`, "v25.4.0 linux x64\n");
await run("Buffer round-trip", `const b = Buffer.from("héllo"); console.log(b.length, b.toString("hex"), b.toString())`, "6 68c3a96c6c6f héllo\n");
await run("JSON + object inspect", `console.log({a:1, b:[2,3]})`, "{ a: 1, b: [ 2, 3 ] }\n");
await run("process.exit code", `console.log("before"); process.exit(3); console.log("after")`, "before\n", 3);
await run("throw → exit 1", `throw new Error("boom")`, (s) => s === "", 1);
await run("setTimeout ordering", `setTimeout(() => console.log("t"), 0); console.log("sync"); Promise.resolve().then(() => console.log("p"))`, "sync\np\nt\n");
await run("nextTick before timer", `process.nextTick(() => console.log("tick")); setTimeout(() => console.log("timeout")); console.log("main")`, "main\ntick\ntimeout\n");
await run("fs.readFileSync", `const fs = require("fs"); process.stdout.write(fs.readFileSync("/work/hello.txt", "utf8"))`, "file contents\n");
await run("fs write+read+stat", `const fs=require("fs"); fs.writeFileSync("/tmp/a.txt","xyz"); console.log(fs.readFileSync("/tmp/a.txt","utf8"), fs.statSync("/tmp/a.txt").size)`, "xyz 3\n");
await run("path module (upstream verbatim)", `const path=require("path"); console.log(path.join("/a/b", "../c"), path.basename("/x/y.js"), path.extname("f.txt"))`, "/a/c y.js .txt\n");
await run("fs.promises", `const fs=require("fs").promises; (async()=>{await fs.writeFile("/tmp/p.txt","P"); console.log(await fs.readFile("/tmp/p.txt","utf8"))})()`, "P\n");
await run("zlib service round-trip", `const z=require("zlib"); const gz=z.gzipSync("hello service "); console.log(z.gunzipSync(gz).toString())`, "hello service \n");
await run("node:sqlite via DuckDB", `const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE t (id, v)"); db.exec("INSERT INTO t (id, v) VALUES (1, 'one'), (2, 'two')"); const rows=db.prepare("SELECT v FROM t WHERE id > 1 ORDER BY id").all(); console.log(rows.map(r=>r.v).join(","))`, "two\n");

console.log(`\n=== nodert smoke: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
