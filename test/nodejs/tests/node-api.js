/**
 * Node.js API features: querystring, punycode, string_decoder,
 * timers/promises, dns constants, net constants, http constants
 */
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

// querystring
const qs = require('querystring');
const parsed = qs.parse('foo=bar&baz=42&arr=1&arr=2');
check('qs-parse-foo', parsed.foo === 'bar');
check('qs-parse-baz', parsed.baz === '42');
check('qs-parse-arr', Array.isArray(parsed.arr) && parsed.arr.length === 2);

const encoded = qs.stringify({ a: 1, b: 'hello world', c: true });
check('qs-stringify', encoded.includes('a=1') && encoded.includes('b=hello'));
check('qs-roundtrip', qs.parse(qs.stringify({ x: '1', y: '2' })).x === '1');

// querystring escape/unescape
check('qs-escape', qs.escape('hello world') === 'hello%20world');
check('qs-unescape', qs.unescape('hello%20world') === 'hello world');

// string_decoder
const { StringDecoder } = require('string_decoder');
const decoder = new StringDecoder('utf8');
check('decoder-create', decoder instanceof StringDecoder);

// Write multi-byte char in chunks
const buf1 = Buffer.from([0xE2]);
const buf2 = Buffer.from([0x82]);
const buf3 = Buffer.from([0xAC]); // EUR sign (€) in UTF-8
const result = decoder.write(buf1) + decoder.write(buf2) + decoder.write(buf3);
check('decoder-multibyte', result === '€');

// end() flushes
const d2 = new StringDecoder('utf8');
d2.write(Buffer.from('hello'));
check('decoder-end', d2.end() === '');

// timers module
const timers = require('timers');
check('timers-setTimeout', typeof timers.setTimeout === 'function');
check('timers-setInterval', typeof timers.setInterval === 'function');
check('timers-setImmediate', typeof timers.setImmediate === 'function');

// timers/promises
(async () => {
  const { setTimeout: sleep } = require('timers/promises');
  check('timers-promises', typeof sleep === 'function');
  const start = Date.now();
  await sleep(10);
  check('sleep-resolved', Date.now() - start >= 5); // at least some time passed

  // setImmediate promise
  const { setImmediate: nextTick } = require('timers/promises');
  const val = await nextTick(42);
  check('immediate-value', val === 42);

  // http module constants
  const http = require('http');
  check('http-STATUS_CODES', typeof http.STATUS_CODES === 'object');
  check('http-200', http.STATUS_CODES[200] === 'OK');
  check('http-404', http.STATUS_CODES[404] === 'Not Found');
  check('http-METHODS', Array.isArray(http.METHODS));
  check('http-has-GET', http.METHODS.includes('GET'));
  check('http-has-POST', http.METHODS.includes('POST'));

  // http module classes exist
  check('http-Server', typeof http.Server === 'function');
  check('http-IncomingMessage', typeof http.IncomingMessage === 'function');

  // constants module
  const constants = require('constants');
  check('const-SIGTERM', constants.SIGTERM === 15);
  check('const-ENOENT', typeof constants.ENOENT === 'number');

  // dns module (constants only, no actual resolution)
  const dns = require('dns');
  check('dns-module', typeof dns === 'object');
  check('dns-NODATA', typeof dns.NODATA === 'string');
  check('dns-resolve', typeof dns.resolve === 'function');

  console.log('PASS: node-api ' + ok + '/' + total);
  process.exit(ok === total ? 0 : 1);
})();
