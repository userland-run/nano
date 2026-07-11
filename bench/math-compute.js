// Integer-heavy math: sieve of Eratosthenes + integer matrix multiply
// Tests: tight integer loops, array access patterns, branch-heavy code
// (Avoids Float64Array which hits FP emulation overhead in the emulator)
const t0 = Date.now();

// Sieve of Eratosthenes
const SIEVE_N = 1000000;
const sieve = new Uint8Array(SIEVE_N + 1);
let primeCount = 0;
for (let i = 2; i <= SIEVE_N; i++) {
  if (!sieve[i]) {
    primeCount++;
    for (let j = i * 2; j <= SIEVE_N; j += i) {
      sieve[j] = 1;
    }
  }
}

// Integer matrix multiply
const N = 150;
const a = new Int32Array(N * N);
const b = new Int32Array(N * N);
const c = new Int32Array(N * N);
for (let i = 0; i < N * N; i++) {
  a[i] = (i * 3 + 7) & 0xFF;
  b[i] = (i * 5 + 13) & 0xFF;
}
for (let i = 0; i < N; i++) {
  for (let k = 0; k < N; k++) {
    const aik = a[i * N + k];
    for (let j = 0; j < N; j++) {
      c[i * N + j] = (c[i * N + j] + aik * b[k * N + j]) | 0;
    }
  }
}

let trace = 0;
for (let i = 0; i < N; i++) trace += c[i * N + i];

const ms = Date.now() - t0;
console.log(`BENCH: math-compute primes=${primeCount} trace=${trace} ${ms}ms`);
