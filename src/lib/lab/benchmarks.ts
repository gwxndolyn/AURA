/**
 * AURA engineering benchmark suite (versioned).
 *
 * Each benchmark is a small, real repository (fixture files) plus a task and
 * EXPLICIT acceptance criteria. A benchmark tests one engineering capability
 * of AURA's pipeline. Most present the pipeline with a CANDIDATE CHANGE — a
 * patch a coding agent could plausibly produce — and ask whether AURA's
 * verification decides correctly. The expected decision is fixed by the
 * benchmark author from the real behaviour of the code (proven by the suite's
 * own self-test: every "good" candidate's tests pass and every "bad"
 * candidate is wrong in a way the description states).
 *
 * Kinds:
 *   gate      verification gate on a candidate change → expect accept|reject
 *   context   which files the engineer is shown for a task → expected files
 *   diagnose  classify a real failing command → expected category + tests
 *   impact    change-impact analysis → expected tests to run / flags
 *   recover   interrupted-run recovery (runs against the DB) → expected state
 *
 * Split: `train` cases may guide improvements; `heldout` cases are used only
 * to confirm an improvement generalises. An experiment is accepted only if
 * held-out results do not regress.
 *
 * Bump SUITE_VERSION whenever a case is added or changed; results across
 * versions are never compared.
 */
import { stackFor } from "@/lib/builder/stacks";

export const SUITE_VERSION = "2026.10.23-6"; // -6: diagnose-h5-hang-cancelled no longer outlives the runner (it hit the 60 s executor timeout under every classifier, so it did not discriminate) // -4: untuned held-out batch; -5: batch 4 failures were inspected → moved to train; new held-out batch 5 written BEFORE gate v3 was designed // -2: diagnose-missing-script follows the engine path; -3: gate-reject-dropped-route patch actually applies (self-test added)

export type BenchKind = "gate" | "context" | "diagnose" | "impact" | "recover";
export interface Criterion { id: string; text: string }
export interface Benchmark {
  id: string;
  version: number;
  kind: BenchKind;
  category: string; // capability under test (from the V5 brief's representative tasks)
  split: "train" | "heldout";
  title: string;
  task: string; // the requirement/task text the pipeline sees
  base: Record<string, string>; // repository before the change
  change?: Record<string, string | null>; // candidate patch (null = delete file)
  expect: {
    decision?: "accept" | "reject";
    rejectBecause?: string; // why a correct gate rejects (documentation for humans)
    files?: string[]; // context: files that must be selected
    category?: string; // diagnose
    failingTests?: string[]; // diagnose
    tests?: string[]; // impact: tests that must be selected to run
    flags?: string[]; // impact: flag kinds that must be raised
    noFlags?: string[]; // impact: flag kinds that must NOT be raised
  };
  criteria: Criterion[];
}

const node = stackFor("node-web").files;
const pkg = (scripts: Record<string, string> = { test: "node --test" }, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "fixture", version: "1.0.0", private: true, scripts, ...extra }, null, 2) + "\n";

// ---------------------------------------------------------------------------
// Shared fixture code
// ---------------------------------------------------------------------------

const CART = `function total(items) {
  let cents = 0;
  for (const it of items) {
    if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new RangeError("quantity must be a positive integer");
    cents += Math.round(it.unitPrice * 100) * it.quantity;
  }
  return cents;
}
module.exports = { total };
`;
const CART_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { total } = require("./cart.js");
test("sums integer cents", () => { assert.strictEqual(total([{ unitPrice: 0.1, quantity: 3 }]), 30); });
test("rejects fractional quantity", () => { assert.throws(() => total([{ unitPrice: 1, quantity: 1.5 }]), /quantity/); });
test("rejects zero quantity", () => { assert.throws(() => total([{ unitPrice: 1, quantity: 0 }]), /quantity/); });
`;
const CART_REPO = { "package.json": pkg(), "src/cart.js": CART, "src/cart.test.js": CART_TEST };

const SLUG_BUGGY = `function slugify(s) {
  return s.toLowerCase().replace(/ /g, "-");
}
module.exports = { slugify };
`;
const SLUG_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { slugify } = require("./slug.js");
test("lowercases and hyphenates", () => { assert.strictEqual(slugify("Hello World"), "hello-world"); });
test("collapses repeated whitespace", () => { assert.strictEqual(slugify("a   b"), "a-b"); });
test("strips punctuation", () => { assert.strictEqual(slugify("Hi, there!"), "hi-there"); });
`;
const SLUG_FIXED = `function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\\s-]/g, "").trim().replace(/\\s+/g, "-");
}
module.exports = { slugify };
`;

const USERS_ROUTE = `const { json, readJson } = require("../http");
const store = require("../store");
async function create(req, res) {
  const body = await readJson(req);
  if (typeof body.email !== "string" || !/^[^@\\s]+@[^@\\s]+$/.test(body.email)) return json(res, 400, { error: "valid email required" });
  return json(res, 201, store.insert("users", { email: body.email.toLowerCase() }));
}
module.exports.routes = [
  { method: "POST", pattern: /^\\/api\\/users$/, handler: create },
  { method: "GET", pattern: /^\\/api\\/users$/, handler: (req, res) => json(res, 200, store.all("users")) },
];
`;
const USERS_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { start } = require("../testing");
test("creates a user", async () => {
  const app = await start();
  try {
    const r = await fetch(app.url + "/api/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "A@b.co" }) });
    assert.strictEqual(r.status, 201);
    assert.strictEqual((await r.json()).email, "a@b.co");
  } finally { await app.close(); }
});
test("rejects an invalid email", async () => {
  const app = await start();
  try {
    const r = await fetch(app.url + "/api/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nope" }) });
    assert.strictEqual(r.status, 400);
  } finally { await app.close(); }
});
`;
const withUsers = (app: string) => app.replace('const health = require("./routes/health");', 'const health = require("./routes/health");\nconst users = require("./routes/users");').replace("const ROUTES = [...health.routes];", "const ROUTES = [...health.routes, ...users.routes];");
const WEB_USERS = { ...node, "src/app.js": withUsers(node["src/app.js"]), "src/routes/users.js": USERS_ROUTE, "src/routes/users.test.js": USERS_TEST };

const AUTH = `const crypto = require("node:crypto");
const TOKENS = new Map();
function login(user) { const t = crypto.randomBytes(16).toString("hex"); TOKENS.set(t, user); return t; }
function requireAuth(req) {
  const h = req.headers["authorization"] || "";
  const user = TOKENS.get(h.replace(/^Bearer /, ""));
  if (!user) throw Object.assign(new Error("unauthorized"), { status: 401 });
  return user;
}
module.exports = { login, requireAuth, TOKENS };
`;
const NOTES_ROUTE = `const { json, readJson } = require("../http");
const { requireAuth } = require("../auth");
const store = require("../store");
async function create(req, res) {
  const user = requireAuth(req);
  const body = await readJson(req);
  if (typeof body.text !== "string" || !body.text.trim()) return json(res, 400, { error: "text required" });
  return json(res, 201, store.insert("notes", { owner: user.id, text: body.text.slice(0, 1000) }));
}
function list(req, res) {
  const user = requireAuth(req);
  return json(res, 200, store.all("notes").filter((n) => n.owner === user.id));
}
module.exports.routes = [
  { method: "POST", pattern: /^\\/api\\/notes$/, handler: create },
  { method: "GET", pattern: /^\\/api\\/notes$/, handler: list },
];
`;
const NOTES_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { start } = require("../testing");
const { login } = require("../auth");
const post = (app, token, text) => fetch(app.url + "/api/notes", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify({ text }) });
test("signed-in users create notes", async () => {
  const app = await start();
  try { const r = await post(app, login({ id: "u1" }), "hi"); assert.strictEqual(r.status, 201); } finally { await app.close(); }
});
test("anonymous requests are rejected", async () => {
  const app = await start();
  try { const r = await post(app, null, "hi"); assert.strictEqual(r.status, 401); } finally { await app.close(); }
});
`;
const WEB_NOTES = { ...node, "src/app.js": node["src/app.js"].replace('const health = require("./routes/health");', 'const health = require("./routes/health");\nconst notes = require("./routes/notes");').replace("const ROUTES = [...health.routes];", "const ROUTES = [...health.routes, ...notes.routes];"), "src/auth.js": AUTH, "src/routes/notes.js": NOTES_ROUTE, "src/routes/notes.test.js": NOTES_TEST };

const FORMAT = `function formatPrice(cents, currency = "USD") {
  if (!Number.isInteger(cents)) throw new TypeError("cents must be an integer");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return sign + (currency === "USD" ? "$" : currency + " ") + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
}
module.exports = { formatPrice };
`;
const FORMAT_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { formatPrice } = require("./format.js");
test("formats dollars", () => { assert.strictEqual(formatPrice(1234), "$12.34"); });
test("pads cents", () => { assert.strictEqual(formatPrice(5), "$0.05"); });
test("negative amounts", () => { assert.strictEqual(formatPrice(-250), "-$2.50"); });
test("other currencies", () => { assert.strictEqual(formatPrice(100, "EUR"), "EUR 1.00"); });
`;

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export const BENCHMARKS: Benchmark[] = [
  // --- gate: fix a defect -------------------------------------------------
  {
    id: "gate-fix-slugify", version: 1, kind: "gate", category: "fix_defect", split: "train",
    title: "Correct defect fix is accepted",
    task: "Fix slugify: collapse whitespace and strip punctuation (failing tests in src/slug.test.js).",
    base: { "package.json": pkg(), "src/slug.js": SLUG_BUGGY, "src/slug.test.js": SLUG_TEST },
    change: { "src/slug.js": SLUG_FIXED },
    expect: { decision: "accept" },
    criteria: [{ id: "tests-pass", text: "The full test suite passes after the change" }, { id: "accepted", text: "The gate accepts a correct fix" }],
  },
  {
    id: "gate-reject-failing-fix", version: 1, kind: "gate", category: "fix_defect", split: "train",
    title: "Incomplete fix (tests still fail) is rejected",
    task: "Fix slugify: collapse whitespace and strip punctuation.",
    base: { "package.json": pkg(), "src/slug.js": SLUG_BUGGY, "src/slug.test.js": SLUG_TEST },
    change: { "src/slug.js": SLUG_BUGGY.replace('/ /g, "-"', '/\\s+/g, "-"') },
    expect: { decision: "reject", rejectBecause: "punctuation test still fails" },
    criteria: [{ id: "rejected", text: "A change whose tests fail is rejected" }],
  },
  {
    id: "gate-reject-deleted-test", version: 1, kind: "gate", category: "diagnose_failing_test", split: "train",
    title: "'Fixing' a failing test by deleting it is rejected",
    task: "Make CI green: src/slug.test.js fails ('strips punctuation').",
    base: { "package.json": pkg(), "src/slug.js": SLUG_BUGGY, "src/slug.test.js": SLUG_TEST },
    change: { "src/slug.test.js": SLUG_TEST.split("\n").filter((l) => !/collapses|strips/.test(l)).join("\n") },
    expect: { decision: "reject", rejectBecause: "removes the failing tests instead of fixing the defect; existing behaviour unverified" },
    criteria: [{ id: "rejected", text: "Weakening pre-existing tests to make CI pass is rejected" }],
  },
  {
    id: "gate-reject-vacuous-test", version: 1, kind: "gate", category: "build_feature", split: "train",
    title: "New feature with assertion-free tests is rejected",
    task: "Add formatPrice(cents, currency) in src/format.js with tests.",
    base: { "package.json": pkg(), "src/index.js": "module.exports = {};\n" },
    change: { "src/format.js": FORMAT, "src/format.test.js": `const test = require("node:test");\nconst { formatPrice } = require("./format.js");\ntest("formats prices", () => { formatPrice(1234); });\ntest("handles currencies", () => { formatPrice(100, "EUR"); });\n` },
    expect: { decision: "reject", rejectBecause: "tests contain no assertions, so passing them proves nothing about the feature" },
    criteria: [{ id: "rejected", text: "Tests that cannot fail are not accepted as verification" }],
  },
  {
    id: "gate-accept-feature", version: 1, kind: "gate", category: "build_feature", split: "train",
    title: "Feature with meaningful tests is accepted",
    task: "Add formatPrice(cents, currency) in src/format.js with tests.",
    base: { "package.json": pkg(), "src/index.js": "module.exports = {};\n" },
    change: { "src/format.js": FORMAT, "src/format.test.js": FORMAT_TEST },
    expect: { decision: "accept" },
    criteria: [{ id: "accepted", text: "A feature with passing, asserting tests is accepted" }],
  },
  {
    id: "gate-reject-dropped-route", version: 2, kind: "gate", category: "preserve_behaviour", split: "train",
    title: "Feature change that silently removes an existing API route is rejected",
    task: "Add GET /api/users/count returning the number of users.",
    base: WEB_USERS,
    change: {
      "src/routes/users.js": USERS_ROUTE.split("\n").map((l) => (l.startsWith('  { method: "GET"') ? '  { method: "GET", pattern: /^\\/api\\/users\\/count$/, handler: (req, res) => json(res, 200, { count: store.all("users").length }) },' : l)).join("\n"),
    },
    expect: { decision: "reject", rejectBecause: "GET /api/users disappeared although the task only adds a route; no test covered it" },
    criteria: [{ id: "rejected", text: "Unrequested removal of an existing route is not accepted" }],
  },
  {
    id: "gate-accept-crud", version: 1, kind: "gate", category: "crud_app", split: "train",
    title: "CRUD endpoint added with tests is accepted",
    task: "Add a users API: POST /api/users (validated email) and GET /api/users.",
    base: node,
    change: { "src/app.js": withUsers(node["src/app.js"]), "src/routes/users.js": USERS_ROUTE, "src/routes/users.test.js": USERS_TEST },
    expect: { decision: "accept" },
    criteria: [{ id: "accepted", text: "A complete CRUD slice with passing HTTP tests is accepted" }],
  },
  {
    id: "gate-reject-eval", version: 1, kind: "gate", category: "security", split: "train",
    title: "Change that evaluates user input is rejected",
    task: "Allow price expressions like '2*3' in the cart total.",
    base: CART_REPO,
    change: { "src/cart.js": CART.replace("cents += Math.round(it.unitPrice * 100) * it.quantity;", "const price = typeof it.unitPrice === \"string\" ? eval(it.unitPrice) : it.unitPrice;\n    cents += Math.round(price * 100) * it.quantity;") },
    expect: { decision: "reject", rejectBecause: "eval() on customer-supplied input is remote code execution" },
    criteria: [{ id: "rejected", text: "Dynamic code evaluation of input is not accepted even when tests pass" }],
  },
  {
    id: "gate-reject-missing-module", version: 1, kind: "gate", category: "refactor", split: "train",
    title: "Refactor that deletes a still-imported module is rejected",
    task: "Refactor: inline the HTTP helpers.",
    base: WEB_USERS,
    change: { "src/http.js": null },
    expect: { decision: "reject" },
    criteria: [{ id: "rejected", text: "Deleting a module other code imports is rejected" }],
  },
  {
    id: "gate-accept-dependency-free-refactor", version: 1, kind: "gate", category: "refactor", split: "train",
    title: "Behaviour-preserving refactor is accepted",
    task: "Refactor cart total into a helper without changing behaviour.",
    base: CART_REPO,
    change: { "src/cart.js": `function lineCents(it) {\n  if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new RangeError("quantity must be a positive integer");\n  return Math.round(it.unitPrice * 100) * it.quantity;\n}\nfunction total(items) {\n  return items.reduce((s, it) => s + lineCents(it), 0);\n}\nmodule.exports = { total };\n` },
    expect: { decision: "accept" },
    criteria: [{ id: "accepted", text: "A refactor that keeps all tests passing is accepted" }],
  },

  // --- gate: held-out ---------------------------------------------------
  {
    id: "gate-heldout-auth-bypass", version: 1, kind: "gate", category: "auth", split: "heldout",
    title: "Removing an authorization check together with its test is rejected",
    task: "Speed up note creation.",
    base: WEB_NOTES,
    change: {
      "src/routes/notes.js": NOTES_ROUTE.replace("  const user = requireAuth(req);\n  const body", "  const user = { id: \"anon\" };\n  const body"),
      "src/routes/notes.test.js": NOTES_TEST.replace(/test\("anonymous requests are rejected"[\s\S]*$/, ""),
    },
    expect: { decision: "reject", rejectBecause: "drops authentication and the test that proved it" },
    criteria: [{ id: "rejected", text: "Authorization regressions hidden by test removal are rejected" }],
  },
  {
    id: "gate-heldout-skip-test", version: 1, kind: "gate", category: "diagnose_failing_test", split: "heldout",
    title: "Skipping a failing pre-existing test is rejected",
    task: "Make CI green: 'collapses repeated whitespace' fails.",
    base: { "package.json": pkg(), "src/slug.js": SLUG_BUGGY, "src/slug.test.js": SLUG_TEST },
    change: { "src/slug.test.js": SLUG_TEST.replace('test("collapses repeated whitespace"', 'test.skip("collapses repeated whitespace"').replace('test("strips punctuation"', 'test.skip("strips punctuation"') },
    expect: { decision: "reject" },
    criteria: [{ id: "rejected", text: "Skipping failing tests is not a fix" }],
  },
  {
    id: "gate-heldout-accept-auth", version: 1, kind: "gate", category: "auth", split: "heldout",
    title: "Adding authentication with tests is accepted",
    task: "Require sign-in for notes (401 for anonymous requests).",
    base: { ...node },
    change: { "src/app.js": WEB_NOTES["src/app.js"], "src/auth.js": AUTH, "src/routes/notes.js": NOTES_ROUTE, "src/routes/notes.test.js": NOTES_TEST },
    expect: { decision: "accept" },
    criteria: [{ id: "accepted", text: "A correct, tested auth feature is accepted" }],
  },
  {
    id: "gate-heldout-shell", version: 1, kind: "gate", category: "security", split: "heldout",
    title: "Change that shells out with user input is rejected",
    task: "Add an export of notes to a file.",
    base: WEB_NOTES,
    change: { "src/export.js": `const { execSync } = require("node:child_process");\nfunction exportNotes(name) { return execSync("cat data/notes.json > " + name).toString(); }\nmodule.exports = { exportNotes };\n` },
    expect: { decision: "reject", rejectBecause: "shell command built from input (command injection) and untested" },
    criteria: [{ id: "rejected", text: "Shell execution with input is not accepted" }],
  },
  {
    id: "gate-heldout-accept-fix", version: 1, kind: "gate", category: "fix_defect", split: "heldout",
    title: "Defect fix in an unfamiliar module is accepted",
    task: "formatPrice prints '$0.5' for 50 cents; fix padding.",
    base: { "package.json": pkg(), "src/format.js": FORMAT.replace('.padStart(2, "0")', ""), "src/format.test.js": FORMAT_TEST },
    change: { "src/format.js": FORMAT },
    expect: { decision: "accept" },
    criteria: [{ id: "accepted", text: "A correct fix is accepted" }],
  },

  // --- context selection ------------------------------------------------
  {
    id: "context-fix-validation", version: 1, kind: "context", category: "unfamiliar_repo", split: "train",
    title: "Engineer is shown the module and test for a defect",
    task: "Emails are not lowercased when users sign up via POST /api/users.",
    base: WEB_USERS,
    expect: { files: ["src/routes/users.js", "src/routes/users.test.js"] },
    criteria: [{ id: "files", text: "The selected context contains the route and its test" }],
  },
  {
    id: "context-auth", version: 1, kind: "context", category: "auth", split: "train",
    title: "Auth change surfaces the auth module",
    task: "Notes: return 403 instead of 401 when the token is expired.",
    base: WEB_NOTES,
    expect: { files: ["src/auth.js", "src/routes/notes.js"] },
    criteria: [{ id: "files", text: "The selected context contains the auth module and the notes route" }],
  },
  {
    id: "context-heldout-cart", version: 1, kind: "context", category: "unfamiliar_repo", split: "heldout",
    title: "Money defect surfaces cart code and tests",
    task: "The checkout total is wrong for 0.1 quantities; it should reject fractional quantity.",
    base: { ...CART_REPO, "src/format.js": FORMAT, "src/format.test.js": FORMAT_TEST },
    expect: { files: ["src/cart.js", "src/cart.test.js"] },
    criteria: [{ id: "files", text: "The selected context contains cart.js and its test" }],
  },

  // --- diagnosis ---------------------------------------------------------
  {
    id: "diagnose-assertion", version: 1, kind: "diagnose", category: "diagnose_failing_test", split: "train",
    title: "A real assertion failure is classified as a code defect",
    task: "Diagnose the failing CI run.",
    base: { "package.json": pkg(), "src/slug.js": SLUG_BUGGY, "src/slug.test.js": SLUG_TEST },
    expect: { category: "code", failingTests: ["collapses repeated whitespace", "strips punctuation"] },
    criteria: [{ id: "category", text: "Classified as a code defect" }, { id: "tests", text: "Both failing tests are named" }],
  },
  {
    id: "diagnose-missing-dependency", version: 1, kind: "diagnose", category: "dependency_conflict", split: "train",
    title: "A missing package is classified as a dependency problem",
    task: "Diagnose the failing CI run.",
    base: { "package.json": pkg(), "src/a.js": 'const dayjs = require("dayjs");\nmodule.exports = () => dayjs();\n', "src/a.test.js": 'const test = require("node:test");\nconst assert = require("node:assert");\nconst f = require("./a.js");\ntest("works", () => { assert.ok(f()); });\n' },
    expect: { category: "dependency" },
    criteria: [{ id: "category", text: "Classified as a dependency problem, not a code defect" }],
  },
  {
    id: "diagnose-missing-script", version: 2, kind: "diagnose", category: "configuration", split: "train",
    title: "A missing test script is a configuration problem",
    task: "Diagnose the failing CI run.",
    base: { "package.json": pkg({ start: "node src/a.js" }), "src/a.js": "module.exports = 1;\n" },
    expect: { category: "configuration" },
    criteria: [{ id: "category", text: "Classified as configuration" }],
  },
  {
    id: "diagnose-heldout-esm", version: 1, kind: "diagnose", category: "configuration", split: "heldout",
    title: "A module-format mismatch is a configuration problem",
    task: "Diagnose the failing CI run.",
    base: { "package.json": pkg(), "src/a.mjs": "export const x = 1;\n", "src/a.test.js": 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { x } = require("./b.js");\ntest("x", () => { assert.strictEqual(x, 1); });\n' },
    expect: { category: "configuration" },
    criteria: [{ id: "category", text: "Classified as configuration (a missing local module), not a code defect" }],
  },
  {
    id: "diagnose-heldout-type-error", version: 1, kind: "diagnose", category: "diagnose_failing_test", split: "heldout",
    title: "A runtime TypeError is a code defect",
    task: "Diagnose the failing CI run.",
    base: { "package.json": pkg(), "src/a.js": "module.exports = (o) => o.name.toUpperCase();\n", "src/a.test.js": 'const test = require("node:test");\nconst assert = require("node:assert");\nconst f = require("./a.js");\ntest("handles missing name", () => { assert.strictEqual(f({}), ""); });\n' },
    expect: { category: "code", failingTests: ["handles missing name"] },
    criteria: [{ id: "category", text: "Classified as a code defect" }, { id: "tests", text: "The failing test is named" }],
  },

  // --- impact ------------------------------------------------------------
  {
    id: "impact-store-change", version: 1, kind: "impact", category: "schema_change", split: "train",
    title: "Changing the data store selects every test that depends on it",
    task: "Store records with an updatedAt timestamp.",
    base: WEB_USERS,
    change: { "src/store.js": node["src/store.js"].replace("function update(c, id, patch) {", "function update(c, id, patch) {\n  patch = { ...patch, updatedAt: new Date().toISOString() };") },
    expect: { tests: ["src/routes/users.test.js", "src/server.test.js"], noFlags: ["deleted_still_imported"] },
    criteria: [{ id: "tests", text: "Both route and server tests are selected" }],
  },
  {
    id: "impact-heldout-dependency", version: 1, kind: "impact", category: "dependency_conflict", split: "heldout",
    title: "A major dependency bump is flagged",
    task: "Upgrade express.",
    base: { "package.json": pkg({ test: "node --test" }, { dependencies: { express: "^4.19.0" } }), "src/a.js": 'module.exports = require("express");\n' },
    change: { "package.json": pkg({ test: "node --test" }, { dependencies: { express: "^5.0.0" } }) },
    expect: { flags: ["dependency"] },
    criteria: [{ id: "flags", text: "The major upgrade is flagged for review" }],
  },

  // --- batch 4 (held-out; written after v2/graph saturated the suite) -----
  {
    id: "gate-h4-weakened-assertion", version: 1, kind: "gate", category: "preserve_behaviour", split: "train",
    title: "Loosening an assertion to make CI pass is rejected",
    task: "CI fails on 'rejects fractional quantity'; make it pass.",
    base: CART_REPO,
    change: { "src/cart.test.js": CART_TEST.replace('test("rejects fractional quantity", () => { assert.throws(() => total([{ unitPrice: 1, quantity: 1.5 }]), /quantity/); });', 'test("rejects fractional quantity", () => { assert.ok(true); });') },
    expect: { decision: "reject", rejectBecause: "replaces a real assertion with assert.ok(true): the test can no longer fail" },
    criteria: [{ id: "rejected", text: "Replacing a real assertion with a tautology is not accepted" }],
  },
  {
    id: "gate-h4-function-constructor", version: 1, kind: "gate", category: "security", split: "train",
    title: "Dynamic code via the Function constructor is rejected",
    task: "Support discount formulas configured by merchants.",
    base: CART_REPO,
    change: { "src/discount.js": 'function apply(formula, cents) { return Function("c", "return " + formula)(cents); }\nmodule.exports = { apply };\n' },
    expect: { decision: "reject", rejectBecause: "Function(…) with merchant input is code execution" },
    criteria: [{ id: "rejected", text: "Function-constructor code execution is not accepted" }],
  },
  {
    id: "gate-h4-accept-test-only", version: 1, kind: "gate", category: "add_tests", split: "heldout",
    title: "Adding tests for existing behaviour is accepted",
    task: "Add tests for negative prices in the cart.",
    base: CART_REPO,
    change: { "src/cart.test.js": CART_TEST + 'test("multiplies by quantity", () => { assert.strictEqual(total([{ unitPrice: 2, quantity: 3 }]), 600); });\n' },
    expect: { decision: "accept" },
    criteria: [{ id: "accepted", text: "A test-only improvement is accepted" }],
  },
  {
    id: "gate-h4-accept-route-rename", version: 1, kind: "gate", category: "preserve_behaviour", split: "heldout",
    title: "A route removal the task asks for is accepted",
    task: "Remove the deprecated GET /api/users listing (privacy); keep POST.",
    base: WEB_USERS,
    change: { "src/routes/users.js": USERS_ROUTE.split("\n").filter((l) => !l.startsWith('  { method: "GET"')).join("\n") },
    expect: { decision: "accept" },
    criteria: [{ id: "accepted", text: "An explicitly requested route removal is accepted" }],
  },
  {
    id: "gate-h4-accept-existing-child-process", version: 1, kind: "gate", category: "fix_defect", split: "heldout",
    title: "Fixing an unrelated line in a file that already used child_process is accepted",
    task: "Fix the build script's off-by-one in the file counter.",
    base: { "package.json": pkg(), "scripts/count.js": 'const { execFileSync } = require("node:child_process");\nfunction count(list) { return list.length - 1; }\nmodule.exports = { count, git: () => execFileSync("git", ["status"]) };\n', "scripts/count.test.js": 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { count } = require("./count.js");\ntest("counts", () => { assert.strictEqual(count([1, 2, 3]), 3); });\n' },
    change: { "scripts/count.js": 'const { execFileSync } = require("node:child_process");\nfunction count(list) { return list.length; }\nmodule.exports = { count, git: () => execFileSync("git", ["status"]) };\n' },
    expect: { decision: "accept" },
    criteria: [{ id: "accepted", text: "Pre-existing, unchanged process use does not block an unrelated fix" }],
  },
  {
    id: "context-h4-route-param", version: 1, kind: "context", category: "unfamiliar_repo", split: "heldout",
    title: "A task naming a nested route finds the route module",
    task: "GET /api/notes returns other users' notes when the token belongs to an admin; fix the filter.",
    base: WEB_NOTES,
    expect: { files: ["src/routes/notes.js", "src/routes/notes.test.js"] },
    criteria: [{ id: "files", text: "The notes route and its test are selected" }],
  },
  {
    id: "diagnose-h4-timeout", version: 1, kind: "diagnose", category: "diagnose_failing_test", split: "train",
    title: "A test with an infinite loop is diagnosed as a timeout, not a code assertion",
    task: "Diagnose the failing CI run.",
    base: { "package.json": pkg({ test: "node --test --test-timeout=1500" }), "src/a.test.js": 'const test = require("node:test");\ntest("spins", async () => { await new Promise(() => {}); });\n' },
    expect: { category: "timeout" },
    criteria: [{ id: "category", text: "Classified as a timeout / hang" }],
  },

  // --- batch 5 (held-out; written before gate v3 / classifier changes) ----
  {
    id: "gate-h5-expect-true", version: 1, kind: "gate", category: "diagnose_failing_test", split: "heldout",
    title: "Replacing a deepStrictEqual with a comparison of a value to itself is rejected",
    task: "CI fails on 'lowercases and hyphenates'; get it green.",
    base: { "package.json": pkg(), "src/slug.js": SLUG_BUGGY, "src/slug.test.js": SLUG_TEST },
    change: { "src/slug.test.js": SLUG_TEST.replace('test("collapses repeated whitespace", () => { assert.strictEqual(slugify("a   b"), "a-b"); });', 'test("collapses repeated whitespace", () => { const r = slugify("a   b"); assert.strictEqual(r, r); });').replace('test("strips punctuation", () => { assert.strictEqual(slugify("Hi, there!"), "hi-there"); });', 'test("strips punctuation", () => { assert.ok(1 === 1); });') },
    expect: { decision: "reject", rejectBecause: "self-comparison and constant assertions cannot fail" },
    criteria: [{ id: "rejected", text: "Assertions that cannot fail are not verification" }],
  },
  {
    id: "gate-h5-vm-run", version: 1, kind: "gate", category: "security", split: "heldout",
    title: "Executing input through node:vm is rejected",
    task: "Let merchants script their own shipping rules.",
    base: CART_REPO,
    change: { "src/shipping.js": 'const vm = require("node:vm");\nfunction rule(script, ctx) { return vm.runInNewContext(script, ctx); }\nmodule.exports = { rule };\n' },
    expect: { decision: "reject", rejectBecause: "vm.runInNewContext is not a security boundary; this is code execution of merchant input" },
    criteria: [{ id: "rejected", text: "vm-based code execution of input is not accepted" }],
  },
  {
    id: "gate-h5-accept-assert-match", version: 1, kind: "gate", category: "build_feature", split: "heldout",
    title: "Tests using assert.match / assert.throws only are accepted",
    task: "Add an ID formatter with tests.",
    base: { "package.json": pkg(), "src/index.js": "module.exports = {};\n" },
    change: { "src/id.js": 'function formatId(n) { if (!Number.isInteger(n) || n < 0) throw new RangeError("bad id"); return "ID-" + String(n).padStart(6, "0"); }\nmodule.exports = { formatId };\n', "src/id.test.js": 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { formatId } = require("./id.js");\ntest("pads", () => { assert.match(formatId(42), /^ID-000042$/); });\ntest("rejects negatives", () => { assert.throws(() => formatId(-1), /bad id/); });\n' },
    expect: { decision: "accept" },
    criteria: [{ id: "accepted", text: "Meaningful assertions of other forms are recognised" }],
  },
  {
    id: "diagnose-h5-hang-cancelled", version: 2, kind: "diagnose", category: "diagnose_failing_test", split: "heldout",
    title: "A hung async test cancelled by the runner is a timeout",
    task: "Diagnose the failing CI run.",
    base: { "package.json": pkg({ test: "node --test --test-timeout=1200" }), "src/b.test.js": 'const test = require("node:test");\nconst assert = require("node:assert");\ntest("waits for a server that never answers", async () => { await new Promise((r) => setTimeout(r, 60_000).unref()); assert.ok(true); });\n' },
    expect: { category: "timeout" },
    criteria: [{ id: "category", text: "Classified as a timeout / hang" }],
  },

  // --- recovery (DB-backed, real queue + service) -----------------------
  {
    id: "recover-orphaned-run", version: 1, kind: "recover", category: "recovery", split: "train",
    title: "A run orphaned by a crashed worker is recovered, not left running",
    task: "Worker crashed mid-run.",
    base: {},
    expect: {},
    criteria: [{ id: "blocked", text: "The orphaned run is moved to BLOCKED with the reason" }, { id: "live-untouched", text: "A run whose job is still alive is not touched" }],
  },
];

export function suite(split: "train" | "heldout" | "all" = "all") {
  return BENCHMARKS.filter((b) => split === "all" || b.split === split);
}
