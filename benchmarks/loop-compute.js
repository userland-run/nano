// Tight integer loop — pure ALU + branch, minimal memory traffic
// Tests: raw interpreter dispatch speed, branch handling, register ops
const N = 50000000;
const t0 = Date.now();

let a = 0, b = 1, c = 0;
for (let i = 0; i < N; i++) {
  c = (a + b) | 0;
  a = b;
  b = c;
  if (c > 1000000) {
    a = c & 0xFF;
    b = (c >> 8) & 0xFF;
  }
}

const ms = Date.now() - t0;
console.log(`BENCH: loop-compute n=${N} result=${c} ${ms}ms`);
