const assert = require('assert');
const util = require('util');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

// assert.strictEqual
try { assert.strictEqual(1 + 1, 2); check('strictEqual', true); }
catch { check('strictEqual', false); }

// assert.deepStrictEqual
try { assert.deepStrictEqual({ a: [1, 2] }, { a: [1, 2] }); check('deepEqual', true); }
catch { check('deepEqual', false); }

// assert.throws
try {
  assert.throws(() => { throw new TypeError('bad'); }, TypeError);
  check('throws', true);
} catch { check('throws', false); }

// assert.doesNotThrow
try { assert.doesNotThrow(() => 42); check('doesNotThrow', true); }
catch { check('doesNotThrow', false); }

// assert.rejects (async)
// Skipped for simplicity

// assert.fail
let failed = false;
try { assert.fail('oops'); } catch (e) { failed = e.message === 'oops'; }
check('fail', failed);

// util.format
check('format-s', util.format('hello %s', 'world') === 'hello world');
check('format-d', util.format('n=%d', 42) === 'n=42');
check('format-j', util.format('%j', { a: 1 }) === '{"a":1}');
check('format-o', util.format('%o', { a: 1 }).includes('a'));

// util.inspect
const obj = { name: 'test', nested: { arr: [1, 2, 3], fn: () => {} } };
const inspected = util.inspect(obj, { depth: 2, colors: false });
check('inspect-has-name', inspected.includes('test'));
check('inspect-has-arr', inspected.includes('1, 2, 3'));
check('inspect-has-fn', inspected.includes('Function') || inspected.includes('=>'));

// util.types
check('types-isDate', util.types.isDate(new Date()));
check('types-isMap', util.types.isMap(new Map()));
check('types-isSet', util.types.isSet(new Set()));
check('types-isRegExp', util.types.isRegExp(/foo/));
check('types-isPromise', util.types.isPromise(Promise.resolve()));

// util.promisify
const sleep = util.promisify(setTimeout);
check('promisify', typeof sleep === 'function');

// util.inherits (legacy but still supported)
function Base() { this.type = 'base'; }
Base.prototype.hello = function() { return 'hi from ' + this.type; };
function Child() { Base.call(this); this.type = 'child'; }
util.inherits(Child, Base);
const c = new Child();
check('inherits', c.hello() === 'hi from child');
check('inherits-proto', c instanceof Base);

// TextEncoder/TextDecoder
const enc = new TextEncoder();
const dec = new TextDecoder();
const encoded = enc.encode('Hello 🌍');
check('textenc-type', encoded instanceof Uint8Array);
check('textdec', dec.decode(encoded) === 'Hello 🌍');

// structuredClone
const original = { a: 1, b: [2, 3], c: new Date('2024-01-01'), d: new Map([['x', 1]]) };
const cloned = structuredClone(original);
check('clone-equal', cloned.a === 1 && cloned.b[0] === 2);
check('clone-date', cloned.c instanceof Date);
check('clone-map', cloned.d instanceof Map && cloned.d.get('x') === 1);
cloned.b.push(4);
check('clone-independent', original.b.length === 2);

console.log('PASS: assert-util ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
