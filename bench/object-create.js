// Object creation, property access, Map/Set operations
const N = 50000;
const t0 = Date.now();

// Object creation and property access
let sum = 0;
for (let i = 0; i < N; i++) {
  const obj = { x: i, y: i * 2, z: i * 3, name: 'item' + i };
  sum += obj.x + obj.y + obj.z + obj.name.length;
}

// Map operations
const map = new Map();
for (let i = 0; i < N; i++) {
  map.set('key' + i, i * i);
}
for (let i = 0; i < N; i++) {
  sum += map.get('key' + i) || 0;
}

// Set operations
const set = new Set();
for (let i = 0; i < N; i++) {
  set.add(i);
}
for (let i = 0; i < N; i++) {
  if (set.has(i)) sum++;
}

const ms = Date.now() - t0;
console.log(`BENCH: object-create n=${N} sum=${sum} ${ms}ms`);
