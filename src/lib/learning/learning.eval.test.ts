/**
 * Learning-system evaluation suite (LEARNING_SUITE_VERSION). Synthetic,
 * labelled fixtures only — no customer data. Runs the REAL learning modules
 * against the real database. Writes a baseline report with explicit
 * numerators/denominators to $TMPDIR/aura-learning-eval.json.
 *
 * Scenarios (V11 §12):
 *  1 retrieve the correct project decision     7 learn from a failed repair (no blind repeat)
 *  2 avoid irrelevant memory                   8 tenant + project isolation
 *  3 recognise stale guidance                  9 feedback reaches the next relevant task only
 *  4 reuse an applicable recipe (and not others)10 reject optimization regressing another category
 *  5 attribute failures from output + diffs    11 roll back an inferior prompt version
 *  6 refuse a root cause without evidence      12 recover evaluation/learning state after a restart
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { remember, markStale } from "@/lib/factory/memory";
import { attribute, ATTRIBUTION_RULES_VERSION, type AttributionInput } from "./attribution";
import { learningContext } from "./retrieval";
import { recipesFor, ensurePlatformRecipes, revalidate } from "./recipes";
import { classifyFeedback, recordFeedback } from "./feedback";
import { emit, processPending, collectOutcome, agentPerformance } from "./service";
import { problems, proposePromptFix } from "./optimize";
import { categoryRegressions, decide } from "@/lib/lab/lab";
import type { Scorecard } from "@/lib/lab/scorecard";
import { rollbackVersion } from "@/lib/intelligence/experiments";
import { agentPromptKey, getActiveVersion } from "@/lib/intelligence/registry";

export const LEARNING_SUITE_VERSION = "learning-2026.10.24-1";
const stamp = Date.now();
const results: { id: string; scenario: string; passed: boolean; measures?: Record<string, number> }[] = [];
const rec = (id: string, scenario: string, passed: boolean, measures?: Record<string, number>) => { results.push({ id, scenario, passed, measures }); return passed; };
let wsA = "", wsB = "", owner = "", pA = "", pA2 = "", pB = "";

async function product(ws: string, title: string) {
  return (await prisma.product.create({ data: { companyId: ws, title, idea: title, createdById: owner, stack: "node-web" } })).id;
}
async function build(ws: string, productId: string, itemKey: string, data: Record<string, unknown> = {}) {
  return prisma.build.create({ data: { companyId: ws, productId, itemKey, branch: `aura/${itemKey.toLowerCase()}`, correlationId: "eval", createdBy: "eval", ...data } });
}
const base = (over: Partial<AttributionInput> = {}): AttributionInput => ({ attempt: 0, ownerAgent: "backend-engineer", defects: [], findings: [], unmet: [], changed: ["src/a.js"], plannedFiles: ["src/a.js"], impactFlags: [], knownFiles: ["src/a.js", "src/app.js"], previous: [], ...over });

beforeAll(async () => {
  const u = await prisma.user.create({ data: { email: `learn_${stamp}@eval.local`, name: "eval" } });
  owner = u.id;
  wsA = (await createCompany({ name: `LEARN-A-${stamp}`, mission: "m", industry: "SaaS", ownerId: owner })).id;
  wsB = (await createCompany({ name: `LEARN-B-${stamp}`, mission: "m", industry: "SaaS", ownerId: owner })).id;
  pA = await product(wsA, "Ledger");
  pA2 = await product(wsA, "Recipes app");
  pB = await product(wsB, "Other tenant app");
  await ensurePlatformRecipes();
}, 60_000);

afterAll(async () => {
  const passed = results.filter((r) => r.passed).length;
  writeFileSync(join(tmpdir(), "aura-learning-eval.json"), JSON.stringify({ suite: LEARNING_SUITE_VERSION, attributionRules: ATTRIBUTION_RULES_VERSION, ranAt: new Date().toISOString(), passed, total: results.length, results }, null, 2));
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: owner } });
});

describe(`learning evaluation suite ${LEARNING_SUITE_VERSION}`, () => {
  it("1+2: retrieves the project decision for the task, not unrelated memory (precision measured)", async () => {
    await remember({ companyId: wsA, productId: pA, key: "decision:cents", kind: "approved_decision", content: "Amounts are stored as integer cents in src/routes/expenses.js", status: "VERIFIED", files: ["src/routes/expenses.js"], provenance: { type: "approval", ref: "owner", detail: "brief review" } });
    await remember({ companyId: wsA, productId: pA, key: "unrelated:email", kind: "pattern", content: "Newsletter emails are rendered with mjml templates", status: "VERIFIED", files: ["src/mail/newsletter.js"], provenance: { type: "build", ref: "b0", detail: "x" } });
    await remember({ companyId: wsA, productId: pA, key: "unrelated:theme", kind: "pattern", content: "Dark theme palette lives in public/theme.css", status: "VERIFIED", files: ["public/theme.css"], provenance: { type: "build", ref: "b0", detail: "x" } });
    const ctx = await learningContext({ companyId: wsA, productId: pA, buildId: "x", itemKey: "E1.S1.T1", kind: "BACKEND", stack: "node-web", title: "Monthly totals", description: "Add a monthly summary endpoint to expenses", acceptance: ["Totals in cents"], files: ["src/routes/expenses.js"], requirements: [], signatures: [], currentFiles: ["src/routes/expenses.js", "src/mail/newsletter.js", "public/theme.css"], failureCategories: [] });
    const mem = ctx.manifest.filter((m) => m.source === "memory");
    const relevant = mem.filter((m) => m.label === "decision:cents").length;
    const precision = mem.length ? relevant / mem.length : 0;
    expect(ctx.text).toContain("integer cents");
    expect(ctx.text).not.toContain("mjml");
    expect(rec("retrieve-decision", "1", relevant === 1)).toBe(true);
    expect(rec("avoid-irrelevant", "2", precision === 1, { precision, retrieved: mem.length })).toBe(true);
  });

  it("3: stale guidance (file changed, or file deleted) is not retrieved", async () => {
    await remember({ companyId: wsA, productId: pA, key: "api:old-filter", kind: "api_contract", content: "Filtering is done in src/routes/filter-old.js", status: "VERIFIED", files: ["src/routes/filter-old.js"], provenance: { type: "build", ref: "b1", detail: "x" } });
    await remember({ companyId: wsA, productId: pA, key: "api:list", kind: "api_contract", content: "GET /api/expenses lists rows newest first in src/routes/expenses.js", status: "VERIFIED", files: ["src/routes/expenses.js"], provenance: { type: "build", ref: "b1", detail: "x" } });
    await markStale(wsA, pA, { files: ["src/routes/expenses.js"], reason: "expenses.js changed in E1.S1.T2", exceptKeys: ["decision:cents"] });
    const ctx = await learningContext({ companyId: wsA, productId: pA, buildId: "x", itemKey: "E1.S1.T3", kind: "BACKEND", stack: "node-web", title: "Filter by category", description: "filter expenses list", acceptance: [], files: ["src/routes/expenses.js", "src/routes/filter-old.js"], requirements: [], signatures: [], currentFiles: ["src/routes/expenses.js"], failureCategories: [] });
    const labels = ctx.manifest.map((m) => m.label);
    expect(rec("stale-guidance", "3", !labels.includes("api:list") && !labels.includes("api:old-filter"))).toBe(true);
  });

  it("4: an applicable recipe is offered; an inapplicable one is not; validation needs several products", async () => {
    const fe = await recipesFor(wsA, { stack: "node-web", kind: "FRONTEND", text: "Add a form to create an expense with validation", failureCategories: [] });
    const be = await recipesFor(wsA, { stack: "node-web", kind: "BACKEND", text: "Add a POST endpoint", failureCategories: [] });
    const feKeys = fe.map((x) => x.r.key), beKeys = be.map((x) => x.r.key);
    const ok = feKeys.includes("form-with-validation-states") && !beKeys.includes("form-with-validation-states") && beKeys.includes("api-endpoint-validated");
    // Validation: 3 verified uses on ONE product does not validate; adding a second product does.
    const recipe = fe.find((x) => x.r.key === "form-with-validation-states")!.r;
    for (let i = 0; i < 3; i++) { const b = await build(wsA, pA, `R${i}`); await prisma.recipeApplication.create({ data: { recipeId: recipe.id, companyId: wsA, productId: pA, buildId: b.id, itemKey: `R${i}`, outcome: "VERIFIED" } }); }
    const infra = await build(wsA, pA, "RX");
    await prisma.recipeApplication.create({ data: { recipeId: recipe.id, companyId: wsA, productId: pA, buildId: infra.id, itemKey: "RX", outcome: "EXCLUDED" } });
    const one = await revalidate(recipe.id);
    const b2 = await build(wsA, pA2, "R9");
    await prisma.recipeApplication.create({ data: { recipeId: recipe.id, companyId: wsA, productId: pA2, buildId: b2.id, itemKey: "R9", outcome: "VERIFIED" } });
    const two = await revalidate(recipe.id);
    expect(rec("recipe-applicability", "4", ok)).toBe(true);
    expect(rec("recipe-validation-honest", "4", one!.status === "UNVALIDATED" && two!.status === "VALIDATED")).toBe(true);
    await prisma.recipeApplication.deleteMany({ where: { recipeId: recipe.id } });
    await prisma.engineeringRecipe.update({ where: { id: recipe.id }, data: { status: "UNVALIDATED", evidence: "[]" } });
  });

  it("5: attribution accuracy on labelled cases (root cause vs symptom, agent vs infrastructure)", () => {
    const cases: { name: string; input: AttributionInput; expect: string; scope: string }[] = [
      { name: "missing module", input: base({ defects: [{ signature: "s1", category: "configuration", title: "test failed: Error: Cannot find module '../lib/money'", occurrences: 1, files: [], failingTests: [], commandRunId: "c1", diagnosis: "Likely cause: configuration — Cannot find module '../lib/money'" }] }), expect: "repository_assumption", scope: "agent" },
      { name: "assertion in changed file", input: base({ defects: [{ signature: "s2", category: "code", title: "1 failing test(s): totals", occurrences: 1, files: ["src/a.js"], failingTests: ["totals"], commandRunId: "c2", diagnosis: "Likely cause: code" }] }), expect: "code_generation", scope: "agent" },
      { name: "sandbox down", input: base({ error: { kind: "sandbox_unavailable", message: "Docker sandbox unavailable" } }), expect: "environment", scope: "environment" },
      { name: "provider outage", input: base({ error: { kind: "provider_error", message: "529 overloaded" } }), expect: "provider_failure", scope: "external" },
      { name: "browser persistence", input: base({ findings: [{ source: "browser", severity: "high", title: "browser journey failed (/ @ desktop)", detail: "create → reload → persists: the API stored the record but the page did not show it until a manual reload (the list/totals are not refreshed after saving)", evidence: "chromium", blocking: true }] }), expect: "architecture_contract", scope: "agent" },
      { name: "tautological tests", input: base({ findings: [{ source: "verification", severity: "high", title: "gate v3: tautological assertions", detail: "assert.ok(true)", evidence: "gate", blocking: true }] }), expect: "inadequate_tests", scope: "agent" },
      { name: "security finding", input: base({ findings: [{ source: "security", severity: "high", title: "Missing ownership check", detail: "any user can read", evidence: "src/a.js:12 findFirst({where:{id}})", blocking: true }] }), expect: "security_defect", scope: "agent" },
      { name: "recurring defect after repair", input: base({ attempt: 1, previous: [{ attempt: 0, categories: ["code_generation"] }], defects: [{ signature: "s3", category: "code", title: "1 failing test(s): totals", occurrences: 2, files: ["src/a.js"], failingTests: ["totals"], commandRunId: "c3", diagnosis: "code" }] }), expect: "code_generation", scope: "agent" },
    ];
    let correct = 0;
    for (const c of cases) {
      const a = attribute(c.input)[0];
      if (a.category === c.expect && a.scope === c.scope) correct++;
      else console.log("MISATTRIBUTED", c.name, a.category, a.scope);
    }
    // Infrastructure is never blamed on the agent.
    const infraBlamed = cases.filter((c) => c.scope !== "agent").some((c) => attribute(c.input).some((a) => a.scope === "agent"));
    const recurring = attribute(cases[7].input)[0];
    expect(rec("attribution-accuracy", "5", correct === cases.length && !infraBlamed, { correct, total: cases.length })).toBe(true);
    expect(recurring.rootCause).toMatch(/survived a repair/);
  });

  it("6: no root cause is asserted without evidence", () => {
    const a = attribute(base({ changed: ["src/a.js"], findings: [{ source: "review", severity: "low", title: "naming", detail: "x", evidence: "", blocking: false }] }));
    expect(rec("no-evidence-unknown", "6", a.length === 1 && a[0].status === "UNKNOWN" && a[0].category === "unknown")).toBe(true);
  });

  it("7: a failed repair becomes negative knowledge and is shown to the next attempt", async () => {
    const b = await build(wsA, pA, "E2.S1.T1", { status: "RUNNING", attempt: 0 });
    await prisma.defect.create({ data: { companyId: wsA, productId: pA, itemKey: "E2.S1.T1", buildId: b.id, signature: "sigT", category: "code", title: "1 failing test(s): monthly total", command: "npm test", commandRunId: "cr1", failingTests: JSON.stringify(["monthly total"]), files: JSON.stringify(["src/a.js"]), diagnosis: "code", firstAttempt: 0, lastAttempt: 0 } });
    await emit({ companyId: wsA, type: "attempt.completed", key: `attempt:${b.id}:0`, productId: pA, buildId: b.id, itemKey: "E2.S1.T1", payload: { attempt: 0, passed: false, changed: ["src/a.js"], plannedFiles: ["src/a.js"], findings: [], unmet: [], impactFlags: [], knownFiles: ["src/a.js"], ownerAgent: "backend-engineer" } });
    await prisma.build.update({ where: { id: b.id }, data: { status: "FAILED", attempt: 1, finishedAt: new Date() } });
    await emit({ companyId: wsA, type: "build.finished", key: `finished:${b.id}:FAILED`, productId: pA, buildId: b.id, itemKey: "E2.S1.T1" });
    await processPending(50, [wsA]);
    const ctx = await learningContext({ companyId: wsA, productId: pA, buildId: "next", itemKey: "E2.S1.T1", kind: "BACKEND", stack: "node-web", title: "Monthly total", description: "fix totals", acceptance: [], files: ["src/a.js"], requirements: [], signatures: [], currentFiles: ["src/a.js"], failureCategories: [] });
    const attr = await prisma.failureAttribution.findFirst({ where: { buildId: b.id } });
    expect(attr?.verification).toBe("FAILED"); // its fix did not work (the run failed)
    expect(rec("failed-repair-negative-knowledge", "7", /WHAT FAILED BEFORE/.test(ctx.text) && ctx.manifest.some((m) => m.source === "negative" || m.source === "attribution"))).toBe(true);
  });

  it("8: tenant and project isolation — another workspace's memory, feedback and recipes never appear", async () => {
    await remember({ companyId: wsB, productId: pB, key: "secret:recipe", kind: "pattern", content: "TENANT-B-PROPRIETARY pricing formula in src/routes/expenses.js", status: "VERIFIED", files: ["src/routes/expenses.js"], provenance: { type: "build", ref: "b", detail: "x" } });
    await recordFeedback({ companyId: wsB, userId: owner, actor: "b", text: "Always make it purple TENANT-B", productId: pB });
    await prisma.engineeringRecipe.create({ data: { scope: wsB, key: "tenant-b-recipe", title: "TENANT-B recipe", category: "api", appliesTo: JSON.stringify({ kinds: ["BACKEND"] }), approach: "TENANT-B-ONLY", status: "VALIDATED", source: "discovered" } });
    const ctx = await learningContext({ companyId: wsA, productId: pA, buildId: "x", itemKey: "E1.S1.T1", kind: "BACKEND", stack: "node-web", title: "expenses api", description: "pricing formula expenses", acceptance: [], files: ["src/routes/expenses.js"], requirements: [], signatures: [], currentFiles: ["src/routes/expenses.js"], failureCategories: [] });
    const other = await learningContext({ companyId: wsA, productId: pA2, buildId: "x", itemKey: "E1", kind: "BACKEND", stack: "node-web", title: "integer cents", description: "", acceptance: [], files: ["src/routes/expenses.js"], requirements: [], signatures: [], currentFiles: ["src/routes/expenses.js"], failureCategories: [] });
    expect(rec("tenant-isolation", "8", !/TENANT-B/.test(ctx.text) && !/TENANT-B/.test(JSON.stringify(ctx.manifest)))).toBe(true);
    expect(rec("project-isolation", "8", !/integer cents/.test(other.text))).toBe(true); // pA's decision is not in pA2's context
  });

  it("9: explicit feedback changes the next task of that product only, as concrete criteria and checks", async () => {
    const c = classifyFeedback("The interface looks good, but the mobile layout is broken");
    expect(c.kind).toBe("responsive");
    await recordFeedback({ companyId: wsA, userId: owner, actor: "a", text: "The interface looks good, but the mobile layout is broken", productId: pA });
    await recordFeedback({ companyId: wsA, userId: owner, actor: "a", text: "You changed unrelated files", productId: pA });
    const same = await learningContext({ companyId: wsA, productId: pA, buildId: "x", itemKey: "E3", kind: "FRONTEND", stack: "node-web", title: "Page", description: "", acceptance: [], files: ["public/index.html"], requirements: [], signatures: [], currentFiles: [], failureCategories: [] });
    const other = await learningContext({ companyId: wsA, productId: pA2, buildId: "x", itemKey: "E3", kind: "FRONTEND", stack: "node-web", title: "Page", description: "", acceptance: [], files: ["public/index.html"], requirements: [], signatures: [], currentFiles: [], failureCategories: [] });
    const ok = same.criteria.some((x) => /390px/.test(x)) && same.browserRequired && same.scopeStrict && !other.criteria.length && !other.scopeStrict;
    const fb = await prisma.userFeedback.findMany({ where: { companyId: wsA, productId: pA } });
    expect(fb.every((f) => f.appliedCount >= 1)).toBe(true);
    expect(rec("feedback-applied-scoped", "9", ok)).toBe(true);
  });

  it("10: an optimization that improves one category but regresses another is rejected", () => {
    const card = (cats: Record<string, [number, number]>): Scorecard => ({ split: "all", dimensions: { functional: { casesPassed: { value: 0.8, numerator: 8, denominator: 10, formula: "" } } }, criticalFailures: [], notMeasured: [], byCategory: Object.fromEntries(Object.entries(cats).map(([k, [n, d]]) => [k, { value: n / d, numerator: n, denominator: d, formula: "" }])) });
    const baseC = card({ fix_defect: [2, 4], security: [4, 4] });
    const candC = card({ fix_defect: [4, 4], security: [3, 4] });
    const d = decide({ success: [{ metric: "functional.casesPassed", op: ">=", value: 0.5, split: "all" }], regression: [], base: { all: baseC, train: baseC, heldout: baseC }, cand: { all: candC, train: candC, heldout: candC }, securityRelevant: false });
    expect(categoryRegressions(baseC, candC)).toEqual(["security 4/4 → 3/4"]);
    expect(rec("reject-category-regression", "10", d.outcome === "REJECTED")).toBe(true);
  });

  it("11: an inferior prompt version can be rolled back immediately (previous version retained)", async () => {
    // Problems come only from agent-scoped, established attributions across ≥2 runs.
    for (const k of ["P1", "P2"]) {
      const b = await build(wsA, pA, k);
      await prisma.failureAttribution.create({ data: { companyId: wsA, productId: pA, buildId: b.id, itemKey: k, attempt: 0, category: "repository_assumption", scope: "agent", agentKey: "backend-engineer", rootCause: "imported a missing module", confidence: "high", status: "ESTABLISHED", rulesVersion: ATTRIBUTION_RULES_VERSION } });
    }
    const envOnly = await build(wsA, pA, "P3");
    await prisma.failureAttribution.create({ data: { companyId: wsA, productId: pA, buildId: envOnly.id, itemKey: "P3", attempt: 0, category: "environment", scope: "environment", rootCause: "docker down", confidence: "high", status: "ESTABLISHED", rulesVersion: ATTRIBUTION_RULES_VERSION } });
    const ps = await problems(wsA);
    expect(ps.map((p) => p.category)).toEqual(["repository_assumption"]); // environment never becomes a prompt problem
    const cand = await proposePromptFix(wsA, "backend-engineer", "repository_assumption", "eval");
    expect(cand.status).toBe("DRAFT"); // never active without evaluation
    const key = agentPromptKey("backend-engineer");
    const v1 = (await getActiveVersion(wsA, key))!;
    // Simulate a bad promotion having happened, then roll back.
    await prisma.$transaction([prisma.promptVersion.update({ where: { id: v1.id }, data: { status: "APPROVED" } }), prisma.promptVersion.update({ where: { id: cand.id }, data: { status: "ACTIVE", activatedAt: new Date() } })]);
    const rb = await rollbackVersion({ companyId: wsA, templateKey: key, targetVersionId: v1.id, actor: "eval", reason: "candidate regressed in production outcomes" });
    const ok = rb.activeVersionId === v1.id && (await getActiveVersion(wsA, key))!.id === v1.id && (await prisma.promptVersion.findUnique({ where: { id: cand.id } }))!.status === "ROLLED_BACK";
    expect(rec("prompt-rollback", "11", ok)).toBe(true);
    expect(await prisma.learningEvent.count({ where: { companyId: wsA, type: "prompt.rolled_back" } })).toBe(1);
  });

  it("12: learning state survives a restart; duplicate events are no-ops; metrics keep denominators", async () => {
    const b = await build(wsA, pA, "E9", { status: "VERIFIED", attempt: 0, finishedAt: new Date(), startedAt: new Date(Date.now() - 1000), criteria: JSON.stringify([{ status: "met" }, { status: "met" }]), orchestration: JSON.stringify({ attempts: [{ passed: true }] }) });
    const infra = await build(wsA, pA, "E10", { status: "BLOCKED", failure: "The execution sandbox (Docker) is not available", finishedAt: new Date() });
    expect(await emit({ companyId: wsA, type: "build.finished", key: `finished:${b.id}:VERIFIED`, productId: pA, buildId: b.id })).toBe(true);
    expect(await emit({ companyId: wsA, type: "build.finished", key: `finished:${b.id}:VERIFIED`, productId: pA, buildId: b.id })).toBe(false); // retried emit
    await emit({ companyId: wsA, type: "build.finished", key: `finished:${infra.id}:BLOCKED`, productId: pA, buildId: infra.id });
    // "Crash": an event claimed (attempts=1) but never processed is retried by the next worker.
    const ev = await prisma.learningEvent.findFirstOrThrow({ where: { key: `finished:${b.id}:VERIFIED` } });
    await prisma.learningEvent.update({ where: { id: ev.id }, data: { attempts: 1 } });
    await processPending(50, [wsA]);
    await processPending(50, [wsA]); // re-running is harmless
    await collectOutcome(wsA, b.id); // recomputation is idempotent
    const outcomes = await prisma.runOutcome.findMany({ where: { buildId: { in: [b.id, infra.id] } } });
    const perf = await agentPerformance(wsA);
    const verifiedRow = outcomes.find((o) => o.buildId === b.id)!;
    const infraRow = outcomes.find((o) => o.buildId === infra.id)!;
    const ok = outcomes.length === 2 && verifiedRow.outcome === "VERIFIED" && verifiedRow.firstPassSuccess && verifiedRow.testsRun === 0 && infraRow.outcome === "INFRA_FAILED" && perf.some((p) => p.excluded.reasons.includes("INFRA_FAILED"));
    expect(verifiedRow.testsRun).toBe(0); // no test command executed → none counted as passed
    expect(rec("restart-idempotent-honest-metrics", "12", ok)).toBe(true);
  });

  it("baseline report: every scenario passed", () => {
    const passed = results.filter((r) => r.passed).length;
    expect(passed).toBe(results.length);
    expect(results.length).toBeGreaterThanOrEqual(14);
  });
});
