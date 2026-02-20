const zlib = require('zlib');
let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Gzip roundtrip
const input = 'Hello NanoVM! This is a compression test with some repeated data. ' +
  'repeated data repeated data repeated data repeated data.';
const compressed = zlib.gzipSync(input);
check('gzip-smaller', compressed.length < Buffer.byteLength(input), true);
const decompressed = zlib.gunzipSync(compressed);
check('gzip-roundtrip', decompressed.toString(), input);

// Deflate roundtrip
const deflated = zlib.deflateSync(input);
check('deflate-smaller', deflated.length < Buffer.byteLength(input), true);
const inflated = zlib.inflateSync(deflated);
check('deflate-roundtrip', inflated.toString(), input);

// Brotli roundtrip
const brotli = zlib.brotliCompressSync(input);
check('brotli-compressed', brotli.length < Buffer.byteLength(input), true);
const unbrotli = zlib.brotliDecompressSync(brotli);
check('brotli-roundtrip', unbrotli.toString(), input);

// Large data
const big = Buffer.alloc(10000, 'A');
const bigZ = zlib.deflateSync(big);
check('big-compress-ratio', bigZ.length < 200, true); // highly compressible
check('big-roundtrip', zlib.inflateSync(bigZ).equals(big), true);

// JSON compress roundtrip
const obj = { users: Array.from({length: 100}, (_, i) => ({ id: i, name: 'user' + i, active: i % 2 === 0 })) };
const jsonStr = JSON.stringify(obj);
const jsonZ = zlib.gzipSync(jsonStr);
const jsonBack = JSON.parse(zlib.gunzipSync(jsonZ).toString());
check('json-roundtrip', jsonBack.users.length, 100);
check('json-data', jsonBack.users[42].name, 'user42');

console.log('PASS: zlib ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
