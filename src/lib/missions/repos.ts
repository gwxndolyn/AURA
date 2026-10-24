/**
 * Fixture repositories that mission code tasks operate on. Each is a small,
 * real codebase with a real defect, a real test suite, reviewer probes and
 * deterministic security checks. Files run for real in the Docker sandbox.
 *
 * Repair candidates are what the engineer applies in SIMULATION mode (no API
 * key). They are labelled "simulated-candidate" everywhere they surface. With
 * an API key, the engineer's model output (full file content) is applied
 * instead, inside the task's enforced write scope.
 */
import { CHECKOUT_BUGGY, CHECKOUT_PARTIAL, CHECKOUT_FIXED, CHECKOUT_TESTS, BUG_REPORT as CHECKOUT_TICKET } from "./fixtures";

export interface RepairCandidate {
  file: string;
  label: string;
  code: string;
}

export interface Probe {
  /** Stable probe id. Reviewer concerns must name one of these to be checkable. */
  id: string;
  description: string;
  file: string; // module under test (repo path)
  /** node:test body; `m` is the required module. Must FAIL when the defect is present. */
  test: string;
}

export interface FixtureRepo {
  id: string;
  title: string;
  ticket: string;
  files: Record<string, string>;
  sourceFiles: string[];
  testFiles: string[];
  /** Write scope granted to the implementing task. */
  writeScope: string[];
  conventions: string;
  security: string;
  candidates: RepairCandidate[];
  probes: Probe[];
  /** Probes the reviewer always runs on the changed file (deterministic baseline). */
  requiredProbes: string[];
  securityChecks: (code: Record<string, string>) => { check: string; pass: boolean }[];
}

const CHECKOUT_REPO: FixtureRepo = {
  id: "checkout-fix",
  title: "NOVA PAY checkout totals",
  ticket: CHECKOUT_TICKET,
  files: { "src/checkout/checkout.js": CHECKOUT_BUGGY, "src/checkout/checkout.test.js": CHECKOUT_TESTS },
  sourceFiles: ["src/checkout/checkout.js"],
  testFiles: ["src/checkout/checkout.test.js"],
  writeScope: ["src/checkout/checkout.js"],
  conventions: "CommonJS modules, no dependencies. Money is integer cents at the payment boundary. Invalid input throws RangeError with the field name in the message.",
  security: "Payment amounts are customer-facing: never round down a charge, never accept negative or fractional quantities, never evaluate dynamic code.",
  candidates: [
    { file: "src/checkout/checkout.js", label: "Round to nearest cent instead of flooring", code: CHECKOUT_PARTIAL },
    { file: "src/checkout/checkout.js", label: "Integer-cent arithmetic + quantity validation", code: CHECKOUT_FIXED },
  ],
  probes: [
    { id: "fractional-quantity", description: "A fractional quantity (1.5) is rejected", file: "src/checkout/checkout.js", test: "assert.throws(() => m.chargeAmountCents([{ unitPrice: 2, quantity: 1.5 }]), /quantity/);" },
    { id: "zero-quantity", description: "A zero quantity is rejected", file: "src/checkout/checkout.js", test: "assert.throws(() => m.chargeAmountCents([{ unitPrice: 2, quantity: 0 }]), /quantity/);" },
  ],
  requiredProbes: ["fractional-quantity", "zero-quantity"],
  securityChecks: (files) => {
    const code = files["src/checkout/checkout.js"] ?? "";
    return [
      { check: "No floor() on payment amounts (undercharge risk)", pass: !/Math\.floor\(/.test(code) },
      { check: "Quantity is validated (no negative charges)", pass: /quantity\s*<\s*1|quantity\s*<=\s*0/.test(code) },
      { check: "No eval / dynamic code execution", pass: !/\beval\(|new Function\(/.test(code) },
      { check: "Amount returned as an integer", pass: /Math\.round\(/.test(code) },
    ];
  },
};

const VALIDATION_BUGGY = `// Checkout input validation for the NOVA PAY storefront.
const SKU = /^[A-Z]{3}-\\d{4}$/;
function validateItem(item) {
  const errors = [];
  if (!item || typeof item !== "object") return ["item must be an object"];
  if (typeof item.sku !== "string" || !SKU.test(item.sku)) errors.push("sku must look like ABC-1234");
  if (typeof item.unitPrice !== "number" || !(item.unitPrice > 0)) errors.push("unitPrice must be a positive number");
  if (item.quantity < 0) errors.push("quantity must be a positive integer");
  return errors;
}
function validateCart(cart) {
  if (!Array.isArray(cart.items) || cart.items.length === 0) return { ok: false, errors: ["cart must contain at least one item"] };
  const errors = cart.items.flatMap((it, i) => validateItem(it).map((e) => \`items[\${i}]: \${e}\`));
  return { ok: errors.length === 0, errors };
}
module.exports = { validateItem, validateCart };
`;

// Minimal fix: makes the failing test pass, but still accepts 1.5 / NaN / "2" — the reviewer's probes catch this.
const VALIDATION_MINIMAL = VALIDATION_BUGGY.replace("if (item.quantity < 0)", "if (item.quantity <= 0)");
// Repair for the reviewer's finding: quantity must be a positive integer.
const VALIDATION_FIXED = VALIDATION_BUGGY.replace("if (item.quantity < 0)", "if (!Number.isInteger(item.quantity) || item.quantity < 1)");

const VALIDATION_TESTS = `const test = require('node:test');
const assert = require('node:assert');
const { validateCart } = require('./validation.js');

const item = (over = {}) => ({ sku: 'STK-0029', unitPrice: 0.29, quantity: 1, ...over });

test('accepts a valid cart', () => {
  assert.deepStrictEqual(validateCart({ items: [item()] }), { ok: true, errors: [] });
});
test('rejects an empty cart', () => {
  assert.strictEqual(validateCart({ items: [] }).ok, false);
});
test('rejects a malformed SKU', () => {
  assert.strictEqual(validateCart({ items: [item({ sku: 'stk29' })] }).ok, false);
});
test('rejects a zero quantity (ticket #4502: $0 orders reached the payment provider)', () => {
  const r = validateCart({ items: [item({ quantity: 0 })] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors[0], /quantity/);
});
test('rejects a non-positive unit price', () => {
  assert.strictEqual(validateCart({ items: [item({ unitPrice: 0 })] }).ok, false);
});
`;

const VALIDATION_REPO: FixtureRepo = {
  id: "checkout-validation",
  title: "NOVA PAY checkout input validation",
  ticket: "Support ticket #4502: orders with quantity 0 passed checkout validation and reached the payment provider as $0 charges. CI: 'rejects a zero quantity' fails in src/checkout/validation.test.js.",
  files: { "src/checkout/validation.js": VALIDATION_BUGGY, "src/checkout/validation.test.js": VALIDATION_TESTS },
  sourceFiles: ["src/checkout/validation.js"],
  testFiles: ["src/checkout/validation.test.js"],
  writeScope: ["src/checkout/validation.js"],
  conventions: "CommonJS, no dependencies. validateCart returns { ok, errors[] } and never throws for bad input. Error messages name the field. Keep fixes minimal and inside the write scope.",
  security: "Validation is the trust boundary for client-supplied carts: every numeric field must be type-checked, not just range-checked. Error messages must not echo raw input.",
  candidates: [
    { file: "src/checkout/validation.js", label: "Reject quantity <= 0 (was only < 0)", code: VALIDATION_MINIMAL },
    { file: "src/checkout/validation.js", label: "Require an integer quantity >= 1", code: VALIDATION_FIXED },
  ],
  probes: [
    { id: "fractional-quantity", description: "A fractional quantity (1.5) is rejected", file: "src/checkout/validation.js", test: "assert.strictEqual(m.validateCart({ items: [{ sku: 'STK-0029', unitPrice: 0.29, quantity: 1.5 }] }).ok, false);" },
    { id: "nan-quantity", description: "A NaN quantity is rejected", file: "src/checkout/validation.js", test: "assert.strictEqual(m.validateCart({ items: [{ sku: 'STK-0029', unitPrice: 0.29, quantity: NaN }] }).ok, false);" },
    { id: "string-quantity", description: "A string quantity ('2') is rejected", file: "src/checkout/validation.js", test: "assert.strictEqual(m.validateCart({ items: [{ sku: 'STK-0029', unitPrice: 0.29, quantity: '2' }] }).ok, false);" },
    { id: "non-positive-price", description: "A negative unit price is rejected", file: "src/checkout/validation.js", test: "assert.strictEqual(m.validateCart({ items: [{ sku: 'STK-0029', unitPrice: -1, quantity: 1 }] }).ok, false);" },
  ],
  requiredProbes: ["fractional-quantity", "nan-quantity", "string-quantity"],
  securityChecks: (files) => {
    const code = files["src/checkout/validation.js"] ?? "";
    return [
      { check: "Quantity is type-checked as an integer", pass: /Number\.isInteger\(item\.quantity\)/.test(code) },
      { check: "Unit price is type-checked", pass: /typeof item\.unitPrice !== "number"/.test(code) },
      { check: "No eval / dynamic code execution", pass: !/\beval\(|new Function\(/.test(code) },
    ];
  },
};

const MATCH_BUGGY = `// Teammate matching for the HackMate sample app (product-factory example).
function overlap(a, b) {
  return a.filter((x) => b.includes(x)).length;
}
function score(seeker, candidate) {
  const skills = overlap(seeker.wantsSkills, candidate.skills);
  const interests = overlap(seeker.interests, candidate.interests);
  const hours = overlap(seeker.availability, candidate.availability);
  return skills * 3 + interests * 2 + hours;
}
function matchTeammates(seeker, candidates, limit = 5) {
  return candidates
    .filter((c) => c.id !== seeker.id)
    .map((c) => ({ id: c.id, score: score(seeker, c) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}
module.exports = { score, matchTeammates };
`;
// Minimal fix: filters on shared availability, but still crashes on profiles with missing fields — the reviewer's probes catch this.
const MATCH_MINIMAL = MATCH_BUGGY.replace(".filter((c) => c.id !== seeker.id)", ".filter((c) => c.id !== seeker.id && overlap(seeker.availability, c.availability) > 0)");
// Repair: normalise optional profile fields to arrays, then require shared availability.
const MATCH_FIXED = MATCH_MINIMAL.replace("function overlap(a, b) {\n  return a.filter((x) => b.includes(x)).length;\n}", "const list = (v) => (Array.isArray(v) ? v : []);\nfunction overlap(a, b) {\n  return list(a).filter((x) => list(b).includes(x)).length;\n}");

const MATCH_TESTS = `const test = require('node:test');
const assert = require('node:assert');
const { matchTeammates } = require('./match.js');

const me = { id: 'u1', wantsSkills: ['react', 'design'], interests: ['ai'], availability: ['sat-am', 'sun-pm'] };

test('ranks candidates by shared skills, interests and availability', () => {
  const r = matchTeammates(me, [
    { id: 'c2', skills: ['design'], interests: [], availability: ['sun-pm'] },
    { id: 'c1', skills: ['react'], interests: ['ai'], availability: ['sat-am'] },
  ]);
  assert.deepStrictEqual(r.map((x) => x.id), ['c1', 'c2']);
});
test('never recommends the seeker to themselves', () => {
  assert.deepStrictEqual(matchTeammates(me, [me]), []);
});
test('excludes candidates with no shared availability (FR-3: teammates must be able to meet)', () => {
  const r = matchTeammates(me, [{ id: 'c3', skills: ['react', 'design'], interests: ['ai'], availability: ['mon-pm'] }]);
  assert.deepStrictEqual(r, []);
});
test('respects the limit', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: 'c' + i, skills: ['react'], interests: [], availability: ['sat-am'] }));
  assert.strictEqual(matchTeammates(me, many, 3).length, 3);
});
`;

const MATCH_REPO: FixtureRepo = {
  id: "teammate-match",
  title: "HackMate teammate matching",
  ticket: "Story FR-3: students must only be matched with teammates who share at least one availability slot. CI: 'excludes candidates with no shared availability' fails in src/match/match.test.js.",
  files: { "src/match/match.js": MATCH_BUGGY, "src/match/match.test.js": MATCH_TESTS },
  sourceFiles: ["src/match/match.js"],
  testFiles: ["src/match/match.test.js"],
  writeScope: ["src/match/match.js"],
  conventions: "CommonJS, no dependencies. matchTeammates returns [{ id, score }] sorted by score then id, and never throws for incomplete profiles. Keep fixes inside the write scope.",
  security: "Profiles are user-supplied: tolerate missing/invalid fields, never evaluate dynamic code, and never return contact details (email, phone) in match results.",
  candidates: [
    { file: "src/match/match.js", label: "Filter out candidates without shared availability", code: MATCH_MINIMAL },
    { file: "src/match/match.js", label: "Normalise optional profile fields, then require shared availability", code: MATCH_FIXED },
  ],
  probes: [
    { id: "missing-availability", description: "A candidate without an availability field is excluded without crashing", file: "src/match/match.js", test: "assert.deepStrictEqual(m.matchTeammates({ id: 'u1', wantsSkills: ['react'], interests: [], availability: ['sat-am'] }, [{ id: 'x', skills: ['react'] }]), []);" },
    { id: "missing-skills", description: "A candidate without skills/interests is scored without crashing", file: "src/match/match.js", test: "assert.strictEqual(m.matchTeammates({ id: 'u1', wantsSkills: ['react'], interests: ['ai'], availability: ['sat-am'] }, [{ id: 'y', availability: ['sat-am'] }]).length, 1);" },
  ],
  requiredProbes: ["missing-availability", "missing-skills"],
  securityChecks: (files) => {
    const code = files["src/match/match.js"] ?? "";
    return [
      { check: "Optional profile fields are normalised before use", pass: /Array\.isArray/.test(code) },
      { check: "Match results expose no contact fields", pass: !/email|phone/i.test(code) },
      { check: "No eval / dynamic code execution", pass: !/\beval\(|new Function\(/.test(code) },
    ];
  },
};

export const REPOS: Record<string, FixtureRepo> = { [CHECKOUT_REPO.id]: CHECKOUT_REPO, [VALIDATION_REPO.id]: VALIDATION_REPO, [MATCH_REPO.id]: MATCH_REPO };

export function repoFor(template: string | null | undefined): FixtureRepo | null {
  return template ? REPOS[template] ?? null : null;
}

/** Sandbox file name for a repo path (the sandbox workspace is flat). */
export const sandboxName = (p: string) => p.split("/").pop()!;

export const MATCH_FIXTURE = { BUGGY: MATCH_BUGGY, MINIMAL: MATCH_MINIMAL, FIXED: MATCH_FIXED, TESTS: MATCH_TESTS };
export const VALIDATION_FIXTURE = { BUGGY: VALIDATION_BUGGY, MINIMAL: VALIDATION_MINIMAL, FIXED: VALIDATION_FIXED, TESTS: VALIDATION_TESTS };
