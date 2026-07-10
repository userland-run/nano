// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// Minimal WASM encoder that emits real wasm32-wasip1 modules for the wasm-tier
// tests, so the suite needs no external toolchain. Not general — just enough
// for the fixtures below (hello, exit-code, file-read, args-echo).

const enc = new TextEncoder();
function uleb(n) { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }
function sleb(n) { const out = []; let more = true; while (more) { let b = n & 0x7f; n >>= 7; if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40))) more = false; else b |= 0x80; out.push(b); } return out; }
function vec(items) { return [...uleb(items.length), ...items.flat()]; }
function section(id, body) { return [id, ...uleb(body.length), ...body]; }
function str(s) { const b = [...enc.encode(s)]; return [...uleb(b.length), ...b]; }

// value types
const I32 = 0x7f;
// import kinds
const KIND_FUNC = 0, KIND_MEM = 2;

/**
 * Build a module.
 * @param {{ imports: Array<{module,name,type}>, funcs: Array<{type,locals?,body}>,
 *           memory: {min}, exports: Array<{name,kind,index}>, data?: Array<{offset,bytes}>,
 *           types: Array<{params:number[],results:number[]}>, start?: number }} spec
 */
function buildModule(spec) {
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // magic + version

  // type section (1)
  const typeSec = vec(spec.types.map((t) => [0x60, ...vec(t.params.map((p) => [p])), ...vec(t.results.map((r) => [r]))]));
  bytes.push(...section(1, typeSec));

  // import section (2)
  if (spec.imports.length) {
    const importSec = vec(spec.imports.map((i) => [...str(i.module), ...str(i.name), KIND_FUNC, ...uleb(i.type)]));
    bytes.push(...section(2, importSec));
  }

  // function section (3)
  const funcSec = vec(spec.funcs.map((f) => uleb(f.type)));
  bytes.push(...section(3, funcSec));

  // memory section (5)
  bytes.push(...section(5, vec([[0x00, ...uleb(spec.memory.min)]])));

  // export section (7)
  const exportSec = vec(spec.exports.map((e) => [...str(e.name), e.kind, ...uleb(e.index)]));
  bytes.push(...section(7, exportSec));

  // code section (10)
  const codeSec = vec(spec.funcs.map((f) => {
    const localsDecl = f.locals ? vec(f.locals.map((l) => [...uleb(l.count), l.type])) : vec([]);
    const body = [...localsDecl, ...f.body, 0x0b]; // end
    return [...uleb(body.length), ...body];
  }));
  bytes.push(...section(10, codeSec));

  // data section (11)
  if (spec.data && spec.data.length) {
    const dataSec = vec(spec.data.map((d) => [0x00, 0x41, ...sleb(d.offset), 0x0b, ...uleb(d.bytes.length), ...d.bytes]));
    bytes.push(...section(11, dataSec));
  }
  return new Uint8Array(bytes);
}

// opcodes
const I32_CONST = 0x41, I64_CONST = 0x42, CALL = 0x10, DROP = 0x1a, I32_STORE = 0x36, I32_LOAD = 0x28, LOCAL_GET = 0x20, LOCAL_SET = 0x21;
const I64 = 0x7e;

// fd_write(i32,i32,i32,i32)->i32 ; proc_exit(i32)->() ; path_open(9 args)->i32
// fd_read(i32,i32,i32,i32)->i32 ; fd_close(i32)->i32

/** hello: write a string to stdout via fd_write, exit 0. */
function helloModule(text = "hello wasi\n") {
  const strOff = 100, iovOff = 0, nwrittenOff = 200;
  const strBytes = [...enc.encode(text)];
  return buildModule({
    types: [
      { params: [I32, I32, I32, I32], results: [I32] }, // 0: fd_write
      { params: [I32], results: [] },                    // 1: proc_exit
      { params: [], results: [] },                       // 2: _start
    ],
    imports: [
      { module: "wasi_snapshot_preview1", name: "fd_write", type: 0 },
      { module: "wasi_snapshot_preview1", name: "proc_exit", type: 1 },
    ],
    funcs: [{ type: 2, body: [
      // store iovec.buf = strOff, iovec.buf_len = len at iovOff
      I32_CONST, ...sleb(iovOff), I32_CONST, ...sleb(strOff), I32_STORE, 0x02, 0x00,
      I32_CONST, ...sleb(iovOff + 4), I32_CONST, ...sleb(strBytes.length), I32_STORE, 0x02, 0x00,
      // fd_write(1, iovOff, 1, nwrittenOff)
      I32_CONST, 0x01, I32_CONST, ...sleb(iovOff), I32_CONST, 0x01, I32_CONST, ...sleb(nwrittenOff),
      CALL, ...uleb(0), DROP,
    ] }],
    memory: { min: 1 },
    exports: [{ name: "memory", kind: KIND_MEM, index: 0 }, { name: "_start", kind: KIND_FUNC, index: 2 }],
    data: [{ offset: strOff, bytes: strBytes }],
  });
}

/** exit with a given code via proc_exit. */
function exitModule(code) {
  return buildModule({
    types: [{ params: [I32], results: [] }, { params: [], results: [] }],
    imports: [{ module: "wasi_snapshot_preview1", name: "proc_exit", type: 0 }],
    funcs: [{ type: 1, body: [I32_CONST, ...sleb(code), CALL, ...uleb(0)] }],
    memory: { min: 1 },
    exports: [{ name: "memory", kind: KIND_MEM, index: 0 }, { name: "_start", kind: KIND_FUNC, index: 1 }],
  });
}

/**
 * readFile: path_open a file relative to preopen fd 3, read up to 256 bytes,
 * fd_write them to stdout. The path bytes are baked into data. Used for the
 * preopen structural-scope test (reads inside → OK; '..' escape → nonzero).
 */
function readFileModule(relPath) {
  const pathOff = 300, pathBytes = [...enc.encode(relPath)];
  const openedFdOff = 8, iovOff = 16, bufOff = 512, nreadOff = 24, nwrittenOff = 28;
  // locals: 1 i32 for opened fd
  const FD_LOCAL = 0;
  return buildModule({
    types: [
      { params: [I32, I32, I32, I32], results: [I32] },                                        // 0: fd_write / fd_read shape
      { params: [I32], results: [] },                                                          // 1: proc_exit
      { params: [I32, I32, I32, I32, I32, I64, I64, I32, I32], results: [I32] },                // 2: path_open (rights are i64)
      { params: [], results: [] },                                                             // 3: _start
    ],
    imports: [
      { module: "wasi_snapshot_preview1", name: "fd_write", type: 0 },   // func 0
      { module: "wasi_snapshot_preview1", name: "proc_exit", type: 1 },  // func 1
      { module: "wasi_snapshot_preview1", name: "path_open", type: 2 },  // func 2
      { module: "wasi_snapshot_preview1", name: "fd_read", type: 0 },    // func 3
    ],
    funcs: [{ type: 3, locals: [{ count: 1, type: I32 }], body: [
      // path_open(dirfd=3, dirflags=0, path=pathOff, pathLen, oflags=0,
      //           rights_base(i64), rights_inheriting(i64), fdflags=0, openedFdOut)
      I32_CONST, 0x03, I32_CONST, 0x00, I32_CONST, ...sleb(pathOff), I32_CONST, ...sleb(pathBytes.length),
      I32_CONST, 0x00,
      I64_CONST, ...sleb(0x02) /* FD_READ right (bit 1) */, I64_CONST, ...sleb(0),
      I32_CONST, 0x00,
      I32_CONST, ...sleb(openedFdOff),
      CALL, ...uleb(2), DROP,
      // fd = i32.load openedFdOff → local
      I32_CONST, ...sleb(openedFdOff), I32_LOAD, 0x02, 0x00,
      LOCAL_SET, FD_LOCAL,
      // iovec for read: buf=bufOff, len=256
      I32_CONST, ...sleb(iovOff), I32_CONST, ...sleb(bufOff), I32_STORE, 0x02, 0x00,
      I32_CONST, ...sleb(iovOff + 4), I32_CONST, ...sleb(256), I32_STORE, 0x02, 0x00,
      // fd_read(fd, iovOff, 1, nreadOff)
      LOCAL_GET, FD_LOCAL, I32_CONST, ...sleb(iovOff), I32_CONST, 0x01, I32_CONST, ...sleb(nreadOff),
      CALL, ...uleb(3), DROP,
      // iovec for write: buf=bufOff, len=nread (load nread from memory)
      I32_CONST, ...sleb(iovOff), I32_CONST, ...sleb(bufOff), I32_STORE, 0x02, 0x00,
      I32_CONST, ...sleb(iovOff + 4), I32_CONST, ...sleb(nreadOff), I32_LOAD, 0x02, 0x00, I32_STORE, 0x02, 0x00,
      // fd_write(1, iovOff, 1, nwrittenOff)
      I32_CONST, 0x01, I32_CONST, ...sleb(iovOff), I32_CONST, 0x01, I32_CONST, ...sleb(nwrittenOff),
      CALL, ...uleb(0), DROP,
    ] }],
    memory: { min: 1 },
    // _start is the first DEFINED function → index = import count (4).
    exports: [{ name: "memory", kind: KIND_MEM, index: 0 }, { name: "_start", kind: KIND_FUNC, index: 4 }],
    data: [{ offset: pathOff, bytes: pathBytes }],
  });
}

export { helloModule, exitModule, readFileModule, buildModule };
