let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Float64Array
const f64 = new Float64Array([1.1, 2.2, 3.3]);
check('f64-len', f64.length, 3);
check('f64-bytes', f64.byteLength, 24);
const f64sum = f64.reduce((a, b) => a + b);
check('f64-sum', Math.abs(f64sum - 6.6) < 1e-10, true);

// Int32Array
const i32 = new Int32Array([1, -2, 3, -4, 5]);
check('i32-sort', [...i32.sort()], [-4, -2, 1, 3, 5]);
check('i32-filter', [...i32.filter(x => x > 0)], [1, 3, 5]);
check('i32-map', [...new Int32Array([1,2,3]).map(x => x * x)], [1, 4, 9]);

// Uint8Array and DataView
const buf = new ArrayBuffer(16);
const dv = new DataView(buf);
dv.setFloat64(0, Math.PI, true);
dv.setInt32(8, 42, true);
dv.setUint16(12, 0xCAFE, false);
check('dv-f64', dv.getFloat64(0, true), Math.PI);
check('dv-i32', dv.getInt32(8, true), 42);
check('dv-u16', dv.getUint16(12, false), 0xCAFE);

// SharedArrayBuffer
const sab = new SharedArrayBuffer(16);
const si32 = new Int32Array(sab);
Atomics.store(si32, 0, 100);
check('atomics-store', Atomics.load(si32, 0), 100);
check('atomics-add', Atomics.add(si32, 0, 50), 100);
check('atomics-after-add', Atomics.load(si32, 0), 150);
check('atomics-cas', Atomics.compareExchange(si32, 0, 150, 200), 150);
check('atomics-after-cas', Atomics.load(si32, 0), 200);

// Slice and subarray
const arr = new Uint8Array([0, 1, 2, 3, 4, 5]);
const sub = arr.subarray(2, 4);
check('subarray', [...sub], [2, 3]);
sub[0] = 99;
check('subarray-shared', arr[2], 99); // subarray shares memory

const sliced = arr.slice(0, 3);
check('slice', [...sliced], [0, 1, 99]);
sliced[0] = 77;
check('slice-independent', arr[0], 0); // slice is a copy

// BigInt64Array
const b64 = new BigInt64Array([1n, -2n, 3n]);
check('bigint64-len', b64.length, 3);
check('bigint64-val', b64[1].toString(), '-2');

// TypedArray.from
const fromArr = Uint8Array.from([1, 2, 3], x => x * 2);
check('ta-from', [...fromArr], [2, 4, 6]);

// TypedArray.of
check('ta-of', [...Float32Array.of(1.5, 2.5, 3.5)].map(x => Math.round(x * 10) / 10), [1.5, 2.5, 3.5]);

console.log('PASS: typed-arrays ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
