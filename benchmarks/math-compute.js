// Math-heavy computation: matrix multiply + trig
const N = 200;
const t0 = Date.now();

// Simple NxN matrix multiply
function matmul(a, b, n) {
  const c = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const aik = a[i * n + k];
      for (let j = 0; j < n; j++) {
        c[i * n + j] += aik * b[k * n + j];
      }
    }
  }
  return c;
}

const a = new Float64Array(N * N);
const b = new Float64Array(N * N);
for (let i = 0; i < N * N; i++) {
  a[i] = Math.sin(i * 0.01);
  b[i] = Math.cos(i * 0.01);
}

const c = matmul(a, b, N);

// Compute trace
let trace = 0;
for (let i = 0; i < N; i++) {
  trace += c[i * N + i];
}

const ms = Date.now() - t0;
console.log(`BENCH: math-compute n=${N} trace=${trace.toFixed(4)} ${ms}ms`);
