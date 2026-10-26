/**
 * V17 product experience — closed loop on the real pipeline:
 *   audit job (real Docker + Chromium + axe) → persisted, deduplicated findings
 *   → task in the existing backlog (risk policy) → engineering run through the
 *   normal scheduler + builder (engineer = model test double whose tool calls
 *   REALLY execute; npm test + browser verification run for real) → verified →
 *   automatic re-audit → finding FIXED only because it is no longer observed →
 *   verified outcome in project memory. Then a regression is introduced and
 *   detected against the baseline, and the old finding is REOPENED (same row).
 *
 * Also (no browser needed): rubric unit tests, the unavailable-browser path
 * (static only, journeys not_run, nothing marked fixed), API isolation and
 * permissions, risk policy, bounded attempts.
 *
 * TEST DOUBLE: the model provider only. Browser tests are skipped — not faked —
 * without Docker + Chromium.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }) }));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { createProduct } from "@/lib/factory/store";
import { commitFiles, readAt } from "@/lib/factory/git";
import { tickProduct } from "@/lib/factory/scheduler";
import { drain } from "@/lib/jobs/worker";
import { resetClientForTests } from "@/lib/ai/claude";
import { browserAvailable } from "@/lib/builder/browser";
import * as Experience from "@/app/api/companies/[id]/products/[productId]/experience/route";
import * as FindingRoute from "@/app/api/companies/[id]/products/[productId]/experience/findings/[findingId]/route";
import { requestAudit, persistFindings, createTaskFromFinding, experienceOverview } from "./service";
import { toFinding, mergeFindings, priorityOf, remediationPolicy, scoreAudit, regressionsAgainst, journeysFrom, fingerprint, type Finding } from "./rubric";
import { staticInspect, viewportsFor } from "./inspect";
import { startAnthropicDouble, text, tool, lastUserText, type Double } from "../../../test/doubles/anthropic";
import { appFiles, BRIEF } from "../../../test/fixtures/experience-app";

const users: Record<string, { id: string; email: string }> = {};
let ws = "", other = "", productId = "", double: Double, browser = false;
const roots: string[] = [];
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) as never });
const req = (method = "GET", body?: unknown) => new Request("http://t.local/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: string } });
async function as(n: string | null) { currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null; }
async function until(fn: () => Promise<boolean>, max = 300) { for (let i = 0; i < max && !(await fn()); i++) if (!(await drain(1, [ws]))) await new Promise((r) => setTimeout(r, 150)); }
const auditDone = (id: string) => async () => ["COMPLETED", "FAILED"].includes((await prisma.experienceAudit.findUnique({ where: { id } }))?.status ?? "");

// The scripted engineer: when asked to fix the "success not reflected" UX task it rewrites public/app.js to reload after saving
// (only that bug — the other planted defects stay, so the re-audit must keep them OPEN).
const FIXED_JS = appFiles(false)["public/app.js"].replace('t.value="";});', 't.value="";await load();});');
function engineer() {
  let step = 0;
  return (r: { system: string; messages: { role: string; content: unknown }[] }) => {
    const u = lastUserText(r.messages);
    if (/Product Manager/.test(r.system)) return [text("{}")];
    if (/Frontend Engineer|You are Nova/.test(r.system)) {
      if (r.messages.length === 1) step = 0;
      step++;
      if (step === 1) return [tool("fs_write", { path: "public/app.js", content: FIXED_JS }), tool("fs_write", { path: "src/notes-ui.test.js", content: `const test=require("node:test");const assert=require("node:assert");const fs=require("node:fs");\ntest("the list is reloaded after a successful save",()=>{assert.match(fs.readFileSync(__dirname+"/../public/app.js","utf8"),/t\\.value="";await load\\(\\);/);});\n` })];
      if (step === 2) return [tool("cmd_run", { command: "npm test", purpose: "test" })];
      return [text("The list now reloads after a successful save.")];
    }
    const passed = /^[#ℹ] fail 0$/m.test(u);
    const crits = [...(u.split("# Acceptance criteria\n")[1] ?? "").split("\n\n")[0].matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
    return [text(JSON.stringify({ verdict: passed ? "approve" : "request_changes", criteria: crits.map((t) => ({ text: t, status: passed ? "met" : "not_met", evidence: passed ? "engine test run passed; browser verification attached" : "tests failed" })), findings: [], confidence: "medium" }))];
  };
}

beforeAll(async () => {
  browser = (await browserAvailable()).ok;
  for (const k of ["AURA_GIT_ROOT", "AURA_WORK_ROOT", "AURA_EVIDENCE_ROOT"]) { const d = mkdtempSync(join(tmpdir(), `aura-v17-${k.toLowerCase()}-`)); roots.push(d); process.env[k] = d; }
  double = await startAnthropicDouble(engineer());
  process.env.ANTHROPIC_API_KEY = "test-key-for-double";
  process.env.ANTHROPIC_BASE_URL = double.url;
  resetClientForTests();
  const s = Date.now();
  for (const n of ["owner", "member", "viewer", "outsider"]) users[n] = await prisma.user.create({ data: { email: `v17_${n}_${s}@t.local`, name: n } });
  ws = (await createCompany({ name: "V17", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  other = (await createCompany({ name: "V17-O", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.subscription.create({ data: { companyId: ws, plan: "team", status: "active" } });
  await prisma.workspaceMember.createMany({ data: [{ userId: users.member.id, companyId: ws, role: "MEMBER" }, { userId: users.viewer.id, companyId: ws, role: "VIEWER" }] });
  const r = await createProduct({ companyId: ws, userId: users.owner.id, actor: users.owner.email, idea: "A notes app used to test product experience intelligence end to end." });
  productId = r.product.id;
  await prisma.job.updateMany({ where: { companyId: ws, type: "product.plan" }, data: { status: "CANCELLED" } }); // planning not needed: brief + scope set directly
  await prisma.productBrief.create({ data: { productId, companyId: ws, version: 1, content: JSON.stringify(BRIEF), source: "model", author: "product-manager" } });
  await prisma.product.update({ where: { id: productId }, data: { scopeApproved: true, planningStatus: "READY", phase: "PLANNING", limits: JSON.stringify({ maxRepairs: 1, maxParallel: 1, budgetUsd: 2, maxAttempts: 1, projectBudgetUsd: 50 }) } });
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  await commitFiles({ companyId: ws, repoId: p.repoId!, base: "main", branch: "main", files: appFiles(false), message: "notes app (with planted UX defects)" });
}, 60_000);

afterAll(async () => {
  await double?.close();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  resetClientForTests();
  await prisma.job.deleteMany({ where: { companyId: { in: [ws, other] } } });
  await prisma.company.deleteMany({ where: { id: { in: [ws, other] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("rubric (pure)", () => {
  const f = (o: Partial<Finding> = {}): Finding => ({ ...toFinding({ rule: "control:inert", method: "browser", route: "/", target: 'button "Export"', detail: "x", evidence: [{ kind: "click", ref: "/", detail: "nothing" }] }), ...o });
  it("classifies with severity/confidence, merges viewports, and fingerprints stably", () => {
    expect(f()).toMatchObject({ dimension: "interaction", severity: "high", confidence: "confirmed" });
    const j = toFinding({ rule: "journey:failed", method: "journey", route: "/", journey: "create:/api/notes", critical: true, detail: "x", evidence: [] });
    expect(j.severity).toBe("critical"); // a broken critical journey is always critical
    const m = mergeFindings([toFinding({ rule: "responsive:overflow", method: "browser", route: "/", viewport: "mobile", detail: "a", evidence: [] }), toFinding({ rule: "responsive:overflow", method: "browser", route: "/", viewport: "bp-700", detail: "b", evidence: [] })]);
    expect(m).toHaveLength(1);
    expect(m[0].viewport).toBe("mobile,bp-700");
    expect(fingerprint({ rule: "a", route: "/", target: "#x-1a2b3c4d5e6f", journey: "" })).toBe(fingerprint({ rule: "a", route: "/", target: "#x-ffffffffffff", journey: "" }));
    expect(() => toFinding({ rule: "made:up", method: "static", route: "", detail: "", evidence: [] })).toThrow(/unknown experience rule/);
  });
  it("prioritises transparently and applies the risk policy", () => {
    expect(priorityOf(f()).score).toBeGreaterThan(priorityOf(f({ severity: "low", confidence: "hypothesis" })).score);
    expect(priorityOf(f({ files: ["public/ui.js"] }), { sharedFiles: ["public/ui.js"] }).why.join()).toMatch(/shared component/);
    expect(remediationPolicy(f()).mode).toBe("auto");
    expect(remediationPolicy(f({ confidence: "hypothesis" })).mode).toBe("recommend");
    expect(remediationPolicy(f({ route: "/login", title: "Login form gives no feedback" })).mode).toBe("approval");
    expect(remediationPolicy(f({ rule: "nav:broken_link" })).mode).toBe("approval");
    expect(remediationPolicy(f({ files: ["public/ui.js"] }), { sharedFiles: ["public/ui.js"] }).mode).toBe("approval");
  });
  it("scores from evidence; a broken critical journey is never hidden by other passing checks; no browser = unverified (null metrics)", () => {
    const journeys = [{ status: "failed" as const, critical: true, requirements: ["FR-1"] }, { status: "passed" as const, critical: false, requirements: ["FR-2"] }];
    const s = scoreAudit({ journeys, findings: [], forms: { total: 1, withValidationFeedback: 1, withRecovery: 1 }, browserRan: true, requirementsTotal: 2 });
    expect(s.verdict).toBe("blocked");
    expect(s.metrics.find((m) => m.id === "requirements_e2e")).toMatchObject({ value: 1, of: 2 });
    const u = scoreAudit({ journeys, findings: [], forms: { total: 0, withValidationFeedback: 0, withRecovery: 0 }, browserRan: false, requirementsTotal: 2 });
    expect(u.verdict).toBe("unverified");
    expect(u.metrics.filter((m) => m.source !== "all inspection methods").every((m) => m.value === null)).toBe(true);
    expect(regressionsAgainst([{ fingerprint: "a", severity: "high" }, { fingerprint: "b", severity: "low" }], new Set())).toEqual(["a"]);
    expect(regressionsAgainst([{ fingerprint: "a", severity: "high" }], null)).toEqual([]);
  });
  it("derives journeys from the brief and the real API; uses project breakpoints when declared", () => {
    const js = journeysFrom(BRIEF, { collections: ["/api/notes"], pages: ["/"] });
    expect(js.map((j) => j.id)).toEqual(["load", "create:/api/notes", "validate:/api/notes"]);
    expect(js[1]).toMatchObject({ name: "Add a note", critical: true });
    expect(js[1].requirements).toContain("FR-1");
    expect(viewportsFor({ "a.css": "@media (max-width: 720px) { x{} }" }).map((v) => v.width)).toEqual([390, 719, 1280]);
    expect(viewportsFor({}).map((v) => v.name)).toEqual(["desktop", "mobile"]);
    const st = staticInspect(appFiles(false));
    expect(st.map((o) => o.rule)).toContain("a11y:reduced_motion_ignored");
    expect(st.every((o) => o.method === "static")).toBe(true);
  });
});

describe("persistence: dedupe, fixed only from evidence, reopened on the same row", () => {
  it("static-only audits never mark browser findings fixed", async () => {
    const a1 = await prisma.experienceAudit.create({ data: { companyId: ws, productId, status: "COMPLETED" } });
    const inert = toFinding({ rule: "control:inert", method: "browser", route: "/x", target: "unit-test-button", detail: "x", evidence: [] });
    await persistFindings(ws, productId, a1.id, [inert, inert], { browserRan: true, shared: [] });
    expect(await prisma.experienceFinding.count({ where: { productId, fingerprint: inert.fingerprint } })).toBe(1);
    const a2 = await prisma.experienceAudit.create({ data: { companyId: ws, productId, status: "COMPLETED" } });
    await persistFindings(ws, productId, a2.id, [], { browserRan: false, shared: [] });
    expect((await prisma.experienceFinding.findFirstOrThrow({ where: { productId, fingerprint: inert.fingerprint } })).status).toBe("OPEN");
    const a3 = await prisma.experienceAudit.create({ data: { companyId: ws, productId, status: "COMPLETED" } });
    await persistFindings(ws, productId, a3.id, [], { browserRan: true, shared: [] });
    expect((await prisma.experienceFinding.findFirstOrThrow({ where: { productId, fingerprint: inert.fingerprint } })).status).toBe("FIXED");
    const a4 = await prisma.experienceAudit.create({ data: { companyId: ws, productId, status: "COMPLETED" } });
    await persistFindings(ws, productId, a4.id, [inert], { browserRan: true, shared: [] });
    const back = await prisma.experienceFinding.findFirstOrThrow({ where: { productId, fingerprint: inert.fingerprint } });
    expect(back).toMatchObject({ status: "REOPENED", reopened: 1 });
    await prisma.experienceFinding.delete({ where: { id: back.id } });
    await prisma.experienceAudit.deleteMany({ where: { id: { in: [a1.id, a2.id, a3.id, a4.id] } } });
  });
});

describe("API: permissions, isolation, policy", () => {
  it("viewers read; members start audits; another workspace gets 404; hypotheses are never auto-tasked; dismissing needs an admin", async () => {
    await as("viewer");
    const g = await json(await Experience.GET(req(), ctx({ id: ws, productId })));
    expect(g.status).toBe(200);
    expect(g.body.data.latest).toBeNull(); // honest empty state: nothing audited yet
    expect((await Experience.POST(req("POST"), ctx({ id: ws, productId }))).status).toBe(403);
    await as("outsider");
    expect((await Experience.GET(req(), ctx({ id: ws, productId }))).status).toBe(404);
    expect((await Experience.GET(req(), ctx({ id: other, productId }))).status).toBe(404);
    expect((await Experience.POST(req("POST"), ctx({ id: other, productId }))).status).toBe(404);
    // A hypothesis finding → recommendation only; a member cannot dismiss.
    const a = await prisma.experienceAudit.create({ data: { companyId: ws, productId, status: "COMPLETED" } });
    const hyp = toFinding({ rule: "clarity:ambiguous_label", method: "static", route: "", target: "unit-test-label", detail: "x", evidence: [] });
    await persistFindings(ws, productId, a.id, [hyp], { browserRan: false, shared: [] });
    const row = await prisma.experienceFinding.findFirstOrThrow({ where: { productId, fingerprint: hyp.fingerprint } });
    await as("member");
    const t = await json(await FindingRoute.POST(req("POST", { action: "create_task" }), ctx({ id: ws, productId, findingId: row.id })));
    expect(t.status).toBe(422);
    expect(t.body.error).toMatch(/hypothesis/);
    expect((await FindingRoute.POST(req("POST", { action: "dismiss", note: "n" }), ctx({ id: ws, productId, findingId: row.id }))).status).toBe(403);
    await as("outsider");
    expect((await FindingRoute.POST(req("POST", { action: "create_task" }), ctx({ id: other, productId, findingId: row.id }))).status).toBe(404);
    await as("owner");
    expect((await FindingRoute.POST(req("POST", { action: "dismiss", note: "brand voice" }), ctx({ id: ws, productId, findingId: row.id }))).status).toBe(200);
    // Sensitive-flow finding: a member may not create the task; an admin may.
    const sens = toFinding({ rule: "form:no_validation_feedback", method: "browser", route: "/login", target: "form#login", detail: "login form gives no feedback", evidence: [] });
    await persistFindings(ws, productId, a.id, [sens], { browserRan: false, shared: [] });
    const srow = await prisma.experienceFinding.findFirstOrThrow({ where: { productId, fingerprint: sens.fingerprint } });
    await as("member");
    expect((await json(await FindingRoute.POST(req("POST", { action: "create_task" }), ctx({ id: ws, productId, findingId: srow.id })))).body.error).toMatch(/needs an admin: sensitive flow/);
    await prisma.experienceFinding.deleteMany({ where: { id: { in: [row.id, srow.id] } } });
    await prisma.experienceAudit.delete({ where: { id: a.id } });
  });

  it("bounded: a finding whose fixes failed twice is not tasked again", async () => {
    const a = await prisma.experienceAudit.create({ data: { companyId: ws, productId, status: "COMPLETED" } });
    const fx = toFinding({ rule: "control:inert", method: "browser", route: "/bounded", target: "b", detail: "x", evidence: [] });
    await persistFindings(ws, productId, a.id, [fx], { browserRan: false, shared: [] });
    const row = await prisma.experienceFinding.update({ where: { productId_fingerprint: { productId, fingerprint: fx.fingerprint } }, data: { attempts: 2 } });
    await expect(createTaskFromFinding(ws, productId, row.id, { email: users.owner.email, role: "OWNER" })).rejects.toThrow(/needs a person/);
    await prisma.experienceFinding.delete({ where: { id: row.id } });
    await prisma.experienceAudit.delete({ where: { id: a.id } });
  });
});

describe("closed loop on real infrastructure (Docker + Chromium)", () => {
  it("unavailable browser → static only, limitation recorded, journeys not_run, metrics null", async () => {
    const saved = process.env.AURA_BROWSER_VERIFY;
    process.env.AURA_BROWSER_VERIFY = "0";
    try {
      const a = await requestAudit(ws, productId, users.owner.email);
      await until(auditDone(a.id));
      const done = await prisma.experienceAudit.findUniqueOrThrow({ where: { id: a.id } });
      expect(done.status).toBe("COMPLETED");
      expect(JSON.parse(done.methods).browser).toMatch(/^unavailable/);
      expect(JSON.parse(done.limitations).join(" ")).toMatch(/No browser session/);
      expect(JSON.parse(done.journeys).every((j: { status: string }) => j.status === "not_run")).toBe(true);
      expect(JSON.parse(done.score).verdict).toBe("unverified");
      // Mark it non-baseline so the real audit below compares against nothing static-only.
      await prisma.experienceAudit.update({ where: { id: a.id }, data: { status: "CANCELLED" } });
    } finally {
      if (saved === undefined) delete process.env.AURA_BROWSER_VERIFY; else process.env.AURA_BROWSER_VERIFY = saved;
    }
  }, 120_000);

  it("audit → finding → task → real fix → re-audit FIXES it (others stay open) → memory; then a regression is detected and the finding reopens", async (c) => {
    if (!browser) return c.skip();
    // 1. Audit the running app.
    await as("member");
    const start = await json(await Experience.POST(req("POST"), ctx({ id: ws, productId })));
    expect(start.status).toBe(202);
    await until(auditDone(start.body.data.id));
    let ov = await experienceOverview(ws, productId);
    expect(ov.latest!.status).toBe("COMPLETED");
    expect(ov.latest!.methods.browser).toBe("ran");
    expect(ov.latest!.methods.axe).toBe("ran");
    const target = ov.findings.find((f) => f.rule === "journey:failed" && f.journey === "create:/api/notes")!;
    expect(target).toBeTruthy();
    expect(target.severity).toBe("critical");
    expect(target.requirements).toContain("FR-1");
    expect(target.policy.mode).toBe("auto");
    const openBefore = ov.findings.filter((f) => f.status === "OPEN").length;    expect(openBefore).toBeGreaterThan(5);
    expect((ov.latest!.score as { verdict: string }).verdict).toBe("blocked");
    // Dedupe: a second audit of the same code adds no new rows.
    const again = await requestAudit(ws, productId, users.owner.email);
    await until(auditDone(again.id));
    expect((await experienceOverview(ws, productId)).findings.length).toBe(ov.findings.length);
    // 2. Finding → task in the existing backlog; 3. the normal scheduler/builder implements and verifies it.
    const t = await json(await FindingRoute.POST(req("POST", { action: "create_task" }), ctx({ id: ws, productId, findingId: target.id })));
    expect(t.status).toBe(201);
    const key = t.body.data.itemKey as string;
    expect((await json(await FindingRoute.POST(req("POST", { action: "create_task" }), ctx({ id: ws, productId, findingId: target.id })))).status).toBe(409); // already in progress
    await tickProduct(ws, productId);
    await until(async () => !(await prisma.build.count({ where: { productId, itemKey: key, status: { in: ["QUEUED", "RUNNING"] } } })));
    const b = (await prisma.build.findFirst({ where: { productId, itemKey: key } }))!;
    if (b.status !== "VERIFIED") console.log(b.status, JSON.stringify(JSON.parse(b.findings).filter((f: { blocking: boolean }) => f.blocking)).slice(0, 2500), b.criteria.slice(0, 1500));
    expect(b.status).toBe("VERIFIED");
    // 4. Settlement triggers the re-audit against the integration base (the verified task branch is not yet released → main).
    //    The fix only counts once it is on the base the product is audited from: merge the verified branch like a release would.
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const fixedJs = await readAt(ws, p.repoId!, b.branch, "public/app.js");
    expect(fixedJs).toContain("await load();});");
    await commitFiles({ companyId: ws, repoId: p.repoId!, base: "main", branch: "main", files: { "public/app.js": fixedJs!, "src/notes-ui.test.js": (await readAt(ws, p.repoId!, b.branch, "src/notes-ui.test.js"))! }, message: `release ${key}` });
    await tickProduct(ws, productId); // settles the finding's task → requests the re-audit
    const re = await prisma.experienceAudit.findFirst({ where: { productId, trigger: "change" }, orderBy: { createdAt: "desc" } });
    expect(re).toBeTruthy();
    await until(auditDone(re!.id));
    ov = await experienceOverview(ws, productId);
    const after = ov.findings.find((f) => f.id === target.id)!;
    expect(after.status).toBe("FIXED");
    expect(after.history.map((h) => h.change).join(" | ")).toMatch(/no longer observed by a re-audit/);
    expect(ov.findings.filter((f) => f.status === "OPEN").length).toBe(openBefore - 1); // the other planted defects are still there
    const mem = await prisma.projectMemory.findFirst({ where: { productId, key: { startsWith: "ux:journey:failed" } } });
    expect(mem).toMatchObject({ status: "VERIFIED", kind: "defect_solution" });
    // 5. Regression: the fix is reverted → the next audit reports a regression vs the baseline and REOPENS the same finding.
    await commitFiles({ companyId: ws, repoId: p.repoId!, base: "main", branch: "main", files: { "public/app.js": appFiles(false)["public/app.js"] }, message: "accidental revert" });
    const reg = await requestAudit(ws, productId, users.owner.email, "change");
    await until(auditDone(reg.id));
    const regRow = await prisma.experienceAudit.findUniqueOrThrow({ where: { id: reg.id } });
    expect(JSON.parse(regRow.regressions)).toContain(target.fingerprint);
    const reopened = await prisma.experienceFinding.findUniqueOrThrow({ where: { id: target.id } });
    expect(reopened).toMatchObject({ status: "REOPENED", reopened: 1 });
    expect(JSON.parse(regRow.score).reopened).toBe(1);
  }, 600_000);
});
