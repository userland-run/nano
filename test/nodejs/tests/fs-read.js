const fs = require('fs');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}
try {
  const data = fs.readFileSync('/etc/hostname', 'utf8');
  check('readFile', data.includes('nanovm'));
} catch (e) {
  check('readFile', false);
  process.stderr.write('  ' + e.message + '\n');
}
try {
  check('existsSync', fs.existsSync('/etc/hostname'));
} catch (e) {
  check('existsSync', false);
}
try {
  const stat = fs.statSync('/etc/hostname');
  check('statSync', stat.size > 0);
} catch (e) {
  check('statSync', false);
}
console.log('PASS: fs-read ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
