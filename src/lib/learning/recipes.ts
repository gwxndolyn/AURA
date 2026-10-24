/**
 * Engineering recipes: structured, versioned approaches with honest
 * validation status.
 *
 *   scope "platform"  authored by AURA (no customer content); start UNVALIDATED
 *   scope <companyId> discovered inside one workspace from its own verified
 *                     runs; never shown to another workspace
 *
 * Validation is computed from RecipeApplication outcomes: a recipe is
 * VALIDATED only after ≥ MIN_VALIDATED verified applications on ≥ 2 distinct
 * products with a success rate ≥ 0.6 (a single success never validates).
 * Infrastructure-failed / cancelled runs are EXCLUDED from the denominator,
 * not counted as successes. Applicability is checked (stack, task kind,
 * keywords, failure categories) before a recipe is offered.
 */
import { prisma } from "@/lib/db";

export const MIN_VALIDATED = 3;

export interface RecipeDef {
  key: string;
  title: string;
  category: string;
  appliesTo: { stacks?: string[]; kinds?: string[]; keywords?: string[]; failureCategories?: string[] };
  preconditions: string[];
  investigation: string[];
  approach: string;
  failureModes: string[];
  verification: string[];
  limitations: string[];
}

/** Initial guidance, explicitly UNVALIDATED until outcomes accumulate. */
export const PLATFORM_RECIPES: RecipeDef[] = [
  { key: "feature-in-unfamiliar-codebase", title: "Add a feature to an unfamiliar codebase safely", category: "feature", appliesTo: { kinds: ["BACKEND", "FRONTEND", "DATA"] }, preconditions: ["The project has a runnable test command"], investigation: ["List the tree and read the entry point and router", "Find the closest existing feature and copy its structure", "Run the existing tests before changing anything"], approach: "Extend the closest existing pattern (same folder, same helpers); add the feature behind the existing router; write tests next to the code that exercise the public interface.", failureModes: ["Importing a helper that does not exist", "Re-implementing an existing helper", "Changing shared files beyond the task"], verification: ["Full test suite passes", "New tests fail without the change"], limitations: ["Assumes conventional project layout"] },
  { key: "api-endpoint-validated", title: "Add an API endpoint with validation, errors and tests", category: "api", appliesTo: { kinds: ["BACKEND", "DATA"], keywords: ["api", "endpoint", "route", "post", "get", "put", "delete"] }, preconditions: ["An HTTP router exists"], investigation: ["Read the router and one existing route", "Read the store/persistence helper"], approach: "Validate every input field server-side (400 + JSON error), use the existing store, return 201/200 with the stored row, 404 for unknown ids; test success, invalid input and not-found against the real server on an ephemeral port.", failureModes: ["Only testing the happy path", "Returning stack traces", "Forgetting to register the route"], verification: ["Tests for 2xx, 4xx and 404 pass"], limitations: [] },
  { key: "form-with-validation-states", title: "Frontend form with validation, error states and refresh after save", category: "frontend", appliesTo: { kinds: ["FRONTEND"], keywords: ["form", "create", "edit", "submit", "input", "add"] }, preconditions: ["The API contract for the form exists"], investigation: ["Read the API route and its validation", "Read the existing page and stylesheet"], approach: "Label every field; disable the submit button while saving; show server error text in a role=alert element; after a successful save re-fetch the list and totals from the API (never only append locally); keep layout fluid down to 360px.", failureModes: ["List not refreshed after save", "Unlabelled inputs", "Fixed-width elements overflowing on mobile"], verification: ["Browser journey create → reload passes at desktop and mobile", "No unlabelled controls"], limitations: ["Plain DOM/fetch stacks; adapt for frameworks"] },
  { key: "debug-failing-integration-test", title: "Debug a failing integration test", category: "debugging", appliesTo: { failureCategories: ["code", "test_assumption", "timeout"] }, preconditions: ["A failing test with output"], investigation: ["Read the failing assertion and the code path it exercises", "Check whether the test starts/stops the server correctly"], approach: "Reproduce from the exact output; form at most two hypotheses; change the code under test minimally; re-run the focused test, then the full suite.", failureModes: ["Changing the test to match wrong behaviour", "Raising timeouts to hide a hang"], verification: ["The failing test passes", "No other test changes status"], limitations: [] },
  { key: "fix-regression-adjacent", title: "Fix a regression without breaking adjacent functionality", category: "regression", appliesTo: { keywords: ["regression", "broke", "broken", "still works", "preserve"] }, preconditions: ["Pre-existing tests"], investigation: ["Run the full suite first and record which tests fail", "Read the impact analysis dependents"], approach: "Restore the original contract, then add the new behaviour behind it; never delete or weaken an existing test.", failureModes: ["Fixing one route and breaking its dependents"], verification: ["All previously passing tests still pass"], limitations: [] },
  { key: "refactor-preserve-contract", title: "Refactor a module while preserving its public contract", category: "refactor", appliesTo: { keywords: ["refactor", "restructure", "clean up", "extract"] }, preconditions: ["Tests cover the public interface"], investigation: ["List every importer of the module"], approach: "Keep exported names and signatures; move internals; run the full suite after each step.", failureModes: ["Renaming an export used elsewhere"], verification: ["Same exports; all tests pass"], limitations: [] },
  { key: "accessible-responsive-ui", title: "Accessible responsive interface", category: "frontend", appliesTo: { kinds: ["FRONTEND"], keywords: ["responsive", "mobile", "layout", "accessible", "page", "ui", "dashboard"] }, preconditions: [], investigation: ["Read the design handoff and existing CSS variables"], approach: "Use CSS custom properties for tokens; single-column layout by default with a min-width media query for wider screens; max-width:100% on media and inputs; every control has an accessible name; visible focus styles.", failureModes: ["Horizontal overflow at 390px", "Icon-only buttons without labels"], verification: ["Browser verification passes at 1280 and 390 wide"], limitations: [] },
];

export async function ensurePlatformRecipes() {
  for (const r of PLATFORM_RECIPES) {
    const exists = await prisma.engineeringRecipe.findFirst({ where: { scope: "platform", key: r.key }, select: { id: true } });
    if (exists) continue;
    await prisma.engineeringRecipe.create({ data: { scope: "platform", key: r.key, version: 1, title: r.title, category: r.category, appliesTo: JSON.stringify(r.appliesTo), preconditions: JSON.stringify(r.preconditions), investigation: JSON.stringify(r.investigation), approach: r.approach, failureModes: JSON.stringify(r.failureModes), verification: JSON.stringify(r.verification), limitations: JSON.stringify(r.limitations), status: "UNVALIDATED", source: "authored" } }).catch((e) => {
      if ((e as { code?: string }).code !== "P2002") throw e;
    });
  }
}

type Recipe = NonNullable<Awaited<ReturnType<typeof prisma.engineeringRecipe.findFirst>>>;

export function applicability(r: Pick<Recipe, "appliesTo" | "status">, task: { stack: string; kind: string; text: string; failureCategories?: string[] }) {
  const a = JSON.parse(r.appliesTo || "{}") as RecipeDef["appliesTo"];
  if (r.status === "DEPRECATED") return { ok: false, reason: "deprecated" };
  if (a.stacks?.length && !a.stacks.includes(task.stack)) return { ok: false, reason: `stack ${task.stack} not in ${a.stacks.join(", ")}` };
  if (a.kinds?.length && !a.kinds.includes(task.kind)) return { ok: false, reason: `task kind ${task.kind} not in ${a.kinds.join(", ")}` };
  const text = task.text.toLowerCase();
  const kw = (a.keywords ?? []).filter((k) => new RegExp(`\\b${k}\\b`).test(text));
  const fc = (a.failureCategories ?? []).filter((c) => task.failureCategories?.includes(c));
  if (a.failureCategories?.length && !fc.length && !(a.keywords?.length && kw.length)) return { ok: false, reason: "applies to failures of another category" };
  if (a.keywords?.length && !kw.length && !fc.length && !a.kinds?.length) return { ok: false, reason: "no matching keywords" };
  const score = (a.kinds?.length ? 1 : 0) + kw.length * 0.5 + fc.length * 2 + (r.status === "VALIDATED" ? 1 : 0);
  return { ok: true, reason: [a.kinds?.length ? `kind ${task.kind}` : "", kw.length ? `keywords ${kw.join(", ")}` : "", fc.length ? `failure ${fc.join(", ")}` : ""].filter(Boolean).join("; ") || "general", score };
}

/** Applicable recipes for a task: platform + this workspace's own; never another workspace's. */
export async function recipesFor(companyId: string, task: { stack: string; kind: string; text: string; failureCategories?: string[] }, limit = 2) {
  await ensurePlatformRecipes();
  const rows = await prisma.engineeringRecipe.findMany({ where: { scope: { in: ["platform", companyId] }, status: { in: ["UNVALIDATED", "VALIDATED"] } } });
  // Latest version per (scope, key).
  const latest = new Map<string, Recipe>();
  for (const r of rows) { const k = `${r.scope}:${r.key}`; if (!latest.has(k) || latest.get(k)!.version < r.version) latest.set(k, r); }
  return [...latest.values()].map((r) => ({ r, a: applicability(r, task) })).filter((x) => x.a.ok).sort((x, y) => (y.a.score ?? 0) - (x.a.score ?? 0)).slice(0, limit);
}

export function renderRecipe(r: Recipe, stats: { verified: number; total: number }) {
  const list = (s: string) => (JSON.parse(s || "[]") as string[]).map((x) => `  - ${x}`).join("\n");
  return `## Recipe: ${r.title} (v${r.version}, ${r.status.toLowerCase()}${stats.total ? `; ${stats.verified}/${stats.total} applications verified` : "; no recorded applications yet"})\nApproach: ${r.approach}\nInvestigate first:\n${list(r.investigation)}\nKnown failure modes:\n${list(r.failureModes)}\nVerify:\n${list(r.verification)}${r.status !== "VALIDATED" ? "\n(Unvalidated guidance — follow the repository's actual conventions where they differ.)" : ""}`;
}

/** Outcome stats for a recipe (optionally within one workspace). EXCLUDED applications are not in the denominator. */
export async function recipeStats(recipeId: string, companyId?: string) {
  const apps = await prisma.recipeApplication.findMany({ where: { recipeId, ...(companyId ? { companyId } : {}), outcome: { in: ["VERIFIED", "FAILED"] } }, select: { outcome: true, productId: true } });
  return { verified: apps.filter((a) => a.outcome === "VERIFIED").length, total: apps.length, products: new Set(apps.filter((a) => a.outcome === "VERIFIED").map((a) => a.productId)).size };
}

/** Recompute a recipe's validation status from its recorded applications. */
export async function revalidate(recipeId: string) {
  const r = await prisma.engineeringRecipe.findUnique({ where: { id: recipeId } });
  if (!r || r.status === "DEPRECATED") return r;
  const s = await recipeStats(recipeId);
  const rate = s.total ? s.verified / s.total : 0;
  const status = s.verified >= MIN_VALIDATED && s.products >= 2 && rate >= 0.6 ? "VALIDATED" : r.source === "discovered" ? "PROPOSED" : "UNVALIDATED";
  const evidence = JSON.stringify([{ kind: "applications", ref: recipeId, detail: `${s.verified}/${s.total} verified across ${s.products} product(s)` }]);
  if (status !== r.status || evidence !== r.evidence) return prisma.engineeringRecipe.update({ where: { id: r.id }, data: { status, evidence } });
  return r;
}
