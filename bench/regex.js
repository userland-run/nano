// Regular expression matching
// Tests: regex engine (backtracking, NFA), string scanning
const N = 50000;
const t0 = Date.now();

const patterns = [
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
  /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  /\b(https?):\/\/[^\s/$.?#].[^\s]*/gi,
];

const inputs = [
  '192.168.1.1',
  'user@example.com',
  '2024-01-15T10:30:00Z',
  'Visit https://example.com/path?q=1 or http://test.org for info',
  'no match here',
  'another.test@domain.co.uk',
  '10.0.0.255',
  '2023-12-31T23:59:59',
];

let matches = 0;
for (let i = 0; i < N; i++) {
  for (const pat of patterns) {
    for (const inp of inputs) {
      if (pat.test(inp)) matches++;
    }
  }
}

const ms = Date.now() - t0;
console.log(`BENCH: regex rounds=${N} matches=${matches} ${ms}ms`);
