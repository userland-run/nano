let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Basic Proxy
const handler = {
  get(target, prop) {
    return prop in target ? target[prop] : `no ${prop}`;
  },
  set(target, prop, value) {
    target[prop] = typeof value === 'string' ? value.toUpperCase() : value;
    return true;
  }
};
const p = new Proxy({}, handler);
p.name = 'hello';
check('proxy-set', p.name, 'HELLO');
check('proxy-default', p.missing, 'no missing');

// Proxy with has trap
const rangeHandler = {
  has(target, prop) {
    const n = Number(prop);
    return n >= target.min && n <= target.max;
  }
};
const range = new Proxy({ min: 1, max: 10 }, rangeHandler);
check('proxy-has-true', 5 in range, true);
check('proxy-has-false', 15 in range, false);

// Proxy validation
function createValidator(schema) {
  return new Proxy({}, {
    set(target, prop, value) {
      const validator = schema[prop];
      if (validator && !validator(value)) {
        throw new TypeError(`Invalid value for ${prop}`);
      }
      target[prop] = value;
      return true;
    }
  });
}
const person = createValidator({
  age: v => typeof v === 'number' && v > 0 && v < 150,
  name: v => typeof v === 'string' && v.length > 0,
});
person.name = 'Alice';
person.age = 30;
check('validator-ok', person.name, 'Alice');
let caught = false;
try { person.age = -5; } catch(e) { caught = true; }
check('validator-fail', caught, true);

// Reflect
check('reflect-get', Reflect.get({ a: 1 }, 'a'), 1);
check('reflect-has', Reflect.has({ a: 1 }, 'a'), true);
const obj = {};
Reflect.set(obj, 'x', 42);
check('reflect-set', obj.x, 42);
Reflect.defineProperty(obj, 'y', { value: 99, writable: false });
check('reflect-define', obj.y, 99);
check('reflect-ownKeys', Reflect.ownKeys({ a: 1, b: 2 }), ['a', 'b']);

// Observable pattern with Proxy
const observable = (target, onChange) => new Proxy(target, {
  set(obj, prop, value) {
    const old = obj[prop];
    obj[prop] = value;
    onChange(prop, old, value);
    return true;
  }
});
const changes = [];
const observed = observable({ x: 0 }, (prop, old, val) => changes.push({ prop, old, val }));
observed.x = 1;
observed.x = 2;
check('observable-count', changes.length, 2);
check('observable-first', changes[0], { prop: 'x', old: 0, val: 1 });

// Revocable proxy
const { proxy: rev, revoke } = Proxy.revocable({ data: 'ok' }, {});
check('revocable-before', rev.data, 'ok');
revoke();
let revErr = false;
try { rev.data; } catch(e) { revErr = true; }
check('revocable-after', revErr, true);

console.log('PASS: proxy-reflect ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
