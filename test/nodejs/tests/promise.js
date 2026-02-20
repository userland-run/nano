(async () => {
  let ok = 0, total = 0;
  function check(name, cond) {
    total++;
    if (cond) ok++;
    else process.stderr.write('  FAIL ' + name + '\n');
  }

  const v = await new Promise(r => r(42));
  check('resolve', v === 42);

  const all = await Promise.all([1, 2, 3].map(x => Promise.resolve(x * 2)));
  check('all', JSON.stringify(all) === '[2,4,6]');

  const race = await Promise.race([
    new Promise(r => setTimeout(() => r('slow'), 100)),
    Promise.resolve('fast'),
  ]);
  check('race', race === 'fast');

  async function add(a, b) { return a + b; }
  check('async', await add(1, 2) === 3);

  try {
    await Promise.reject(new Error('test'));
    check('reject', false);
  } catch (e) {
    check('reject', e.message === 'test');
  }

  console.log('PASS: promise ' + ok + '/' + total);
  process.exit(ok === total ? 0 : 1);
})();
