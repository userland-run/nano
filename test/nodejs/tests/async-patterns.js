(async () => {
  let ok = 0, total = 0;
  function check(name, got, exp) {
    total++;
    if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
    else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
  }

  // Promise.allSettled
  const results = await Promise.allSettled([
    Promise.resolve(1),
    Promise.reject(new Error('fail')),
    Promise.resolve(3),
  ]);
  check('allSettled-len', results.length, 3);
  check('allSettled-0', results[0], { status: 'fulfilled', value: 1 });
  check('allSettled-1-status', results[1].status, 'rejected');
  check('allSettled-2', results[2], { status: 'fulfilled', value: 3 });

  // Promise.any
  const first = await Promise.any([
    Promise.reject('a'),
    Promise.resolve('b'),
    Promise.resolve('c'),
  ]);
  check('any', first, 'b');

  // Promise.any all reject → AggregateError
  let aggErr = false;
  try {
    await Promise.any([Promise.reject(1), Promise.reject(2)]);
  } catch(e) {
    aggErr = e instanceof AggregateError && e.errors.length === 2;
  }
  check('any-aggregate', aggErr, true);

  // Async iteration simulation
  async function* asyncRange(n) {
    for (let i = 0; i < n; i++) {
      yield await Promise.resolve(i);
    }
  }
  const collected = [];
  for await (const v of asyncRange(5)) collected.push(v);
  check('async-gen', collected, [0, 1, 2, 3, 4]);

  // Pipeline: map + filter + reduce via async
  async function asyncPipeline(data) {
    const mapped = await Promise.all(data.map(async x => x * 2));
    const filtered = mapped.filter(x => x > 4);
    return filtered.reduce((a, b) => a + b, 0);
  }
  check('pipeline', await asyncPipeline([1, 2, 3, 4, 5]), 2+3+4+5 === 14 ? 24 : -1);
  // [1,2,3,4,5] → [2,4,6,8,10] → filter >4: [6,8,10] → sum: 24

  // Error handling chain
  async function riskyOp(n) {
    if (n < 0) throw new Error('negative');
    return n * 10;
  }
  const safeOp = async (n) => {
    try { return { ok: true, value: await riskyOp(n) }; }
    catch(e) { return { ok: false, error: e.message }; }
  };
  check('safe-ok', await safeOp(5), { ok: true, value: 50 });
  check('safe-err', await safeOp(-1), { ok: false, error: 'negative' });

  // Concurrent execution with limit
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
  }
  const squares = await mapLimit([1, 2, 3, 4, 5, 6], 2, async x => x * x);
  check('mapLimit', squares, [1, 4, 9, 16, 25, 36]);

  // Retry pattern
  async function retry(fn, attempts) {
    for (let i = 0; i < attempts; i++) {
      try { return await fn(i); }
      catch(e) { if (i === attempts - 1) throw e; }
    }
  }
  let attempts = 0;
  const retryResult = await retry(async (attempt) => {
    attempts++;
    if (attempt < 2) throw new Error('not yet');
    return 'success';
  }, 5);
  check('retry-result', retryResult, 'success');
  check('retry-attempts', attempts, 3);

  console.log('PASS: async-patterns ' + ok + '/' + total);
  process.exit(ok === total ? 0 : 1);
})();
