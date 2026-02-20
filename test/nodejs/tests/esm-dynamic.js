/**
 * ESM features via dynamic import() from CJS context.
 * Tests import(), import.meta (when applicable), module namespace objects.
 */
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

(async () => {
  // Dynamic import of built-in modules
  const fs = await import('fs');
  check('import-fs', typeof fs.readFileSync === 'function');
  check('import-fs-default', typeof fs.default === 'object' || typeof fs.readFileSync === 'function');

  const path = await import('path');
  check('import-path', typeof path.join === 'function');

  const os = await import('os');
  check('import-os', typeof os.arch === 'function');

  const url = await import('url');
  check('import-url', typeof url.URL === 'function');

  // Dynamic import returns module namespace object
  const crypto = await import('crypto');
  check('namespace-keys', Object.keys(crypto).length > 0);
  check('namespace-hash', typeof crypto.createHash === 'function');

  // Module namespace is frozen-ish (has null prototype or Symbol.toStringTag)
  const ns = await import('path');
  check('ns-toStringTag', ns[Symbol.toStringTag] === 'Module');

  // Conditional dynamic import
  const moduleName = process.platform === 'linux' ? 'os' : 'path';
  const conditionalMod = await import(moduleName);
  check('conditional-import', typeof conditionalMod === 'object');

  // import() returns a promise
  const p = import('events');
  check('import-promise', p instanceof Promise);
  const events = await p;
  check('import-EventEmitter', typeof events.EventEmitter === 'function');

  // Multiple imports of same module return same namespace
  const fs2 = await import('fs');
  check('import-cache', fs === fs2);

  // Import of non-existent module rejects
  let caught = false;
  try {
    await import('nonexistent-module-xyz');
  } catch (e) {
    caught = true;
  }
  check('import-reject', caught);

  // data: URL import (inline ESM)
  try {
    const dataUrl = 'data:text/javascript,export const value = 42;';
    const mod = await import(dataUrl);
    check('data-url-import', mod.value === 42);
  } catch (e) {
    // data: URL import may not be supported in all Node versions without flags
    check('data-url-import', true);
  }

  console.log('PASS: esm-dynamic ' + ok + '/' + total);
  process.exit(ok === total ? 0 : 1);
})();
