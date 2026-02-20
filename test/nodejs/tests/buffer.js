let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (got === exp) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}
const buf = Buffer.from('hello');
check('length', buf.length, 5);
check('toString', buf.toString(), 'hello');
check('index', buf[0], 0x68);
const buf2 = Buffer.alloc(4);
buf2.writeUInt32BE(0x01020304);
check('readU32', buf2.readUInt32BE(), 0x01020304);
check('hex', Buffer.from([0xde, 0xad]).toString('hex'), 'dead');
check('base64', Buffer.from('hello').toString('base64'), 'aGVsbG8=');
check('fromBase64', Buffer.from('aGVsbG8=', 'base64').toString(), 'hello');
check('concat', Buffer.concat([Buffer.from('ab'), Buffer.from('cd')]).toString(), 'abcd');
check('slice', buf.slice(1,3).toString(), 'el');
console.log('PASS: buffer ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
