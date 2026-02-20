let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

try { throw new Error('test'); } catch (e) { check('throw-catch', e.message === 'test'); }
try { JSON.parse('{invalid}'); check('json-error', false); } catch (e) { check('json-error', e instanceof SyntaxError); }
try { null.foo; check('type-error', false); } catch (e) { check('type-error', e instanceof TypeError); }
try { eval('function('); check('syntax-error', false); } catch (e) { check('syntax-error', e instanceof SyntaxError); }

const err = new Error('custom');
check('stack', typeof err.stack === 'string');
check('name', err.name === 'Error');
check('message', err.message === 'custom');

class CustomError extends Error {
  constructor(msg) { super(msg); this.name = 'CustomError'; }
}
const ce = new CustomError('test');
check('custom-class', ce instanceof CustomError && ce instanceof Error);
check('custom-name', ce.name === 'CustomError');

console.log('PASS: error-handling ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
