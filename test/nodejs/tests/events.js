const { EventEmitter } = require('events');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}
const ee = new EventEmitter();
let called = false;
ee.on('test', () => { called = true; });
ee.emit('test');
check('emit', called);

let count = 0;
ee.on('inc', () => count++);
ee.emit('inc'); ee.emit('inc');
check('multiple', count === 2);

let once = 0;
ee.once('one', () => once++);
ee.emit('one'); ee.emit('one');
check('once', once === 1);

let removed = 0;
const fn = () => removed++;
ee.on('rem', fn);
ee.removeListener('rem', fn);
ee.emit('rem');
check('removeListener', removed === 0);

console.log('PASS: events ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
