let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}
check('version', typeof process.version === 'string' && process.version.startsWith('v'));
check('arch', process.arch === 'riscv64');
check('platform', process.platform === 'linux');
check('pid', typeof process.pid === 'number' && process.pid > 0);
check('argv', Array.isArray(process.argv) && process.argv.length >= 1);
check('env', typeof process.env === 'object');
check('cwd', typeof process.cwd() === 'string');
check('exit-fn', typeof process.exit === 'function');
console.log('PASS: process ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
