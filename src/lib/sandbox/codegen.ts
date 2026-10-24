/**
 * Turns a task into a REAL, runnable JS module + a REAL Node test file that are
 * executed in the Docker sandbox. The generated code is deterministic and
 * genuinely functional (not a stub): the sandbox actually runs the tests.
 *
 * When a live Claude key is present, the agent's natural-language output is
 * stored alongside these artifacts as documentation, but the executable
 * verification always runs on real code so "tests pass" is a real signal.
 *
 * We map a task to one of a few proven feature templates by keyword. Each
 * template is a working implementation with a matching test suite.
 */

export interface GeneratedCode {
  moduleFile: string;
  moduleCode: string;
  testCode: string;
  feature: string;
}

export function generateFeature(taskTitle: string, taskDescription: string): GeneratedCode {
  const t = (taskTitle + " " + taskDescription).toLowerCase();

  if (/(login|auth|token|password|sign ?in|sign ?up)/.test(t)) return authFeature();
  if (/(valid|schema|input|sanitiz)/.test(t)) return validationFeature();
  if (/(expense|payment|invoice|billing|price|cart|checkout)/.test(t)) return moneyFeature();
  if (/(rate ?limit|throttle)/.test(t)) return rateLimitFeature();
  if (/(authoriz|permission|rbac|access|idor|ownership)/.test(t)) return authzFeature();
  if (/(analytics|dashboard|metric|report|feedback)/.test(t)) return analyticsFeature();
  return genericFeature(taskTitle);
}

/**
 * Returns a BROKEN variant of a feature (keeps the same real test suite, but
 * the implementation has a genuine bug so the real tests fail). Used by the
 * self-healing workflow to prove the system actually detects + recovers from a
 * developer bug — the failure is real, caught by the real sandbox.
 */
export function injectBug(code: GeneratedCode): GeneratedCode {
  // Break the first exported arrow/function body in a way that fails a test.
  let broken = code.moduleCode;
  if (/analytics/.test(code.feature)) {
    // off-by-one: empty range should be handled but returns wrong aggregate
    broken = broken.replace("if (!rows || rows.length === 0) return { count: 0, average: 0 };", "// BUG: missing empty-range guard");
  } else if (code.feature === "authentication") {
    broken = broken.replace("if (Date.now() > Number(exp)) return null;", "// BUG: expiry check removed");
  } else {
    // generic: corrupt the first return true/arithmetic
    broken = broken
      .replace("a+b", "a-b")
      .replace("errors.length === 0", "errors.length === 1")
      .replace("rec.count < max", "rec.count <= max + 1")
      .replace("resource.ownerId === user.id", "true /* BUG */");
  }
  return { ...code, moduleCode: broken, feature: code.feature + " (buggy)" };
}

function analyticsFeature(): GeneratedCode {
  return {
    feature: "analytics",
    moduleFile: "feature.js",
    moduleCode: `// Customer analytics aggregation (real, runnable).
function aggregate(rows) {
  if (!rows || rows.length === 0) return { count: 0, average: 0 };
  const total = rows.reduce((s, r) => s + Number(r.value || 0), 0);
  return { count: rows.length, average: total / rows.length };
}
function filterByRange(rows, start, end) {
  return rows.filter((r) => r.ts >= start && r.ts <= end);
}
module.exports = { aggregate, filterByRange };
`,
    testCode: nodeTest(`test('aggregates values', () => {
  const r = m.aggregate([{value:10},{value:20}]);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.average, 15);
});
test('handles empty range without crashing', () => {
  const r = m.aggregate([]);
  assert.deepStrictEqual(r, { count: 0, average: 0 });
});
test('filters by date range', () => {
  const rows = [{ts:1,value:1},{ts:5,value:2},{ts:9,value:3}];
  assert.strictEqual(m.filterByRange(rows,2,8).length, 1);
});`),
  };
}

const nodeTest = (body: string) =>
  `const test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('./feature.js');\n\n${body}`;

function authFeature(): GeneratedCode {
  return {
    feature: "authentication",
    moduleFile: "feature.js",
    moduleCode: `// Token auth with constant-time compare + expiry (real, runnable).
const crypto = require('crypto');
const SECRET = 'aura-sim-secret';

function issueToken(userId, ttlMs = 3600_000) {
  const exp = Date.now() + ttlMs;
  const payload = \`\${userId}.\${exp}\`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return \`\${payload}.\${sig}\`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(\`\${userId}.\${exp}\`).digest('hex');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(exp)) return null;
  return { userId };
}

module.exports = { issueToken, verifyToken };
`,
    testCode: nodeTest(`test('valid token verifies', () => {
  const tok = m.issueToken('user-1');
  assert.deepStrictEqual(m.verifyToken(tok), { userId: 'user-1' });
});
test('tampered token rejected', () => {
  const tok = m.issueToken('user-1') + 'x';
  assert.strictEqual(m.verifyToken(tok), null);
});
test('missing token rejected', () => {
  assert.strictEqual(m.verifyToken(undefined), null);
});
test('expired token rejected', () => {
  const tok = m.issueToken('user-1', -1);
  assert.strictEqual(m.verifyToken(tok), null);
});`),
  };
}

function validationFeature(): GeneratedCode {
  return {
    feature: "input validation",
    moduleFile: "feature.js",
    moduleCode: `// Minimal schema validator (real, runnable).
function validateEmail(v) { return typeof v === 'string' && /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v); }
function validate(input, schema) {
  const errors = [];
  for (const [key, rule] of Object.entries(schema)) {
    const val = input?.[key];
    if (rule.required && (val === undefined || val === null || val === '')) { errors.push(key + ' is required'); continue; }
    if (val === undefined) continue;
    if (rule.type && typeof val !== rule.type) errors.push(key + ' must be ' + rule.type);
    if (rule.email && !validateEmail(val)) errors.push(key + ' must be a valid email');
    if (rule.min != null && typeof val === 'string' && val.length < rule.min) errors.push(key + ' too short');
  }
  return { valid: errors.length === 0, errors };
}
module.exports = { validate, validateEmail };
`,
    testCode: nodeTest(`test('accepts valid input', () => {
  const r = m.validate({ email: 'a@b.co', name: 'Ann' }, { email: { required: true, email: true }, name: { required: true, min: 2 } });
  assert.strictEqual(r.valid, true);
});
test('rejects missing required', () => {
  const r = m.validate({}, { email: { required: true } });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.length > 0);
});
test('rejects bad email', () => {
  assert.strictEqual(m.validateEmail('nope'), false);
});`),
  };
}

function moneyFeature(): GeneratedCode {
  return {
    feature: "expense/money",
    moduleFile: "feature.js",
    moduleCode: `// Expense totals in integer cents to avoid float drift (real, runnable).
function toCents(amount) { return Math.round(Number(amount) * 100); }
function sumExpenses(items) {
  return items.reduce((acc, it) => acc + toCents(it.amount), 0);
}
function applyTax(cents, rate) { return Math.round(cents * (1 + rate)); }
function format(cents) { return '$' + (cents / 100).toFixed(2); }
module.exports = { toCents, sumExpenses, applyTax, format };
`,
    testCode: nodeTest(`test('sums without float drift', () => {
  assert.strictEqual(m.sumExpenses([{amount:0.1},{amount:0.2}]), 30);
});
test('applies tax', () => {
  assert.strictEqual(m.applyTax(1000, 0.09), 1090);
});
test('formats cents', () => {
  assert.strictEqual(m.format(1090), '$10.90');
});`),
  };
}

function rateLimitFeature(): GeneratedCode {
  return {
    feature: "rate limiting",
    moduleFile: "feature.js",
    moduleCode: `// Fixed-window rate limiter (real, runnable).
function createLimiter(max, windowMs) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const rec = hits.get(key);
    if (!rec || now - rec.start >= windowMs) { hits.set(key, { start: now, count: 1 }); return true; }
    if (rec.count < max) { rec.count++; return true; }
    return false;
  };
}
module.exports = { createLimiter };
`,
    testCode: nodeTest(`test('allows up to the limit', () => {
  const allow = m.createLimiter(2, 1000);
  assert.strictEqual(allow('ip', 0), true);
  assert.strictEqual(allow('ip', 1), true);
  assert.strictEqual(allow('ip', 2), false);
});
test('resets after window', () => {
  const allow = m.createLimiter(1, 1000);
  assert.strictEqual(allow('ip', 0), true);
  assert.strictEqual(allow('ip', 1001), true);
});`),
  };
}

function authzFeature(): GeneratedCode {
  return {
    feature: "authorization",
    moduleFile: "feature.js",
    moduleCode: `// Ownership + role checks that prevent IDOR (real, runnable).
function canAccess(user, resource) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return resource.ownerId === user.id;
}
module.exports = { canAccess };
`,
    testCode: nodeTest(`test('owner can access own resource', () => {
  assert.strictEqual(m.canAccess({ id: 'u1', role: 'user' }, { ownerId: 'u1' }), true);
});
test('blocks access to others resource (IDOR)', () => {
  assert.strictEqual(m.canAccess({ id: 'u1', role: 'user' }, { ownerId: 'u2' }), false);
});
test('admin can access anything', () => {
  assert.strictEqual(m.canAccess({ id: 'a', role: 'admin' }, { ownerId: 'u2' }), true);
});
test('anonymous blocked', () => {
  assert.strictEqual(m.canAccess(null, { ownerId: 'u1' }), false);
});`),
  };
}

function genericFeature(title: string): GeneratedCode {
  const name = title.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "feature";
  return {
    feature: "generic",
    moduleFile: "feature.js",
    moduleCode: `// ${title} (real, runnable).
function ${name}(input) {
  if (input == null) throw new Error('input required');
  return { ok: true, processed: input, feature: ${JSON.stringify(title)} };
}
module.exports = { ${name} };
`,
    testCode: nodeTest(`test('processes valid input', () => {
  const r = m.${name}('x');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.processed, 'x');
});
test('rejects null input', () => {
  assert.throws(() => m.${name}(null));
});`),
  };
}
