const fs = require('fs');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}
try {
  fs.writeFileSync('/tmp/test-write.txt', 'hello nanovm');
  const data = fs.readFileSync('/tmp/test-write.txt', 'utf8');
  check('write-read', data === 'hello nanovm');
} catch (e) {
  check('write-read', false);
  process.stderr.write('  ' + e.message + '\n');
}
try {
  fs.appendFileSync('/tmp/test-write.txt', ' appended');
  const data = fs.readFileSync('/tmp/test-write.txt', 'utf8');
  check('append', data === 'hello nanovm appended');
} catch (e) {
  check('append', false);
}
try {
  fs.mkdirSync('/tmp/testdir', { recursive: true });
  check('mkdir', fs.existsSync('/tmp/testdir'));
} catch (e) {
  check('mkdir', false);
}
console.log('PASS: fs-write ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
