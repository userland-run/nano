/**
 * perf_hooks: performance.now, marks, measures, timeOrigin
 */
const { performance, PerformanceObserver } = require('perf_hooks');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

// performance.now() returns a number
const t0 = performance.now();
check('now-number', typeof t0 === 'number');
check('now-positive', t0 > 0);

// Monotonic: second call >= first
const t1 = performance.now();
check('monotonic', t1 >= t0);

// timeOrigin
check('timeOrigin', typeof performance.timeOrigin === 'number' && performance.timeOrigin > 0);

// Do some work to measure
let sum = 0;
for (let i = 0; i < 100000; i++) sum += i;
const t2 = performance.now();
check('elapsed', t2 > t0);

// Mark and measure
performance.mark('start');
let x = 0;
for (let i = 0; i < 50000; i++) x += Math.sqrt(i);
performance.mark('end');
performance.measure('compute', 'start', 'end');

const entries = performance.getEntriesByName('compute');
check('measure-exists', entries.length === 1);
check('measure-name', entries[0].name === 'compute');
check('measure-duration', typeof entries[0].duration === 'number' && entries[0].duration >= 0);
check('measure-type', entries[0].entryType === 'measure');
check('measure-start', typeof entries[0].startTime === 'number');

// getEntriesByType
const marks = performance.getEntriesByType('mark');
check('marks-count', marks.length >= 2);
const measures = performance.getEntriesByType('measure');
check('measures-count', measures.length >= 1);

// Clear marks and measures
performance.clearMarks();
const marksAfter = performance.getEntriesByType('mark');
check('clear-marks', marksAfter.length === 0);

performance.clearMeasures();
const measuresAfter = performance.getEntriesByType('measure');
check('clear-measures', measuresAfter.length === 0);

// process.hrtime (legacy but widely used)
const hr = process.hrtime();
check('hrtime-array', Array.isArray(hr) && hr.length === 2);
check('hrtime-secs', typeof hr[0] === 'number');
check('hrtime-nanos', typeof hr[1] === 'number' && hr[1] >= 0 && hr[1] < 1e9);

// process.hrtime.bigint
const hrb = process.hrtime.bigint();
check('hrtime-bigint', typeof hrb === 'bigint' && hrb > 0n);

// process.hrtime diff
const start = process.hrtime();
for (let i = 0; i < 10000; i++) Math.random();
const diff = process.hrtime(start);
check('hrtime-diff', diff[0] >= 0 && diff[1] >= 0);

console.log('PASS: perf-hooks ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
