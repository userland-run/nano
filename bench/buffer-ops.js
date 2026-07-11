// Buffer allocation, fill, copy, and conversion
const N = 5000;
const SIZE = 4096;
const t0 = Date.now();

let checksum = 0;
for (let i = 0; i < N; i++) {
  const buf = Buffer.alloc(SIZE);
  // Fill with pattern
  for (let j = 0; j < SIZE; j++) {
    buf[j] = (j + i) & 0xFF;
  }
  // Copy
  const buf2 = Buffer.alloc(SIZE);
  buf.copy(buf2);
  // Convert to string and back
  const hex = buf2.toString('hex');
  const buf3 = Buffer.from(hex, 'hex');
  checksum += buf3[0] + buf3[SIZE - 1];
}

const ms = Date.now() - t0;
console.log(`BENCH: buffer-ops rounds=${N} checksum=${checksum} ${ms}ms`);
