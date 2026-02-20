let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Generator basics
function* range(start, end) {
  for (let i = start; i <= end; i++) yield i;
}
check('gen-spread', [...range(1, 5)], [1, 2, 3, 4, 5]);

// Generator with return
function* gen() { yield 1; yield 2; return 3; }
const g = gen();
check('gen-next1', g.next(), { value: 1, done: false });
check('gen-next2', g.next(), { value: 2, done: false });
check('gen-return', g.next(), { value: 3, done: true });

// yield delegation
function* inner() { yield 'a'; yield 'b'; }
function* outer() { yield 1; yield* inner(); yield 2; }
check('yield-star', [...outer()], [1, 'a', 'b', 2]);

// Infinite generator with take
function* naturals() { let n = 1; while (true) yield n++; }
function take(iter, n) {
  const r = [];
  for (const v of iter) { r.push(v); if (r.length >= n) break; }
  return r;
}
check('infinite-gen', take(naturals(), 5), [1, 2, 3, 4, 5]);

// Map/Set iteration
const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
check('map-keys', [...m.keys()], ['a', 'b', 'c']);
check('map-values', [...m.values()], [1, 2, 3]);
check('map-entries', [...m.entries()], [['a', 1], ['b', 2], ['c', 3]]);

const s = new Set([3, 1, 4, 1, 5, 9, 2, 6]);
check('set-unique', s.size, 7);
check('set-has', s.has(4), true);

// for...of with destructuring
const pairs = new Map([['x', 10], ['y', 20]]);
const result = [];
for (const [k, v] of pairs) result.push(k + '=' + v);
check('for-of-destruct', result, ['x=10', 'y=20']);

// Array destructuring with rest
const [first, second, ...rest] = [1, 2, 3, 4, 5];
check('destruct-first', first, 1);
check('destruct-rest', rest, [3, 4, 5]);

// Object destructuring with rename and default
const { a: x = 10, b: y = 20, c: z = 30 } = { a: 1, b: 2 };
check('obj-destruct', [x, y, z], [1, 2, 30]);

// Symbol
const sym = Symbol('test');
check('symbol-typeof', typeof sym, 'symbol');
check('symbol-desc', sym.description, 'test');
const obj = { [sym]: 'hidden', visible: true };
check('symbol-prop', obj[sym], 'hidden');
check('symbol-keys', Object.keys(obj), ['visible']);

// Well-known symbols
class MyArray {
  static [Symbol.hasInstance](instance) {
    return Array.isArray(instance);
  }
}
check('symbol-hasInstance', [] instanceof MyArray, true);

console.log('PASS: iterators ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
