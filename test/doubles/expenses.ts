/**
 * TEST SCENARIO (automated tests ONLY) — V10 benchmark: "Build a responsive
 * personal expense tracker with categories, transaction creation and editing,
 * monthly totals, category filtering, and persistent storage."
 *
 * This double plays the MODEL only. Every tool call it returns is executed for
 * real by AURA (files written to the working tree, npm test in the Docker
 * sandbox, the app rendered in real Chromium). It does not prove live model
 * quality; it proves the pipeline's behaviour around a realistic agent:
 *
 *   E1.S1.T1 BACKEND  expenses API (CRUD, validation, monthly totals, filter)
 *   E1.S1.T2 FRONTEND UI (depends on T1). Attempt 1 has a REAL defect the
 *            unit tests do not catch: after creating an expense the list is
 *            not reloaded and the form's amount field has no label. Browser
 *            verification finds both; the repair fixes them.
 *   change   "Add a way to delete an expense" → targeted task on existing files.
 *
 * Responses are chosen from the REAL system prompt AURA sends (role card +
 * task) and the task key in the context — the same signals a model gets.
 */
import { text, tool, lastUserText } from "./anthropic";

export const REQUEST = "Build a responsive personal expense tracker with categories, transaction creation and editing, monthly totals, category filtering, and persistent storage.";

export const BRIEF = {
  title: "Pocket Ledger",
  problem: "People lose track of small everyday spending and cannot see where their money goes each month.",
  coreJourney: "Record an expense in seconds and immediately see this month's total by category.",
  valueProposition: "The fastest way to log spending and see monthly totals per category.",
  constraints: ["Responsive", "Categories", "Create and edit transactions", "Monthly totals", "Category filtering", "Persistent storage"],
  definitionOfDone: ["Expenses persist across reload and restart", "Monthly totals are correct", "Filtering changes the list", "Works at 390px wide"],
  personas: [{ name: "Everyday spender", needs: ["Log an expense quickly", "See monthly totals"] }],
  outcomes: ["A user logs an expense and sees the updated monthly total in under 10 seconds"],
  functional: [
    { id: "FR-1", text: "Users can create an expense with description, amount, category and date" },
    { id: "FR-2", text: "Users can edit an existing expense" },
    { id: "FR-3", text: "Users see the total per month, overall and per category" },
    { id: "FR-4", text: "Users can filter the list by category" },
  ],
  nonFunctional: [{ id: "NFR-1", text: "Data persists across reloads and server restarts" }, { id: "NFR-2", text: "Usable at 390px width without horizontal scrolling; all fields labelled" }],
  mvp: ["Create/edit expenses", "Monthly totals", "Category filter"],
  outOfScope: ["Bank sync", "Multiple currencies", "Accounts"],
  journeys: [{ name: "Log an expense", steps: ["Open the app", "Fill description, amount, category, date", "Save", "See it in the list and the month total update"] }],
  acceptance: [
    { id: "AC-1", text: "Invalid amounts (≤ 0 or not a number) are rejected with a 400 and a message", measurable: true },
    { id: "AC-2", text: "The monthly total equals the sum of that month's expenses", measurable: true },
    { id: "AC-3", text: "Filtering by category shows only that category's expenses", measurable: true },
    { id: "AC-4", text: "A created expense is still listed after reload", measurable: true },
  ],
  assumptions: [{ id: "A-1", text: "Single user, no accounts in the MVP", editable: true }, { id: "A-2", text: "Amounts in one currency, stored in cents", editable: true }],
  risks: ["Floating-point rounding in totals"],
  questions: [],
  milestones: [{ id: "M1", name: "MVP", goal: "Log, edit, total and filter expenses" }],
};

export const BACKLOG = {
  epics: [{ key: "E1", title: "Expense tracking", stories: [{ key: "E1.S1", title: "Log and review expenses", acceptance: ["Expenses can be created, edited, totalled and filtered"], milestone: "M1", tasks: [
    { key: "E1.S1.T1", title: "Expenses API", description: "CRUD JSON API for expenses under /api/expenses with validation, monthly totals (/api/expenses/summary?month=YYYY-MM) and ?category= filtering, persisted with src/store.js.", kind: "BACKEND", acceptance: ["POST /api/expenses validates amount > 0, description and category, else 400", "PUT /api/expenses/:id edits an expense; unknown id → 404", "GET /api/expenses?category=X returns only that category", "GET /api/expenses/summary?month=YYYY-MM returns the month total and per-category totals in cents"], dependsOn: [], effort: 3, risk: "MEDIUM", files: ["src/routes/expenses.js", "src/routes/expenses.test.js", "src/app.js"], requirements: ["FR-1", "FR-2", "FR-3", "FR-4", "AC-1", "AC-2", "AC-3"] },
    { key: "E1.S1.T2", title: "Expense tracker UI", description: "Responsive single page: form to add/edit an expense, list with category filter, month total and per-category totals, wired to the API.", kind: "FRONTEND", acceptance: ["The page has a labelled form that creates an expense via POST /api/expenses", "A created expense appears in the list without a manual reload and is still listed after reload", "Choosing a category filter changes the list", "The month total is shown and updates after changes"], dependsOn: ["E1.S1.T1"], effort: 3, risk: "LOW", files: ["public/index.html", "public/app.js", "public/styles.css", "src/ui.test.js"], requirements: ["FR-1", "FR-3", "FR-4", "AC-4", "NFR-2"] },
  ] }] }],
};

const API = `const { json, readJson } = require("../http");
const store = require("../store");
const CATEGORIES = ["food", "transport", "housing", "fun", "other"];
function validate(b, partial) {
  const errors = [];
  if (!partial || b.description !== undefined) if (typeof b.description !== "string" || !b.description.trim()) errors.push("description is required");
  if (!partial || b.amount !== undefined) { const n = Number(b.amount); if (!Number.isFinite(n) || n <= 0) errors.push("amount must be a number greater than 0"); }
  if (!partial || b.category !== undefined) if (!CATEGORIES.includes(b.category)) errors.push("category must be one of " + CATEGORIES.join(", "));
  if (!partial || b.date !== undefined) if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(b.date || ""))) errors.push("date must be YYYY-MM-DD");
  return errors;
}
const toRow = (b) => ({ description: String(b.description).trim().slice(0, 200), amountCents: Math.round(Number(b.amount) * 100), category: b.category, date: b.date });
async function create(req, res) {
  const b = await readJson(req);
  const errors = validate(b, false);
  if (errors.length) return json(res, 400, { error: errors.join("; ") });
  return json(res, 201, store.insert("expenses", toRow(b)));
}
async function edit(req, res, ctx) {
  const cur = store.get("expenses", ctx.params.id);
  if (!cur) return json(res, 404, { error: "expense not found" });
  const b = await readJson(req);
  const errors = validate(b, true);
  if (errors.length) return json(res, 400, { error: errors.join("; ") });
  const merged = { ...cur, ...b, amount: b.amount !== undefined ? b.amount : cur.amountCents / 100 };
  return json(res, 200, store.update("expenses", cur.id, toRow(merged)));
}
function list(req, res, ctx) {
  const c = ctx.query.get("category");
  const rows = store.all("expenses").filter((e) => !c || e.category === c).sort((a, b) => b.date.localeCompare(a.date));
  return json(res, 200, rows);
}
function summary(req, res, ctx) {
  const month = ctx.query.get("month") || new Date().toISOString().slice(0, 7);
  if (!/^\\d{4}-\\d{2}$/.test(month)) return json(res, 400, { error: "month must be YYYY-MM" });
  const rows = store.all("expenses").filter((e) => e.date.startsWith(month));
  const byCategory = {};
  for (const e of rows) byCategory[e.category] = (byCategory[e.category] || 0) + e.amountCents;
  return json(res, 200, { month, totalCents: rows.reduce((s, e) => s + e.amountCents, 0), byCategory, count: rows.length });
}
module.exports.routes = [
  { method: "GET", pattern: /^\\/api\\/expenses\\/summary$/, handler: summary },
  { method: "POST", pattern: /^\\/api\\/expenses$/, handler: create },
  { method: "GET", pattern: /^\\/api\\/expenses$/, handler: list },
  { method: "PUT", pattern: /^\\/api\\/expenses\\/(?<id>[\\w-]+)$/, handler: edit },
];
module.exports.CATEGORIES = CATEGORIES;
`;

const API_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { start } = require("../testing");
const post = (app, body) => fetch(app.url + "/api/expenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
test("rejects invalid amounts with 400", async () => { const app = await start(); try { for (const amount of [0, -3, "abc"]) { const r = await post(app, { description: "x", amount, category: "food", date: "2026-10-01" }); assert.strictEqual(r.status, 400); assert.match((await r.json()).error, /amount/); } } finally { await app.close(); } });
test("monthly total equals the sum of that month's expenses", async () => { const app = await start(); try {
  await post(app, { description: "a", amount: 10.1, category: "food", date: "2026-10-02" });
  await post(app, { description: "b", amount: 0.2, category: "transport", date: "2026-10-30" });
  await post(app, { description: "c", amount: 99, category: "food", date: "2026-09-30" });
  const s = await (await fetch(app.url + "/api/expenses/summary?month=2026-10")).json();
  assert.strictEqual(s.totalCents, 1030); assert.deepStrictEqual(s.byCategory, { food: 1010, transport: 20 }); } finally { await app.close(); } });
test("category filter returns only that category", async () => { const app = await start(); try {
  await post(app, { description: "a", amount: 1, category: "food", date: "2026-10-02" }); await post(app, { description: "b", amount: 2, category: "fun", date: "2026-10-03" });
  const rows = await (await fetch(app.url + "/api/expenses?category=fun")).json(); assert.deepStrictEqual(rows.map((r) => r.description), ["b"]); } finally { await app.close(); } });
test("edit updates an expense; unknown id is 404", async () => { const app = await start(); try {
  const e = await (await post(app, { description: "a", amount: 1, category: "food", date: "2026-10-02" })).json();
  const r = await fetch(app.url + "/api/expenses/" + e.id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 4.5 }) });
  assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).amountCents, 450);
  assert.strictEqual((await fetch(app.url + "/api/expenses/nope", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status, 404); } finally { await app.close(); } });
`;

const APP_PATCH = (src: string) => src.includes("./routes/expenses") ? src : src.replace('const health = require("./routes/health");', 'const health = require("./routes/health");\nconst expenses = require("./routes/expenses");').replace("const ROUTES = [...health.routes];", "const ROUTES = [...health.routes, ...expenses.routes];");

const HTML = (labelled: boolean) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pocket Ledger</title><link rel="stylesheet" href="/styles.css"></head>
<body>
<main>
  <header><h1>Pocket Ledger</h1><p class="total" aria-live="polite">This month: <strong id="month-total" data-testid="month-total">…</strong></p></header>
  <form id="expense-form" data-testid="expense-form" novalidate>
    <input type="hidden" id="edit-id">
    <label for="description">Description</label><input id="description" name="description" required maxlength="200">
    ${labelled ? '<label for="amount">Amount</label>' : ""}<input id="amount" name="amount" type="number" step="0.01" min="0.01" required>
    <label for="category">Category</label><select id="category" name="category"><option value="food">Food</option><option value="transport">Transport</option><option value="housing">Housing</option><option value="fun">Fun</option><option value="other">Other</option></select>
    <label for="date">Date</label><input id="date" name="date" type="date" required>
    <p id="form-error" role="alert" class="error"></p>
    <button type="submit" id="save">Save expense</button>
  </form>
  <section aria-labelledby="list-h"><h2 id="list-h">Expenses</h2>
    <label for="filter">Show</label><select id="filter" data-testid="filter"><option value="">All categories</option><option value="food">Food</option><option value="transport">Transport</option><option value="housing">Housing</option><option value="fun">Fun</option><option value="other">Other</option></select>
    <ul id="list" data-testid="expense-list"></ul><p id="empty" class="muted">No expenses yet.</p>
    <ul id="by-category" data-testid="by-category"></ul>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>
`;
const CSS = `:root { --ink:#1f2328; --muted:#5b6470; --line:#d8dde3; --accent:#0b6e4f; --danger:#b42318; --space:8px; color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: var(--ink); }
body { margin: 0; } main { max-width: 720px; margin: 0 auto; padding: calc(var(--space) * 3); }
form { display: grid; gap: var(--space); grid-template-columns: 1fr; margin-bottom: calc(var(--space) * 3); }
input, select, button { font: inherit; padding: var(--space); border: 1px solid var(--line); border-radius: 6px; max-width: 100%; box-sizing: border-box; }
button { background: var(--accent); color: #fff; border: 0; cursor: pointer; } .error { color: var(--danger); min-height: 1.5em; margin: 0; }
ul { list-style: none; padding: 0; } li { display: flex; justify-content: space-between; gap: var(--space); padding: var(--space) 0; border-bottom: 1px solid var(--line); } .muted { color: var(--muted); }
@media (min-width: 720px) { form { grid-template-columns: 1fr 1fr; } form button, form .error { grid-column: 1 / -1; } }
`;
const JS = (refresh: boolean) => `const $ = (id) => document.getElementById(id);
const money = (c) => (c / 100).toFixed(2);
async function api(path, opts) { const r = await fetch(path, opts); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || "Request failed (" + r.status + ")"); return b; }
async function load() {
  const cat = $("filter").value;
  const rows = await api("/api/expenses" + (cat ? "?category=" + encodeURIComponent(cat) : ""));
  $("list").innerHTML = "";
  for (const e of rows) { const li = document.createElement("li"); li.innerHTML = "<span></span><span></span>"; li.children[0].textContent = e.date + " · " + e.description + " (" + e.category + ")"; li.children[1].textContent = money(e.amountCents);
    const b = document.createElement("button"); b.type = "button"; b.textContent = "Edit"; b.setAttribute("data-action", "edit"); b.setAttribute("aria-label", "Edit " + e.description); b.onclick = () => { $("edit-id").value = e.id; $("description").value = e.description; $("amount").value = money(e.amountCents); $("category").value = e.category; $("date").value = e.date; $("save").textContent = "Update expense"; }; li.appendChild(b); $("list").appendChild(li); }
  $("empty").hidden = rows.length > 0;
  const s = await api("/api/expenses/summary?month=" + new Date().toISOString().slice(0, 7));
  $("month-total").textContent = money(s.totalCents);
  $("by-category").innerHTML = Object.entries(s.byCategory).map(([k, v]) => "<li><span>" + k + "</span><span>" + money(v) + "</span></li>").join("");
}
$("filter").addEventListener("change", () => load().catch((e) => ($("form-error").textContent = e.message)));
$("expense-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("form-error").textContent = "";
  const id = $("edit-id").value;
  const body = { description: $("description").value, amount: Number($("amount").value), category: $("category").value, date: $("date").value };
  $("save").disabled = true;
  try {
    await api(id ? "/api/expenses/" + id : "/api/expenses", { method: id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    ev.target.reset(); $("edit-id").value = ""; $("save").textContent = "Save expense"; $("date").value = new Date().toISOString().slice(0, 10);
    ${refresh ? "await load();" : "// list refreshed on next page load"}
  } catch (e) { $("form-error").textContent = e.message; } finally { $("save").disabled = false; }
});
$("date").value = new Date().toISOString().slice(0, 10);
load().catch((e) => ($("form-error").textContent = e.message));
`;
const UI_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { start } = require("./testing");
test("the tracker page and script are served with a labelled form", async () => { const app = await start(); try {
  const html = await (await fetch(app.url + "/")).text();
  assert.match(html, /id="expense-form"/); assert.match(html, /<label for="description">/); assert.match(html, /id="filter"/);
  const js = await fetch(app.url + "/app.js"); assert.strictEqual(js.status, 200); assert.match(await js.text(), /\\/api\\/expenses/); } finally { await app.close(); } });
`;

// Follow-up change: delete an expense.
export const CHANGE_REQUEST = "Add a way to delete an expense from the list.";
export const CHANGE_PLAN = {
  summary: "Delete an expense",
  kind: "feature",
  tasks: [{ title: "Delete expense endpoint and button", description: "Add DELETE /api/expenses/:id (404 for unknown ids) and a Delete button per list row that removes the expense and refreshes the list and totals.", kind: "FRONTEND", acceptance: ["DELETE /api/expenses/:id removes the expense; unknown id → 404", "Each listed expense has a labelled Delete button that removes it and updates the totals"], files: ["src/routes/expenses.js", "public/app.js", "src/routes/expenses-delete.test.js"], dependsOnIndex: [], risk: "LOW" }],
  preserves: ["Creating, editing, filtering and monthly totals", "Existing tests"],
};
const DELETE_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { start } = require("../testing");
test("delete removes an expense and unknown id is 404", async () => { const app = await start(); try {
  const e = await (await fetch(app.url + "/api/expenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "a", amount: 3, category: "food", date: "2026-10-02" }) })).json();
  assert.strictEqual((await fetch(app.url + "/api/expenses/" + e.id, { method: "DELETE" })).status, 204);
  assert.deepStrictEqual(await (await fetch(app.url + "/api/expenses")).json(), []);
  assert.strictEqual((await fetch(app.url + "/api/expenses/" + e.id, { method: "DELETE" })).status, 404); } finally { await app.close(); } });
`;

export const COUNT_REQUEST = "Show the number of expenses next to the month total.";
const COUNT_PLAN = { summary: "Show the expense count next to the monthly total", kind: "ux", tasks: [{ title: "Expense count in the header", description: "Display the month's expense count (from GET /api/expenses/summary, field count) next to the total.", kind: "FRONTEND", acceptance: ["The header shows the month total and the number of expenses", "The summary still loads from GET /api/expenses/summary"], files: ["public/app.js"], dependsOnIndex: [], risk: "LOW" }], preserves: ["Creating, editing, filtering, deleting and totals"] };
export const RATES_REQUEST = "Add live exchange rates from our FX provider.";
const RATES_PLAN = { summary: "Live exchange rates", kind: "feature", tasks: [{ title: "Exchange rates endpoint", description: "Add GET /api/rates calling the FX provider with FX_API_KEY.", kind: "BACKEND", acceptance: ["GET /api/rates returns the provider's rates"], files: ["src/routes/rates.js", "src/routes/rates.test.js", "src/app.js"], dependsOnIndex: [], risk: "LOW" }], preserves: ["All existing endpoints"] };
const MONEY = `// Shared money helpers (single implementation of cents conversion).
function toCents(amount) { return Math.round(Number(amount) * 100); }
module.exports = { toCents };
`;
const RATES = `const { json } = require("../http");
// Needs a provider key; without it the route cannot work (this is configuration, not a code defect).
const KEY = process.env.FX_API_KEY;
async function rates(req, res) {
  if (!KEY) return json(res, 500, { error: "FX_API_KEY is undefined" });
  const r = await fetch("https://api.fx-rates.example.net/v1/latest?key=" + KEY);
  return json(res, 200, await r.json());
}
module.exports.routes = [{ method: "GET", pattern: /^\\/api\\/rates$/, handler: rates }];
`;
const RATES_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { start } = require("../testing");
test("rates are returned", async () => { const app = await start(); try { const r = await fetch(app.url + "/api/rates"); assert.strictEqual(r.status, 200, "FX_API_KEY is undefined"); } finally { await app.close(); } });
`;

type Req = { system: string; messages: { role: string; content: unknown }[]; tools: { name: string }[] };

/** Scripted model for the benchmark. */
export function expensesScripted() {
  const steps: Record<string, number> = {};
  const attempts: Record<string, number> = {};
  const stats = { reviewerCalls: 0, securityCalls: 0, frontendAttempts: 0 };
  const respond = (req: Req) => {
    const u = lastUserText(req.messages);
    const first = JSON.stringify(req.messages[0] ?? "");
    if (/maintaining an EXISTING application/.test(req.system)) {
      if (/number of expenses/i.test(u)) return [text(JSON.stringify(COUNT_PLAN))];
      if (/exchange rate/i.test(u)) return [text(JSON.stringify(RATES_PLAN))];
      return [text(JSON.stringify(CHANGE_PLAN))];
    }
    if (/Product Manager/.test(req.system) && /backlog/i.test(req.system)) return [text(JSON.stringify(BACKLOG))];
    if (/Product Manager/.test(req.system)) return [text(JSON.stringify(BRIEF))];
    const task = first.match(/# Task (E1\.S1\.T\d|C1\.T1|C2\.T1|C3\.T1|M1\.T\d+)/)?.[1];
    const engineer = /You are Atlas|You are Nova/.test(req.system);
    if (engineer && task) {
      if (req.messages.length === 1) {
        steps[task] = 0;
        if (/What failed last time/.test(first)) attempts[task] = (attempts[task] ?? 0) + 1;
      }
      const step = ++steps[task];
      const repairing = (attempts[task] ?? 0) > 0;
      if (task === "E1.S1.T1") {
        if (step === 1) return [tool("fs_read", { path: "src/app.js" })];
        if (step === 2) return [tool("fs_write", { path: "src/routes/expenses.js", content: API }), tool("fs_write", { path: "src/routes/expenses.test.js", content: API_TEST }), tool("fs_write", { path: "src/app.js", content: APP_PATCH((JSON.parse(u) as { content: string }).content) })];
        if (step === 3) return [tool("cmd_run", { command: "npm test", purpose: "test" })];
        return [text("Implemented /api/expenses (create, edit, filter, monthly summary) with validation and tests; npm test passes.")];
      }
      if (task === "E1.S1.T2") {
        if (step === 1) {
          stats.frontendAttempts++;
          return [tool("fs_read", { path: "src/routes/expenses.js" })];
        }
        if (step === 2) return [tool("fs_write", { path: "public/index.html", content: HTML(repairing) }), tool("fs_write", { path: "public/app.js", content: JS(repairing) }), tool("fs_write", { path: "public/styles.css", content: CSS }), tool("fs_write", { path: "src/ui.test.js", content: UI_TEST })];
        if (step === 3) return [tool("cmd_run", { command: "npm test", purpose: "test" })];
        return [text(repairing ? "Fixed: the list and totals reload after saving; the amount field has a label." : "Built the tracker UI wired to /api/expenses; npm test passes.")];
      }
      // V13 integration defect: attempt 1 renames the client call to a route that does not exist (a real
      // contract break the unit test does not see); the repair, guided by the investigation, restores it.
      if (task === "C2.T1") {
        if (step === 1) return [tool("fs_read", { path: "public/app.js" })];
        if (step === 2) {
          const src = (JSON.parse(u) as { content: string }).content;
          const label = src.replace('$("month-total").textContent = money(s.totalCents);', '$("month-total").textContent = money(s.totalCents) + " (" + s.count + " expenses)";');
          // Repair (guided by the investigation's suggestion): restore the existing contract path in the CURRENT file.
          const next = repairing ? label.replace('api("/api/expense-summary?month=', 'api("/api/expenses/summary?month=') : label.replace('api("/api/expenses/summary?month=', 'api("/api/expense-summary?month=');
          return [tool("fs_write", { path: "public/app.js", content: next })];
        }
        if (step === 3) return [tool("cmd_run", { command: "npm test", purpose: "test" })];
        return [text(repairing ? "Restored the summary call to the existing GET /api/expenses/summary contract." : "Show the number of expenses next to the month total.")];
      }
      // V13 infrastructure limitation: the feature needs an exchange-rate provider key no environment provides.
      if (task === "C3.T1") {
        if (step === 1) return [tool("fs_read", { path: "src/app.js" })];
        if (step === 2) {
          const src = (JSON.parse(u) as { content: string }).content;
          const app = src.includes("./routes/rates") ? src : src.replace('const expenses = require("./routes/expenses");', 'const expenses = require("./routes/expenses");\nconst rates = require("./routes/rates");').replace("...expenses.routes]", "...expenses.routes, ...rates.routes]");
          return [tool("fs_write", { path: "src/routes/rates.js", content: RATES }), tool("fs_write", { path: "src/routes/rates.test.js", content: RATES_TEST }), tool("fs_write", { path: "src/app.js", content: app })];
        }
        if (step === 3) return [tool("cmd_run", { command: "npm test", purpose: "test" })];
        return [text("Added GET /api/rates using the FX provider; it needs FX_API_KEY.")];
      }
      // V14 maintenance: approved refactor of duplicated cents conversion — behaviour preserved, tests unchanged.
      if (task?.startsWith("M1.")) {
        if (step === 1) return [tool("fs_read", { path: "src/routes/expenses.js" })];
        if (step === 2) {
          const src = (JSON.parse(u) as { content: string }).content;
          return [tool("fs_write", { path: "src/money.js", content: MONEY }), tool("fs_write", { path: "src/routes/expenses.js", content: src.replace('const store = require("../store");', 'const store = require("../store");\nconst { toCents } = require("../money");').replace("Math.round(Number(b.amount) * 100)", "toCents(b.amount)") })];
        }
        if (step === 3) return [tool("cmd_run", { command: "npm test", purpose: "test" })];
        return [text("Moved cents conversion into src/money.js; behaviour unchanged, all tests pass.")];
      }
      if (task === "C1.T1") {
        if (step === 1) return [tool("fs_read", { path: "src/routes/expenses.js" })];
        if (step === 2) {
          const src = (JSON.parse(u) as { content: string }).content;
          if (!src.includes("summary")) throw new Error("change started from a base without the verified API");
          return [tool("fs_read", { path: "public/app.js" }), tool("fs_write", { path: "src/routes/expenses.js", content: src.replace("module.exports.routes = [", 'function remove(req, res, ctx) { return store.remove("expenses", ctx.params.id) ? (res.writeHead(204), res.end()) : json(res, 404, { error: "expense not found" }); }\nmodule.exports.routes = [\n  { method: "DELETE", pattern: /^\\/api\\/expenses\\/(?<id>[\\w-]+)$/, handler: remove },') }), tool("fs_write", { path: "src/routes/expenses-delete.test.js", content: DELETE_TEST })];
        }
        if (step === 3) {
          return [tool("fs_write", { path: "public/app.js", content: JS(true).replace('li.appendChild(b); $("list").appendChild(li);', 'li.appendChild(b); const d = document.createElement("button"); d.type = "button"; d.textContent = "Delete"; d.setAttribute("data-action", "delete"); d.setAttribute("aria-label", "Delete " + e.description); d.onclick = async () => { await api("/api/expenses/" + e.id, { method: "DELETE" }).catch(() => null); await load(); }; li.appendChild(d); $("list").appendChild(li);').replace('async function api(path, opts) { const r = await fetch(path, opts); const b = await r.json().catch(() => ({}));', 'async function api(path, opts) { const r = await fetch(path, opts); const b = r.status === 204 ? {} : await r.json().catch(() => ({}));') })];
        }
        if (step === 4) return [tool("cmd_run", { command: "npm test", purpose: "test" })];
        return [text("Added DELETE /api/expenses/:id and a Delete button per row; existing tests still pass.")];
      }
    }
    // Reviewers (QA / security / code review): judge from the evidence AURA shows them.
    if (/You are Sentinel/.test(req.system)) stats.securityCalls++;
    if (/You are Rhea/.test(req.system)) stats.reviewerCalls++;
    const passed = /^[#ℹ] fail 0$/m.test(u);
    const browserFailed = /Browser verification \(real Chromium; observations\)\nStatus: failed/.test(u);
    const block = u.split("# Acceptance criteria\n")[1]?.split("\n\n# ")[0] ?? "";
    const crits = [...block.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]).slice(0, 20);
    const ok = passed && !browserFailed;
    return [text(JSON.stringify({ verdict: ok ? "approve" : "request_changes", criteria: crits.map((t) => ({ text: t, status: ok ? "met" : "not_met", evidence: ok ? "the engine's npm test run passed (fail 0) and browser verification passed" : browserFailed ? "browser verification failed" : "test run failed" })), findings: [], confidence: "medium", notVerified: [] }))];
  };
  return { respond, stats };
}
