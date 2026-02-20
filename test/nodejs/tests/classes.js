let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Basic class
class Animal {
  #name;
  constructor(name) { this.#name = name; }
  get name() { return this.#name; }
  speak() { return this.#name + ' makes a sound'; }
}
const a = new Animal('Dog');
check('private-field', a.name, 'Dog');
check('method', a.speak(), 'Dog makes a sound');

// Inheritance
class Dog extends Animal {
  #breed;
  constructor(name, breed) { super(name); this.#breed = breed; }
  speak() { return this.name + ' barks'; }
  get breed() { return this.#breed; }
}
const d = new Dog('Rex', 'Labrador');
check('extends', d.speak(), 'Rex barks');
check('super', d.name, 'Rex');
check('instanceof-child', d instanceof Dog, true);
check('instanceof-parent', d instanceof Animal, true);
check('child-field', d.breed, 'Labrador');

// Static methods
class Counter {
  static count = 0;
  static increment() { return ++Counter.count; }
  static reset() { Counter.count = 0; }
}
check('static-1', Counter.increment(), 1);
check('static-2', Counter.increment(), 2);
Counter.reset();
check('static-reset', Counter.count, 0);

// Symbol.iterator
class Range {
  constructor(start, end) { this.start = start; this.end = end; }
  [Symbol.iterator]() {
    let cur = this.start;
    const end = this.end;
    return { next() { return cur <= end ? { value: cur++, done: false } : { done: true }; } };
  }
}
check('iterator', [...new Range(1, 5)], [1, 2, 3, 4, 5]);

// toString/valueOf
class Temp {
  constructor(c) { this.celsius = c; }
  valueOf() { return this.celsius; }
  toString() { return this.celsius + '°C'; }
}
const t = new Temp(100);
check('valueOf', t + 0, 100);
check('toString', `${t}`, '100°C');

// Mixin pattern
const Serializable = (Base) => class extends Base {
  toJSON() {
    const obj = {};
    for (const key of Object.keys(this)) obj[key] = this[key];
    return obj;
  }
};
class Point extends Serializable(Object) {
  constructor(x, y) { super(); this.x = x; this.y = y; }
}
const p = new Point(1, 2);
check('mixin', JSON.stringify(p.toJSON()), '{"x":1,"y":2}');

// WeakRef
let ref;
{
  const obj = { data: 'alive' };
  ref = new WeakRef(obj);
  check('weakref-deref', ref.deref().data, 'alive');
}

console.log('PASS: classes ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
