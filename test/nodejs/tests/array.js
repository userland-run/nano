let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}
check('map', [1,2,3].map(x => x*2), [2,4,6]);
check('filter', [1,2,3,4].filter(x => x%2===0), [2,4]);
check('reduce', [1,2,3].reduce((a,b) => a+b, 0), 6);
check('find', [1,2,3].find(x => x>1), 2);
check('some', [1,2,3].some(x => x>2), true);
check('every', [1,2,3].every(x => x>0), true);
check('includes', [1,2,3].includes(2), true);
check('flat', [1,[2,[3]]].flat(Infinity), [1,2,3]);
check('sort', [3,1,2].sort(), [1,2,3]);
check('reverse', [1,2,3].reverse(), [3,2,1]);
check('from', Array.from({length:3}, (_,i) => i), [0,1,2]);
check('spread', [...[1,2], ...[3,4]], [1,2,3,4]);
console.log('PASS: array ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
