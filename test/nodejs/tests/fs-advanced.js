const fs = require('fs');
const path = require('path');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

// mkdir recursive
fs.mkdirSync('/tmp/a/b/c', { recursive: true });
check('mkdir-recursive', fs.existsSync('/tmp/a/b/c'));

// writeFile + readFile
fs.writeFileSync('/tmp/a/b/c/test.json', JSON.stringify({ hello: 'world' }));
const data = JSON.parse(fs.readFileSync('/tmp/a/b/c/test.json', 'utf8'));
check('json-roundtrip', data.hello === 'world');

// appendFile
fs.writeFileSync('/tmp/log.txt', 'line1\n');
fs.appendFileSync('/tmp/log.txt', 'line2\n');
fs.appendFileSync('/tmp/log.txt', 'line3\n');
const log = fs.readFileSync('/tmp/log.txt', 'utf8');
check('appendFile', log === 'line1\nline2\nline3\n');

// readdir
fs.writeFileSync('/tmp/a/file1.txt', 'one');
fs.writeFileSync('/tmp/a/file2.txt', 'two');
const entries = fs.readdirSync('/tmp/a');
check('readdir-has-file1', entries.includes('file1.txt'));
check('readdir-has-file2', entries.includes('file2.txt'));
check('readdir-has-b', entries.includes('b'));

// stat
const stat = fs.statSync('/tmp/a/file1.txt');
check('stat-isFile', stat.isFile());
check('stat-size', stat.size === 3);
const dstat = fs.statSync('/tmp/a/b');
check('stat-isDir', dstat.isDirectory());

// rename
fs.renameSync('/tmp/a/file1.txt', '/tmp/a/moved.txt');
check('rename-new', fs.existsSync('/tmp/a/moved.txt'));
check('rename-old-gone', !fs.existsSync('/tmp/a/file1.txt'));

// unlink
fs.unlinkSync('/tmp/a/file2.txt');
check('unlink', !fs.existsSync('/tmp/a/file2.txt'));

// copyFile via read+write
const src = fs.readFileSync('/tmp/a/moved.txt');
fs.writeFileSync('/tmp/a/copy.txt', src);
check('copy', fs.readFileSync('/tmp/a/copy.txt', 'utf8') === 'one');

// Large file
const bigData = 'x'.repeat(100000);
fs.writeFileSync('/tmp/big.txt', bigData);
check('big-write-read', fs.readFileSync('/tmp/big.txt', 'utf8').length === 100000);

console.log('PASS: fs-advanced ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
