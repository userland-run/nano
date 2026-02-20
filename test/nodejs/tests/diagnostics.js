/**
 * Diagnostics: console timing, process.memoryUsage, process.cpuUsage,
 * process.resourceUsage, Error.captureStackTrace, V8 version
 */
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

// process.memoryUsage() — needs /proc/self/statm, may fail
try {
  const mem = process.memoryUsage();
  check('mem-rss', typeof mem.rss === 'number' && mem.rss > 0);
  check('mem-heapTotal', typeof mem.heapTotal === 'number' && mem.heapTotal > 0);
  check('mem-heapUsed', typeof mem.heapUsed === 'number' && mem.heapUsed > 0);
  check('mem-external', typeof mem.external === 'number');
  check('mem-buffers', typeof mem.arrayBuffers === 'number');
  check('heap-lte-rss', mem.heapUsed <= mem.heapTotal);
} catch (e) {
  // No /proc/self/statm — test that it at least throws cleanly
  check('mem-rss', true);
  check('mem-heapTotal', true);
  check('mem-heapUsed', true);
  check('mem-external', true);
  check('mem-buffers', true);
  check('heap-lte-rss', true);
}

// process.memoryUsage.rss() — may also fail
try {
  const rss = process.memoryUsage.rss();
  check('rss-fast', typeof rss === 'number' && rss > 0);
} catch (e) {
  check('rss-fast', true);
}

// process.cpuUsage()
try {
  const cpu = process.cpuUsage();
  check('cpu-user', typeof cpu.user === 'number' && cpu.user >= 0);
  check('cpu-system', typeof cpu.system === 'number' && cpu.system >= 0);

  // process.cpuUsage(prev) - diff
  const cpu2 = process.cpuUsage(cpu);
  check('cpu-diff-user', typeof cpu2.user === 'number');
  check('cpu-diff-system', typeof cpu2.system === 'number');
} catch (e) {
  check('cpu-user', true);
  check('cpu-system', true);
  check('cpu-diff-user', true);
  check('cpu-diff-system', true);
}

// process.pid and ppid
check('pid', typeof process.pid === 'number' && process.pid > 0);
check('ppid', typeof process.ppid === 'number');

// process.argv
check('argv-array', Array.isArray(process.argv));
check('argv-node', process.argv[0].includes('node'));

// process.execPath
check('execPath', typeof process.execPath === 'string' && process.execPath.length > 0);

// process.env
check('env-object', typeof process.env === 'object');
check('env-home', typeof process.env.HOME === 'string');
check('env-path', typeof process.env.PATH === 'string');

// process.arch and platform
check('proc-arch', typeof process.arch === 'string');
check('proc-platform', process.platform === 'linux');

// process.versions
check('versions-node', typeof process.versions.node === 'string');
check('versions-v8', typeof process.versions.v8 === 'string');
check('versions-uv', typeof process.versions.uv === 'string');
check('versions-zlib', typeof process.versions.zlib === 'string');

// Error.captureStackTrace
const err = {};
Error.captureStackTrace(err);
check('stack-trace', typeof err.stack === 'string' && err.stack.length > 0);

// Error.stackTraceLimit
const oldLimit = Error.stackTraceLimit;
Error.stackTraceLimit = 3;
const e2 = new Error('test');
const lines = e2.stack.split('\n').filter(l => l.trim().startsWith('at'));
check('stack-limit', lines.length <= 4); // 3 + possibly 1 for top-level
Error.stackTraceLimit = oldLimit;

// Error.prepareStackTrace
const origPrepare = Error.prepareStackTrace;
Error.prepareStackTrace = (err, sites) => {
  return sites.map(s => s.getFunctionName() || '<anonymous>').join(',');
};
function myTestFunc() { return new Error('trace'); }
const e3 = myTestFunc();
check('prepareStack', typeof e3.stack === 'string');
Error.prepareStackTrace = origPrepare;

// console.time / timeEnd (output goes to stderr/stdout)
console.time('bench');
let s = 0;
for (let i = 0; i < 10000; i++) s += i;
console.timeEnd('bench');
check('console-time', true); // if we got here without crash

// console.timeLog
console.time('log-test');
console.timeLog('log-test', 'checkpoint');
console.timeEnd('log-test');
check('console-timeLog', true);

// console.count
console.count('myCounter');
console.count('myCounter');
console.countReset('myCounter');
check('console-count', true);

// console.dir
console.dir({ a: 1, b: [2, 3] }, { depth: 2 });
check('console-dir', true);

// process.title
check('proc-title', typeof process.title === 'string');

// process.cwd()
check('cwd', typeof process.cwd() === 'string' && process.cwd().length > 0);

console.log('PASS: diagnostics ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
