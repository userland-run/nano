let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (got === exp) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}
check('length', 'hello'.length, 5);
check('upper', 'hello'.toUpperCase(), 'HELLO');
check('lower', 'HELLO'.toLowerCase(), 'hello');
check('slice', 'hello world'.slice(0, 5), 'hello');
check('indexOf', 'hello'.indexOf('ll'), 2);
check('includes', 'hello'.includes('ell'), true);
check('startsWith', 'hello'.startsWith('hel'), true);
check('endsWith', 'hello'.endsWith('llo'), true);
check('trim', '  hi  '.trim(), 'hi');
check('split', 'a,b,c'.split(',').length, 3);
check('replace', 'hello'.replace('l', 'r'), 'herlo');
check('repeat', 'ab'.repeat(3), 'ababab');
check('padStart', '5'.padStart(3, '0'), '005');
check('template', `${1+1}`, '2');
console.log('PASS: string ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
