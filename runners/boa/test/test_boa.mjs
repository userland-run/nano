#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

/**
 * Tests for the Boa scripting layer (container/boa.mjs + boa.wasm).
 *
 * Exercises: ABI/version, sync eval + JSON marshalling, console routing, the
 * capability model, the synchronous fs bridge, the async run bridge (mock VM),
 * error propagation, registerFunction/defineGlobal, and runtime limits.
 *
 * Usage: node test/test_boa.mjs [path/to/boa.wasm]
 */
import { BoaRuntime, ScriptError } from "../host/boa.mjs";

const WASM = process.argv[2] || "wasm/boa.wasm";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  OK: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name} - ${e.stack || e.message}`);
  }
}

// A tiny mock "VM host": a sync in-memory fs + an async command runner.
function makeMockHost() {
  const files = new Map([
    ["/project/a.txt", "alpha\n"],
    ["/project/b.txt", "beta\ngamma\n"],
  ]);
  const dirs = new Map([["/project", ["a.txt", "b.txt"]]]);
  const runLog = [];
  return {
    runLog,
    files,
    fs: {
      readText: (p) => (files.has(p) ? files.get(p) : null),
      readFile: (p) => (files.has(p) ? new TextEncoder().encode(files.get(p)) : null),
      list: (p) =>
        dirs.has(p) ? dirs.get(p).map((name) => ({ name, type: "file", size: files.get(`${p}/${name}`)?.length ?? 0 })) : null,
      exists: (p) => files.has(p) || dirs.has(p),
      writeFile: (p, bytes) => {
        files.set(p, new TextDecoder().decode(bytes));
        const slash = p.lastIndexOf("/");
        const dir = p.slice(0, slash) || "/";
        const base = p.slice(slash + 1);
        if (!dirs.has(dir)) dirs.set(dir, []);
        if (!dirs.get(dir).includes(base)) dirs.get(dir).push(base);
      },
    },
    // async "busybox": only knows `wc -l <path>` for the test
    run: async (cmd) => {
      runLog.push(cmd);
      await new Promise((r) => setTimeout(r, 1)); // force a real async hop
      const m = /^wc -l (.+)$/.exec(cmd.trim());
      if (m) {
        const body = files.get(m[1]) ?? "";
        const lines = body.length ? body.split("\n").length - 1 : 0;
        return { exitCode: 0, stdout: `${lines} ${m[1]}\n` };
      }
      return { exitCode: 1, stdout: "" };
    },
  };
}

async function main() {
  const boa = await BoaRuntime.load(WASM);

  await test("version reports abi 1", () => {
    const v = boa.version();
    eq(v.abi, 1, "abi");
    assert(typeof v.wrapper === "string" && v.wrapper.length > 0, "wrapper version present");
    assert(/boa_engine/.test(v.engine), "engine name present");
  });

  await test("sync eval: arithmetic", async () => {
    eq(await boa.script("40 + 2"), 42, "40+2");
  });

  await test("sync eval: object marshalling", async () => {
    eq(await boa.script(`({ a: 1, b: [true, "x", null], c: { d: 2.5 } })`), {
      a: 1,
      b: [true, "x", null],
      c: { d: 2.5 },
    });
  });

  await test("language features (let/const/arrow/template/JSON)", async () => {
    eq(await boa.script("const xs=[1,2,3]; xs.map(x=>x*x).reduce((a,b)=>a+b,0)"), 14);
    eq(await boa.script("`a${1+1}b`"), "a2b");
    eq(await boa.script(`JSON.stringify({k:1})`), '{"k":1}');
  });

  await test("console.log routes to onStdout", async () => {
    const engine = boa.createEngine({ webapis: ["console"] });
    let out = "";
    engine.onStdout((t) => (out += t));
    await engine.eval(`console.log("hello", 42); console.log("world")`);
    engine.dispose();
    eq(out, "hello 42\nworld\n");
  });

  await test("console.warn/error route to onStderr", async () => {
    const engine = boa.createEngine({ webapis: ["console"] });
    let out = "";
    let err = "";
    engine.onStdout((t) => (out += t));
    engine.onStderr((t) => (err += t));
    await engine.eval(`console.log("L"); console.warn("W"); console.error("E")`);
    engine.dispose();
    eq(out, "L\n", "stdout");
    eq(err, "W\nE\n", "stderr");
  });

  await test("evalModule runs an ES module", async () => {
    const engine = boa.createEngine({ webapis: ["console"] });
    await engine.evalModule(`export const x = 21; globalThis.__m = x * 2;`, "mod");
    eq(await engine.eval(`globalThis.__m`), 42);
    engine.dispose();
  });

  await test("webapi: encoding (TextEncoder/TextDecoder) opt-in", async () => {
    const engine = boa.createEngine({ webapis: ["encoding"] });
    eq(await engine.eval(`Array.from(new TextEncoder().encode("hi"))`), [104, 105]);
    eq(await engine.eval(`new TextDecoder().decode(new Uint8Array([104, 105]))`), "hi");
    engine.dispose();
  });

  await test("eval error propagates as ScriptError", async () => {
    let threw = null;
    try {
      await boa.script(`throw new Error("boom")`);
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof ScriptError, "is ScriptError");
    assert(/boom/.test(threw.message), `message contains boom: ${threw && threw.message}`);
  });

  await test("syntax error propagates", async () => {
    let threw = null;
    try {
      await boa.script(`const = ;`);
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof ScriptError, "is ScriptError");
  });

  await test("capability: no fs exposed -> nano.fs undefined", async () => {
    const host = makeMockHost();
    const r = await boa.script(`typeof nano + ":" + typeof nano.fs`, { host, expose: {} });
    eq(r, "object:undefined");
  });

  await test("capability: readonly fs bridge", async () => {
    const host = makeMockHost();
    const engine = boa.createEngine({ host, expose: { fs: "readonly" } });
    eq(await engine.eval(`nano.fs.readText("/project/a.txt")`), "alpha\n");
    eq(await engine.eval(`nano.fs.exists("/project/a.txt")`), true);
    eq(await engine.eval(`nano.fs.exists("/nope")`), false);
    eq(await engine.eval(`nano.fs.list("/project").map(e => e.name).sort()`), ["a.txt", "b.txt"]);
    eq(await engine.eval(`Array.from(nano.fs.readFile("/project/a.txt"))`), Array.from(new TextEncoder().encode("alpha\n")));
    // readonly => no writeFile
    eq(await engine.eval(`typeof nano.fs.writeFile`), "undefined");
    engine.dispose();
  });

  await test("capability: readwrite fs bridge", async () => {
    const host = makeMockHost();
    const engine = boa.createEngine({ host, expose: { fs: "readwrite" } });
    await engine.eval(`nano.fs.writeFile("/project/c.txt", "delta\\n")`);
    eq(host.files.get("/project/c.txt"), "delta\n");
    // write bytes via Uint8Array
    await engine.eval(`nano.fs.writeFile("/project/d.bin", new Uint8Array([104,105]))`);
    eq(host.files.get("/project/d.bin"), "hi");
    engine.dispose();
  });

  await test("async run bridge: await nano.run", async () => {
    const host = makeMockHost();
    const engine = boa.createEngine({ host, expose: { fs: "readonly", run: true } });
    const r = await engine.eval(`(async () => { const o = await nano.run("wc -l /project/b.txt"); return o.stdout.trim(); })()`);
    eq(r, "2 /project/b.txt");
    eq(host.runLog, ["wc -l /project/b.txt"]);
    engine.dispose();
  });

  await test("async loop: drive VM over a file list", async () => {
    const host = makeMockHost();
    const engine = boa.createEngine({ host, expose: { fs: "readonly", run: true } });
    const r = await engine.eval(`
      (async () => {
        const out = [];
        for (const f of nano.fs.list("/project")) {
          const res = await nano.run("wc -l /project/" + f.name);
          out.push(res.stdout.trim());
        }
        return out.sort();
      })()
    `);
    eq(r, ["1 /project/a.txt", "2 /project/b.txt"]);
    engine.dispose();
  });

  await test("async rejection propagates", async () => {
    const engine = boa.createEngine({
      host: { run: async () => { throw new Error("vm exploded"); } },
      expose: { run: true },
    });
    let threw = null;
    try {
      await engine.eval(`(async () => { await nano.run("boom"); })()`);
    } catch (e) {
      threw = e;
    }
    engine.dispose();
    assert(threw instanceof ScriptError, "is ScriptError");
    assert(/vm exploded/.test(threw.message), `message: ${threw && threw.message}`);
  });

  await test("registerFunction (async) + defineGlobal", async () => {
    const engine = boa.createEngine({ expose: {} });
    engine.defineGlobal("VERSION", "1.4.2");
    engine.registerFunction("fetchRow", async (id) => ({ id, name: `row-${id}` }));
    const r = await engine.eval(`(async () => { const row = await fetchRow(7); return VERSION + ":" + row.name; })()`);
    eq(r, "1.4.2:row-7");
    engine.dispose();
  });

  await test("registerFunction (sync)", async () => {
    const engine = boa.createEngine({ expose: {} });
    engine.registerFunction("double", (x) => x * 2, { async: false });
    eq(await engine.eval(`double(21)`), 42);
    engine.dispose();
  });

  await test("env bag is injected and read-only", async () => {
    const r = await boa.script(`nano.env.GREETING + "/" + nano.env.N`, {
      expose: {},
      env: { GREETING: "hi", N: 5 },
    });
    eq(r, "hi/5");
  });

  await test("isolation: separate engines have separate globals", async () => {
    const e1 = boa.createEngine({ expose: {} });
    const e2 = boa.createEngine({ expose: {} });
    await e1.eval(`globalThis.secret = 123`);
    eq(await e2.eval(`typeof globalThis.secret`), "undefined");
    e1.dispose();
    e2.dispose();
  });

  await test("runtime limit: loop iteration cap halts runaway", async () => {
    const engine = boa.createEngine({ expose: {}, limits: { loopIterations: 100000 } });
    let threw = null;
    try {
      await engine.eval(`let i = 0; while (true) { i++; }`);
    } catch (e) {
      threw = e;
    }
    engine.dispose();
    assert(threw instanceof ScriptError, "runaway loop should throw");
  });

  console.log(`\nBoa scripting: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
