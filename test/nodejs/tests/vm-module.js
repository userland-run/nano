const vm = require('vm');
let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Basic eval in context
const ctx = { x: 10, y: 20 };
vm.createContext(ctx);
const result = vm.runInContext('x + y', ctx);
check('basic-eval', result, 30);

// Script reuse
const script = new vm.Script('counter++');
const ctx2 = vm.createContext({ counter: 0 });
script.runInContext(ctx2);
script.runInContext(ctx2);
script.runInContext(ctx2);
check('script-reuse', ctx2.counter, 3);

// Isolated contexts don't share state
const ctxA = vm.createContext({ value: 1 });
const ctxB = vm.createContext({ value: 100 });
vm.runInContext('value += 10', ctxA);
vm.runInContext('value += 10', ctxB);
check('isolated-A', ctxA.value, 11);
check('isolated-B', ctxB.value, 110);

// Functions defined in sandbox
vm.runInContext('function double(n) { return n * 2; }', ctx);
check('sandbox-fn', vm.runInContext('double(21)', ctx), 42);

// Syntax error handling
let syntaxErr = false;
try {
  vm.runInContext('function {bad', vm.createContext({}));
} catch(e) {
  syntaxErr = e instanceof SyntaxError;
}
check('syntaxError', syntaxErr, true);

// runInNewContext
const res2 = vm.runInNewContext('a * b + c', { a: 2, b: 3, c: 4 });
check('newContext', res2, 10);

// Context with built-ins
const ctx3 = vm.createContext({ JSON, Math, Array });
const res3 = vm.runInContext('JSON.stringify(Array.from({length:3}, (_, i) => Math.pow(2, i)))', ctx3);
check('builtins', res3, '[1,2,4]');

// Error propagation
let errMsg = '';
try {
  vm.runInNewContext('throw new Error("sandbox error")');
} catch(e) {
  errMsg = e.message;
}
check('error-prop', errMsg, 'sandbox error');

// Global not leaked
const ctx4 = vm.createContext({});
vm.runInContext('var leaked = 42', ctx4);
check('no-leak', typeof leaked, 'undefined');
check('ctx-has', ctx4.leaked, 42);

console.log('PASS: vm-module ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
