// Recursive fibonacci — pure CPU integer workload
// Tests: function call overhead, branch prediction, integer ALU
function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

const N = 38;
const t0 = Date.now();
const result = fib(N);
const ms = Date.now() - t0;
console.log(`BENCH: fib(${N})=${result} ${ms}ms`);
