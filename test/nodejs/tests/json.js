let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}
const obj = { a: 1, b: [2, 3], c: { d: true } };
const str = JSON.stringify(obj);
const parsed = JSON.parse(str);
check('stringify', str, '{"a":1,"b":[2,3],"c":{"d":true}}');
check('parse.a', parsed.a, 1);
check('parse.b', parsed.b, [2, 3]);
check('parse.c.d', parsed.c.d, true);
check('null', JSON.stringify(null), 'null');
check('number', JSON.parse('42'), 42);
check('string', JSON.parse('"hello"'), 'hello');
check('array', JSON.parse('[1,2,3]'), [1, 2, 3]);
console.log('PASS: json ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
