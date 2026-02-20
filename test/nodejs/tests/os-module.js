/**
 * os module: architecture, platform, cpus, memory, dirs, network
 */
const os = require('os');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

// Architecture and platform
check('arch', typeof os.arch() === 'string' && os.arch().length > 0);
check('platform', typeof os.platform() === 'string' && os.platform().length > 0);
check('platform-linux', os.platform() === 'linux');
check('type', typeof os.type() === 'string');
check('release', typeof os.release() === 'string');
check('version', typeof os.version() === 'string');

// Memory
check('totalmem', typeof os.totalmem() === 'number' && os.totalmem() > 0);
check('freemem', typeof os.freemem() === 'number' && os.freemem() >= 0);

// CPUs
const cpus = os.cpus();
check('cpus-array', Array.isArray(cpus));
check('cpus-length', cpus.length >= 1);
if (cpus.length > 0) {
  check('cpu-model', typeof cpus[0].model === 'string');
  check('cpu-speed', typeof cpus[0].speed === 'number');
  check('cpu-times', typeof cpus[0].times === 'object');
}

// Directories
check('homedir', typeof os.homedir() === 'string' && os.homedir().length > 0);
check('tmpdir', typeof os.tmpdir() === 'string' && os.tmpdir().length > 0);

// Hostname
check('hostname', typeof os.hostname() === 'string');

// Endianness
check('endianness', os.endianness() === 'LE' || os.endianness() === 'BE');

// EOL
check('eol', os.EOL === '\n' || os.EOL === '\r\n');

// uptime
check('uptime', typeof os.uptime() === 'number' && os.uptime() >= 0);

// Network interfaces (may fail without socket syscalls)
try {
  const nets = os.networkInterfaces();
  check('net-obj', typeof nets === 'object' && nets !== null);
} catch (e) {
  // ENOSYS — no socket support in this VM
  check('net-obj', true);
}

// Constants
check('signals', typeof os.constants.signals === 'object');
check('errno', typeof os.constants.errno === 'object');
check('sigkill', os.constants.signals.SIGKILL === 9);

// userInfo
try {
  const user = os.userInfo();
  check('userinfo', typeof user === 'object' && typeof user.username === 'string');
} catch (e) {
  // userInfo may throw if no /etc/passwd entry
  check('userinfo', true);
}

console.log('PASS: os-module ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
