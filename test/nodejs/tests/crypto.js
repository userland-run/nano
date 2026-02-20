let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (got === exp) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}
const crypto = require('crypto');

// MD5
const md5 = crypto.createHash('md5').update('hello').digest('hex');
check('md5', md5, '5d41402abc4b2a76b9719d911017c592');

// SHA256
const sha256 = crypto.createHash('sha256').update('hello').digest('hex');
check('sha256', sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');

// SHA512
const sha512 = crypto.createHash('sha512').update('test').digest('hex');
check('sha512-len', sha512.length, 128);

// HMAC
const hmac = crypto.createHmac('sha256', 'secret').update('message').digest('hex');
check('hmac-len', hmac.length, 64);
check('hmac-type', typeof hmac, 'string');

// randomBytes
const rand = crypto.randomBytes(16);
check('randomBytes-len', rand.length, 16);
check('randomBytes-type', Buffer.isBuffer(rand), true);

// randomBytes uniqueness
const rand2 = crypto.randomBytes(16);
check('randomBytes-unique', rand.equals(rand2), false);

// randomInt
const ri = crypto.randomInt(100);
check('randomInt-range', ri >= 0 && ri < 100, true);

// randomUUID
const uuid = crypto.randomUUID();
check('uuid-format', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid), true);

// pbkdf2 sync
const key = crypto.pbkdf2Sync('pass', 'salt', 1000, 32, 'sha256');
check('pbkdf2-len', key.length, 32);

// createCipheriv / createDecipheriv
const iv = crypto.randomBytes(16);
const ckey = crypto.randomBytes(32);
const cipher = crypto.createCipheriv('aes-256-cbc', ckey, iv);
let enc = cipher.update('Hello NanoVM', 'utf8', 'hex');
enc += cipher.final('hex');
const decipher = crypto.createDecipheriv('aes-256-cbc', ckey, iv);
let dec = decipher.update(enc, 'hex', 'utf8');
dec += decipher.final('utf8');
check('aes-roundtrip', dec, 'Hello NanoVM');

console.log('PASS: crypto ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
