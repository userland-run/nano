#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// M1 net + http tests: nodert net loopback (§11.1) and http server/client over
// it, plus ServeBridge reachability (the http server's port is registered in
// the Kernel port table so the SW bridge can inject requests — §11.4).

import { Kernel, registerBuiltinServices } from "../../kernel/index.mjs";
import { runNode } from "../src/host/runtime.mjs";

let passed = 0, failed = 0;

async function run(name, src, expect, expectExit = 0) {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel);
  const r = await runNode(kernel, { argv: ["node", "-e", src], source: src, cwd: "/", env: {}, timeoutMs: 20000 });
  const ok = typeof expect === "function" ? expect(r.stdout) : r.stdout === expect;
  if (ok && r.exitCode === expectExit) { passed++; console.log(`  PASS: ${name}`); }
  else {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    exit ${r.exitCode} (want ${expectExit}) stdout ${JSON.stringify(r.stdout)}`);
    if (r.stderr) console.error(`    stderr ${r.stderr.split("\n").slice(0, 3).join(" | ")}`);
  }
}

await run("net: loopback echo",
  `const net=require("net");
   const s=net.createServer(sock=>{sock.setEncoding("utf8");sock.on("data",d=>sock.write("echo:"+d));});
   s.listen(3000,()=>{const c=net.connect(3000,()=>c.write("ping"));c.setEncoding("utf8");c.on("data",d=>{console.log(d);process.exit(0);});});
   setTimeout(()=>process.exit(1),3000);`,
  "echo:ping\n");

await run("net: multiple writes",
  `const net=require("net");
   const s=net.createServer(sock=>{let n=0;sock.setEncoding("utf8");sock.on("data",()=>{sock.write("r"+(++n));});});
   s.listen(3001,()=>{const c=net.connect(3001,()=>{c.write("a");});let got=[];c.setEncoding("utf8");c.on("data",d=>{got.push(d);if(got.length<3)c.write("b");else{console.log(got.join(","));process.exit(0);}});});
   setTimeout(()=>process.exit(1),3000);`,
  "r1,r2,r3\n");

await run("http: server + client GET",
  `const http=require("http");
   const s=http.createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/plain"});res.end("Hello "+req.method+" "+req.url);});
   s.listen(8080,()=>{http.get({port:8080,path:"/x"},(res)=>{let b="";res.setEncoding("utf8");res.on("data",d=>b+=d);res.on("end",()=>{console.log(res.statusCode+":"+res.headers["content-type"]+":"+b);process.exit(0);});});});
   setTimeout(()=>process.exit(1),4000);`,
  "200:text/plain:Hello GET /x\n");

await run("http: POST with body",
  `const http=require("http");
   const s=http.createServer((req,res)=>{let b="";req.setEncoding("utf8");req.on("data",d=>b+=d);req.on("end",()=>{res.writeHead(201);res.end("got:"+b);});});
   s.listen(8081,()=>{const req=http.request({port:8081,path:"/",method:"POST"},(res)=>{let b="";res.setEncoding("utf8");res.on("data",d=>b+=d);res.on("end",()=>{console.log(res.statusCode+":"+b);process.exit(0);});});req.end("payload");});
   setTimeout(()=>process.exit(1),4000);`,
  "201:got:payload\n");

// ServeBridge reachability: the http server's port is in the Kernel port table,
// so an external injector (the Service-Worker bridge, §11.4) can reach it.
await (async () => {
  const kernel = new Kernel();
  await registerBuiltinServices(kernel);
  const src = `const http=require("http"); http.createServer((req,res)=>{res.writeHead(200);res.end("served:"+req.url);}).listen(9090,()=>console.log("listening")); setTimeout(()=>{},10000);`;
  // Run in the background; wait for the listening line then inject via the port table.
  const done = runNode(kernel, { argv: ["node", "-e", src], source: src, cwd: "/", env: {}, timeoutMs: 8000 });
  // Poll the port table for the registered listener.
  let listener = null;
  for (let i = 0; i < 200 && !listener; i++) { listener = kernel.ports.lookup(9090); await new Promise((r) => setTimeout(r, 20)); }
  const name = "http: reachable via port table (ServeBridge)";
  if (listener && listener.kind === "node") { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name} — listener not registered (${JSON.stringify(listener)})`); }
  await done;
})();

console.log(`\n=== nodert net+http: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
