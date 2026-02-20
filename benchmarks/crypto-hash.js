// SHA-256 hashing
const crypto = require('crypto');
const N = 2000;
const t0 = Date.now();

let last = '';
for (let i = 0; i < N; i++) {
  const data = 'benchmark-input-' + i + '-' + last.slice(0, 16);
  last = crypto.createHash('sha256').update(data).digest('hex');
}

const ms = Date.now() - t0;
console.log(`BENCH: crypto-hash rounds=${N} last=${last.slice(0,8)} ${ms}ms`);
