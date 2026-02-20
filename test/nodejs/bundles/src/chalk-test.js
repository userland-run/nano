/**
 * Chalk test — terminal string styling.
 * Chalk v5 is ESM-only, esbuild bundles it as CJS. Use the default export.
 */
const chalk = require('chalk');

let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

// Basic colors
const red = chalk.red('error');
check('red', red.includes('error'));

const green = chalk.green('success');
check('green', green.includes('success'));

const blue = chalk.blue('info');
check('blue', blue.includes('info'));

// Modifiers
const bold = chalk.bold('strong');
check('bold', bold.includes('strong'));

const underline = chalk.underline('link');
check('underline', underline.includes('link'));

// Chaining
const chained = chalk.red.bold.underline('important');
check('chained', chained.includes('important'));

// Background
const bg = chalk.bgRed('alert');
check('bgRed', bg.includes('alert'));

// Composition
const composed = chalk.red('a') + ' ' + chalk.green('b');
check('compose-contains', composed.includes('a') && composed.includes('b'));

// Nested
const nested = chalk.red('red ' + chalk.bold('bold') + ' red');
check('nested', nested.includes('bold'));

// Template literal
const name = 'NanoVM';
const msg = chalk.blue(`Hello ${name}!`);
check('template', msg.includes('Hello NanoVM!'));

console.log('PASS: chalk ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
