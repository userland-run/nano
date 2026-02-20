/**
 * Lodash test — exercises core utility functions.
 */
const _ = require('lodash');

let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Array
check('chunk', _.chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);
check('compact', _.compact([0, 1, false, 2, '', 3, null]), [1, 2, 3]);
check('flatten', _.flatten([1, [2, [3, [4]]]]), [1, 2, [3, [4]]]);
check('flattenDeep', _.flattenDeep([1, [2, [3, [4]]]]), [1, 2, 3, 4]);
check('uniq', _.uniq([1, 2, 1, 3, 2, 4]), [1, 2, 3, 4]);
check('intersection', _.intersection([1,2,3], [2,3,4], [3,4,5]), [3]);
check('difference', _.difference([1,2,3,4], [2,4]), [1, 3]);
check('zip', _.zip(['a','b','c'], [1,2,3]), [['a',1],['b',2],['c',3]]);
check('unzip', _.unzip([['a',1],['b',2],['c',3]]), [['a','b','c'],[1,2,3]]);

// Collection
const users = [
  { name: 'Alice', age: 30, active: true },
  { name: 'Bob', age: 25, active: false },
  { name: 'Charlie', age: 35, active: true },
  { name: 'Diana', age: 28, active: true },
];
check('filter', _.filter(users, { active: true }).length, 3);
check('find', _.find(users, { name: 'Bob' }).age, 25);
check('sortBy', _.sortBy(users, 'age').map(u => u.name), ['Bob', 'Diana', 'Alice', 'Charlie']);
check('groupBy', Object.keys(_.groupBy(users, 'active')).sort(), ['false', 'true']);
check('map', _.map(users, 'name'), ['Alice', 'Bob', 'Charlie', 'Diana']);
check('keyBy', _.keyBy(users, 'name').Alice.age, 30);
check('countBy', _.countBy(users, 'active'), { true: 3, false: 1 });
check('sumBy', _.sumBy(users, 'age'), 118);
check('minBy', _.minBy(users, 'age').name, 'Bob');
check('maxBy', _.maxBy(users, 'age').name, 'Charlie');

// Object
const obj = { a: 1, b: 2, c: 3, d: 4 };
check('pick', _.pick(obj, ['a', 'c']), { a: 1, c: 3 });
check('omit', _.omit(obj, ['b', 'd']), { a: 1, c: 3 });
check('mapValues', _.mapValues(obj, v => v * 10), { a: 10, b: 20, c: 30, d: 40 });
check('merge', _.merge({ a: 1, b: { x: 1 } }, { b: { y: 2 }, c: 3 }), { a: 1, b: { x: 1, y: 2 }, c: 3 });
check('get-nested', _.get({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
check('get-default', _.get({}, 'a.b.c', 'missing'), 'missing');
check('set', _.set({}, 'a.b.c', 42), { a: { b: { c: 42 } } });

// String
check('camelCase', _.camelCase('hello world'), 'helloWorld');
check('snakeCase', _.snakeCase('helloWorld'), 'hello_world');
check('kebabCase', _.kebabCase('Hello World'), 'hello-world');
check('capitalize', _.capitalize('hello'), 'Hello');
check('truncate', _.truncate('hello world this is a test', { length: 15 }), 'hello world ...');
check('pad', _.pad('abc', 7, '-'), '--abc--');

// Function
const add = (a, b) => a + b;
const add5 = _.partial(add, 5);
check('partial', add5(3), 8);
const addCurried = _.curry(add);
check('curry', addCurried(1)(2), 3);
const triple = _.flow([x => x + 1, x => x * 3]);
check('flow', triple(3), 12);

// Deep clone
const original = { a: [1, { b: 2 }], c: new Date('2024-01-01') };
const cloned = _.cloneDeep(original);
cloned.a[1].b = 99;
check('cloneDeep', original.a[1].b, 2);

// Range
check('range', _.range(0, 10, 2), [0, 2, 4, 6, 8]);

// Template
const compiled = _.template('Hello <%= name %>!');
check('template', compiled({ name: 'NanoVM' }), 'Hello NanoVM!');

console.log('PASS: lodash ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
