// Array creation, fill, and sort
// Tests: memory allocation, comparison callbacks, cache behavior
const N = 100000;
const t0 = Date.now();

let checksum = 0;
for (let round = 0; round < 10; round++) {
  const arr = new Array(N);
  for (let i = 0; i < N; i++) {
    arr[i] = (N - i + (i * 7) % N) | 0;
  }
  arr.sort((a, b) => a - b);
  checksum += arr[0] + arr[N - 1];
}

const ms = Date.now() - t0;
console.log(`BENCH: array-sort n=${N} rounds=10 checksum=${checksum} ${ms}ms`);
