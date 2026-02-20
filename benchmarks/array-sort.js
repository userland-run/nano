// Array creation, fill, and sort
const N = 50000;
const t0 = Date.now();

// Create and sort arrays multiple times
let checksum = 0;
for (let round = 0; round < 5; round++) {
  const arr = new Array(N);
  for (let i = 0; i < N; i++) {
    arr[i] = (N - i + (i * 7) % N) | 0;
  }
  arr.sort((a, b) => a - b);
  checksum += arr[0] + arr[N - 1];
}

const ms = Date.now() - t0;
console.log(`BENCH: array-sort n=${N} checksum=${checksum} ${ms}ms`);
