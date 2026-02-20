// String concatenation and manipulation
const N = 50000;
const t0 = Date.now();

let s = '';
for (let i = 0; i < N; i++) {
  s += String.fromCharCode(65 + (i % 26));
}

// String search
let count = 0;
for (let i = 0; i < s.length - 2; i++) {
  if (s[i] === 'A' && s[i+1] === 'B') count++;
}

// String split/join
const parts = s.match(/.{1,100}/g) || [];
const joined = parts.join('-');

const ms = Date.now() - t0;
console.log(`BENCH: string-ops len=${s.length} matches=${count} parts=${parts.length} ${ms}ms`);
