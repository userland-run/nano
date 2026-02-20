let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (got === exp) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}
const u = new URL('https://user:pass@example.com:8080/path?q=1#hash');
check('protocol', u.protocol, 'https:');
check('username', u.username, 'user');
check('password', u.password, 'pass');
check('hostname', u.hostname, 'example.com');
check('port', u.port, '8080');
check('pathname', u.pathname, '/path');
check('search', u.search, '?q=1');
check('hash', u.hash, '#hash');

const params = new URLSearchParams('a=1&b=2&c=3');
check('params.get', params.get('b'), '2');
check('params.has', params.has('a'), true);
check('params.size', [...params].length, 3);

console.log('PASS: url ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
