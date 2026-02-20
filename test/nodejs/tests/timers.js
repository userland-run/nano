(async () => {
  let ok = 0, total = 0;
  function check(name, cond) {
    total++;
    if (cond) ok++;
    else process.stderr.write('  FAIL ' + name + '\n');
  }

  const t1 = await new Promise(r => setTimeout(() => r(Date.now()), 10));
  check('setTimeout', typeof t1 === 'number');

  const t2 = await new Promise(r => setImmediate(() => r(true)));
  check('setImmediate', t2 === true);

  let cleared = true;
  const id = setTimeout(() => { cleared = false; }, 10);
  clearTimeout(id);
  await new Promise(r => setTimeout(r, 50));
  check('clearTimeout', cleared);

  let micro = false;
  queueMicrotask(() => { micro = true; });
  await new Promise(r => setTimeout(r, 0));
  check('queueMicrotask', micro);

  console.log('PASS: timers ' + ok + '/' + total);
  process.exit(ok === total ? 0 : 1);
})();
