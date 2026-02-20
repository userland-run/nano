/**
 * Zod schema validation test.
 */
const { z } = require('zod');

let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (JSON.stringify(got) === JSON.stringify(exp)) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Primitive types
const strSchema = z.string().min(1).max(100);
check('str-valid', strSchema.safeParse('hello').success, true);
check('str-empty', strSchema.safeParse('').success, false);

const numSchema = z.number().int().positive();
check('num-valid', numSchema.safeParse(42).success, true);
check('num-negative', numSchema.safeParse(-1).success, false);
check('num-float', numSchema.safeParse(3.14).success, false);

const boolSchema = z.boolean();
check('bool-true', boolSchema.safeParse(true).success, true);
check('bool-str', boolSchema.safeParse('true').success, false);

// Object schema
const userSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
  role: z.enum(['admin', 'user', 'guest']),
  tags: z.array(z.string()).optional(),
});

const validUser = { name: 'Alice', email: 'alice@example.com', age: 30, role: 'admin' };
check('obj-valid', userSchema.safeParse(validUser).success, true);
check('obj-with-tags', userSchema.safeParse({ ...validUser, tags: ['a', 'b'] }).success, true);
check('obj-bad-email', userSchema.safeParse({ ...validUser, email: 'not-email' }).success, false);
check('obj-bad-role', userSchema.safeParse({ ...validUser, role: 'superadmin' }).success, false);

// Transform
const trimmed = z.string().transform(s => s.trim());
check('transform', trimmed.parse('  hello  '), 'hello');

// Default
const withDefault = z.string().default('anonymous');
check('default', withDefault.parse(undefined), 'anonymous');

// Union
const strOrNum = z.union([z.string(), z.number()]);
check('union-str', strOrNum.safeParse('hello').success, true);
check('union-num', strOrNum.safeParse(42).success, true);
check('union-bool', strOrNum.safeParse(true).success, false);

// Discriminated union
const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), data: z.string() }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);
check('discrim-ok', resultSchema.safeParse({ status: 'ok', data: 'yay' }).success, true);
check('discrim-err', resultSchema.safeParse({ status: 'error', message: 'oh no' }).success, true);
check('discrim-bad', resultSchema.safeParse({ status: 'unknown' }).success, false);

// Nested objects
const addressSchema = z.object({
  street: z.string(),
  city: z.string(),
  zip: z.string().regex(/^\d{5}$/),
});
const profileSchema = z.object({
  user: userSchema,
  address: addressSchema,
  bio: z.string().max(500).optional(),
});
const validProfile = {
  user: validUser,
  address: { street: '123 Main St', city: 'Somewhere', zip: '12345' },
  bio: 'Hello!',
};
check('nested-valid', profileSchema.safeParse(validProfile).success, true);
check('nested-bad-zip', profileSchema.safeParse({
  ...validProfile,
  address: { ...validProfile.address, zip: 'abc' },
}).success, false);

// Array schema
const numbersSchema = z.array(z.number()).min(1).max(10);
check('array-valid', numbersSchema.safeParse([1, 2, 3]).success, true);
check('array-empty', numbersSchema.safeParse([]).success, false);
check('array-strings', numbersSchema.safeParse(['a']).success, false);

// Intersection
const hasName = z.object({ name: z.string() });
const hasAge = z.object({ age: z.number() });
const named = z.intersection(hasName, hasAge);
check('intersection', named.safeParse({ name: 'X', age: 5 }).success, true);
check('intersection-miss', named.safeParse({ name: 'X' }).success, false);

// Recursive type
const categorySchema = z.lazy(() => z.object({
  name: z.string(),
  children: z.array(categorySchema).optional(),
}));
check('recursive', categorySchema.safeParse({
  name: 'root',
  children: [{ name: 'child', children: [{ name: 'grandchild' }] }],
}).success, true);

// Coerce
const coerceNum = z.coerce.number();
check('coerce-str', coerceNum.parse('42'), 42);
const coerceDate = z.coerce.date();
const d = coerceDate.parse('2024-01-01');
check('coerce-date', d instanceof Date, true);

console.log('PASS: zod ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
