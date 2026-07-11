// JSON serialization and parsing
const N = 5000;
const t0 = Date.now();

const obj = {
  users: Array.from({ length: 20 }, (_, i) => ({
    id: i,
    name: 'User' + i,
    email: 'user' + i + '@example.com',
    active: i % 2 === 0,
    scores: [i * 10, i * 20, i * 30],
    meta: { created: '2024-01-01', tags: ['a', 'b', 'c'] }
  }))
};

let checksum = 0;
for (let i = 0; i < N; i++) {
  const json = JSON.stringify(obj);
  const parsed = JSON.parse(json);
  checksum += parsed.users.length;
}

const ms = Date.now() - t0;
console.log(`BENCH: json-parse rounds=${N} checksum=${checksum} ${ms}ms`);
