const { Readable, Writable } = require('stream');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

const chunks = [];
const readable = new Readable({
  read() {
    this.push('hello ');
    this.push('world');
    this.push(null);
  }
});
readable.on('data', chunk => chunks.push(chunk.toString()));
readable.on('end', () => {
  check('readable', chunks.join('') === 'hello world');

  let written = '';
  const writable = new Writable({
    write(chunk, enc, cb) { written += chunk.toString(); cb(); }
  });
  writable.write('foo');
  writable.end('bar');
  writable.on('finish', () => {
    check('writable', written === 'foobar');
    console.log('PASS: stream ' + ok + '/' + total);
    process.exit(ok === total ? 0 : 1);
  });
});
