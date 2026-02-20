let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Named groups
const dateRe = /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/;
const m = '2024-03-15'.match(dateRe);
check('named-year', m.groups.year, '2024');
check('named-month', m.groups.month, '03');
check('named-day', m.groups.day, '15');

// Lookbehind
const prices = '$10 €20 $30 €40'.match(/(?<=\$)\d+/g);
check('lookbehind', prices, ['10', '30']);

// Lookahead
const words = 'foo123 bar baz456'.match(/\w+(?=\d)/g);
check('lookahead', words, ['foo12', 'baz45']);

// Unicode basic matching (property escapes need ICU, so test simpler patterns)
const emoji = '🎉 hello 🌍 world 🚀'.match(/[\u{1F300}-\u{1F9FF}]/gu);
check('unicode-emoji', emoji, ['🎉', '🌍', '🚀']);

// dotAll flag
const multiline = 'line1\nline2\nline3';
check('dotall', /line1.+line3/s.test(multiline), true);
check('no-dotall', /line1.+line3/.test(multiline), false);

// matchAll
const iter = 'test1 test2 test3'.matchAll(/test(\d)/g);
const matches = [...iter].map(m => m[1]);
check('matchAll', matches, ['1', '2', '3']);

// Replace with function
const result = 'hello world'.replace(/\b(\w)/g, (_, c) => c.toUpperCase());
check('replace-fn', result, 'Hello World');

// Split with regex
check('split-regex', 'a1b2c3d'.split(/\d/), ['a', 'b', 'c', 'd']);

// Sticky flag
const stickyRe = /\d+/y;
stickyRe.lastIndex = 3;
const stickyMatch = stickyRe.exec('abc123def');
check('sticky', stickyMatch[0], '123');

// Complex: email validation
const emailRe = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
check('email-valid', emailRe.test('user@example.com'), true);
check('email-invalid', emailRe.test('not-an-email'), false);

// Complex: URL parsing with regex
const urlRe = /^(?<proto>https?):\/\/(?<host>[^/:]+)(?::(?<port>\d+))?(?<path>\/[^?]*)?(?:\?(?<query>.*))?$/;
const u = 'https://example.com:8080/api/users?page=1'.match(urlRe);
check('url-proto', u.groups.proto, 'https');
check('url-host', u.groups.host, 'example.com');
check('url-port', u.groups.port, '8080');
check('url-path', u.groups.path, '/api/users');
check('url-query', u.groups.query, 'page=1');

console.log('PASS: regex ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
