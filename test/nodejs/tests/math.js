let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (got === exp) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + got + ', expected ' + exp + '\n');
}
check('add', 1 + 1, 2);
check('mul', 6 * 7, 42);
check('pow', 2 ** 10, 1024);
check('sqrt', Math.sqrt(144), 12);
check('floor', Math.floor(3.7), 3);
check('ceil', Math.ceil(3.2), 4);
check('abs', Math.abs(-5), 5);
check('max', Math.max(1, 3, 2), 3);
check('min', Math.min(1, 3, 2), 1);
check('isNaN', Number.isNaN(NaN), true);
check('isFinite', Number.isFinite(42), true);
check('parseInt', parseInt('0xFF', 16), 255);
check('parseFloat', parseFloat('3.14'), 3.14);
console.log('PASS: math ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
