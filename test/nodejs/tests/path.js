const path = require('path');
let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (got === exp) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}
check('join', path.join('/foo', 'bar', 'baz'), '/foo/bar/baz');
check('dirname', path.dirname('/foo/bar/baz.js'), '/foo/bar');
check('basename', path.basename('/foo/bar/baz.js'), 'baz.js');
check('extname', path.extname('file.txt'), '.txt');
check('isAbsolute', path.isAbsolute('/foo'), true);
check('normalize', path.normalize('/foo/bar/../baz'), '/foo/baz');
const p = path.parse('/foo/bar/baz.js');
check('parse.dir', p.dir, '/foo/bar');
check('parse.base', p.base, 'baz.js');
check('parse.ext', p.ext, '.js');
check('parse.name', p.name, 'baz');
console.log('PASS: path ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
