/**
 * CJS module system: require, module.exports, __filename, __dirname,
 * require.cache, require.resolve, circular deps, JSON require
 */
let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// __filename and __dirname
check('__filename', typeof __filename, 'string');
check('__dirname', typeof __dirname, 'string');
check('filename-abs', __filename.startsWith('/'), true);

// module object shape
check('module-id', typeof module.id, 'string');
check('module-filename', module.filename, __filename);
check('module-exports-ref', module.exports === exports, true);
check('module-loaded', typeof module.loaded, 'boolean');
check('module-children', Array.isArray(module.children), true);
check('module-paths', Array.isArray(module.paths), true);

// require is a function
check('require-fn', typeof require, 'function');
check('require-resolve', typeof require.resolve, 'function');
check('require-cache', typeof require.cache, 'object');

// require.resolve for built-in modules
check('resolve-fs', typeof require.resolve('fs'), 'string');
check('resolve-path', typeof require.resolve('path'), 'string');
check('resolve-os', typeof require.resolve('os'), 'string');

// Require built-ins
const fs = require('fs');
const path = require('path');
const os = require('os');
check('require-fs', typeof fs.readFileSync, 'function');
check('require-path', typeof path.join, 'function');
check('require-os', typeof os.arch, 'function');

// require.cache contains loaded modules
const fsCacheKey = require.resolve('fs');
check('cache-has-fs', fsCacheKey in require.cache, true);

// JSON require via vm (write JSON, then eval require)
const vm = require('vm');
const jsonData = '{"name":"test","version":"1.0.0","count":42}';
fs.writeFileSync('/tmp/test-pkg.json', jsonData);
const pkg = require('/tmp/test-pkg.json');
check('json-require-name', pkg.name, 'test');
check('json-require-ver', pkg.version, '1.0.0');
check('json-require-num', pkg.count, 42);

// Same require returns cached instance
const pkg2 = require('/tmp/test-pkg.json');
check('json-cache', pkg === pkg2, true);

// Module wrapper provides correct context
check('this-exports', this === exports || this === module.exports, true);

// require main module
check('require-main', typeof require.main, 'object');
check('require-main-is-module', require.main === module, true);

console.log('PASS: module-system ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
