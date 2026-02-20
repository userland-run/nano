let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Map operations
const m = new Map();
m.set('a', 1).set('b', 2).set('c', 3);
check('map-size', m.size, 3);
check('map-get', m.get('b'), 2);
check('map-has', m.has('c'), true);
m.delete('b');
check('map-delete', m.size, 2);
check('map-spread', [...m], [['a', 1], ['c', 3]]);

// Map with complex keys
const objKey = { id: 1 };
const m2 = new Map();
m2.set(objKey, 'found');
check('map-objkey', m2.get(objKey), 'found');
check('map-objkey-miss', m2.get({ id: 1 }), undefined); // different reference

// Set operations
const s1 = new Set([1, 2, 3, 4, 5]);
const s2 = new Set([4, 5, 6, 7, 8]);
const union = new Set([...s1, ...s2]);
check('set-union', union.size, 8);
const intersect = new Set([...s1].filter(x => s2.has(x)));
check('set-intersect', [...intersect], [4, 5]);
const diff = new Set([...s1].filter(x => !s2.has(x)));
check('set-diff', [...diff], [1, 2, 3]);

// WeakMap
const wm = new WeakMap();
const key1 = {};
const key2 = {};
wm.set(key1, 'val1');
wm.set(key2, 'val2');
check('weakmap-get', wm.get(key1), 'val1');
check('weakmap-has', wm.has(key2), true);

// WeakSet
const ws = new WeakSet();
const item = {};
ws.add(item);
check('weakset-has', ws.has(item), true);

// Object operations
const obj = { a: 1, b: 2, c: 3 };
check('obj-keys', Object.keys(obj), ['a', 'b', 'c']);
check('obj-values', Object.values(obj), [1, 2, 3]);
check('obj-entries', Object.entries(obj), [['a', 1], ['b', 2], ['c', 3]]);
check('obj-fromEntries', Object.fromEntries([['x', 10], ['y', 20]]), { x: 10, y: 20 });

// Object.assign and spread
const merged = { ...obj, d: 4 };
check('spread-merge', merged, { a: 1, b: 2, c: 3, d: 4 });
const assigned = Object.assign({}, obj, { b: 99 });
check('assign-override', assigned.b, 99);

// Object.freeze / Object.seal
const frozen = Object.freeze({ x: 1, y: 2 });
check('freeze-isFrozen', Object.isFrozen(frozen), true);

// Array methods
const arr = [1, 2, 3, 4, 5];
check('flat', [[1, 2], [3, [4, 5]]].flat(2), [1, 2, 3, 4, 5]);
check('flatMap', arr.flatMap(x => [x, x * 2]), [1, 2, 2, 4, 3, 6, 4, 8, 5, 10]);
check('findIndex', arr.findIndex(x => x > 3), 3);
check('includes', arr.includes(3), true);
check('at', arr.at(-1), 5);
check('at-neg', arr.at(-2), 4);

// Array.from with mapFn
check('array-from', Array.from({ length: 5 }, (_, i) => i * i), [0, 1, 4, 9, 16]);

// groupBy (Node 21+)
const items = [
  { type: 'fruit', name: 'apple' },
  { type: 'veggie', name: 'carrot' },
  { type: 'fruit', name: 'banana' },
];
const grouped = Object.groupBy(items, i => i.type);
check('groupBy-fruit', grouped.fruit.length, 2);
check('groupBy-veggie', grouped.veggie.length, 1);

console.log('PASS: collections ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
