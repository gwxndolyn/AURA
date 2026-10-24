/**
 * Engineering lab: decision rules, experiment lifecycle, rejected-approach
 * memory, interruption recovery, API authorization and tenant isolation.
 * Benchmarks execute for real (Docker when available; otherwise host
 * execution of the bundled fixtures, enabled here explicitly).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "aura_session" && currentToken ? { value: currentToken } : undefined), set: () => {} }),
}));

import { prisma } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { createCompany } from "@/lib/company/provision";
import { decide, securityRelevantChange, sameConfig, runSuite, proposeExperiment, runExperiment, verifyState, loadState, saveState, proposeBacklog, type Rule } from "./lab";
import { scorecard } from "./scorecard";
import type { CaseOutcome } from "./runner";
import * as LabRoute from "@/app/api/companies/[id]/lab/route";
import * as RunsRoute from "@/app/api/companies/[id]/lab/runs/route";
import * as ExpRoute from "@/app/api/companies/[id]/lab/experiments/[experimentId]/route";

const users: Record<string, { id: string; email: string }> = {};
let ws: string, otherWs: string;
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method = "GET", body?: unknown) => new Request("http://t.local/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async (n: string | null) => { currentToken = n ? await createSessionToken({ userId: users[n].id, email: users[n].email }) : null; };
const prevHost = process.env.AURA_LAB_HOST_EXECUTION;

beforeAll(async () => {
  process.env.AURA_LAB_HOST_EXECUTION = "1";
  const s = Date.now();
  for (const n of ["owner", "member", "outsider"]) users[n] = await prisma.user.create({ data: { email: `${n}_${s}@lab.local`, name: n } });
  ws = (await createCompany({ name: "LAB", mission: "m", industry: "SaaS", ownerId: users.owner.id })).id;
  otherWs = (await createCompany({ name: "LAB-O", mission: "m", industry: "SaaS", ownerId: users.outsider.id })).id;
  await prisma.subscription.create({ data: { companyId: ws, plan: "team", status: "active" } }); // the engineering lab is a Team feature
  await prisma.workspaceMember.create({ data: { userId: users.member.id, companyId: ws, role: "MEMBER" } });
}, 60_000);

afterAll(async () => {
  if (prevHost === undefined) delete process.env.AURA_LAB_HOST_EXECUTION;
  else process.env.AURA_LAB_HOST_EXECUTION = prevHost;
  await prisma.labState.deleteMany({ where: { companyId: { in: [ws, otherWs] } } });
  await prisma.company.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await prisma.$disconnect();
});

const gateCase = (id: string, split: "train" | "heldout", expected: "accept" | "reject", decision: "accept" | "reject"): CaseOutcome => ({ benchmarkId: id, benchmarkVersion: 1, category: "x", split, kind: "gate", fixtureHash: "", status: expected === decision ? "PASSED" : "FAILED", criteria: [], measures: { expected, decision, falseAccept: expected === "reject" && decision === "accept", falseReject: expected === "accept" && decision === "reject" }, commands: [], error: "", durationMs: 1, sandboxMs: 0 });
const cards = (cs: CaseOutcome[]) => ({ all: scorecard(cs, "all"), train: scorecard(cs, "train"), heldout: scorecard(cs, "heldout") });
const success: Rule[] = [{ metric: "engineeringQuality.badChangeRejection", op: ">=", value: 1, split: "train" }];
const regression: Rule[] = [{ metric: "functional.correctAccepts", op: ">=", value: 1, split: "all" }];

describe("decision rules", () => {
  it("security relevance comes from what differs between the arms, not from config text", () => {
    expect(securityRelevantChange("gate=v2", "gate=v2,diagnose=v2")).toBe(false);
    expect(securityRelevantChange("gate=v2", "gate=v3")).toBe(true);
    expect(securityRelevantChange("default", "context=graph")).toBe(false);
    expect(sameConfig("default", "context=graph")).toBe(true); // graph is the code default now
    expect(sameConfig("gate=v2", "default")).toBe(false);
  });
  const base = cards([gateCase("g1", "train", "reject", "accept"), gateCase("g2", "train", "accept", "accept"), gateCase("h1", "heldout", "accept", "accept")]);
  it("accepts only when every success criterion is met and nothing regresses", () => {
    const cand = cards([gateCase("g1", "train", "reject", "reject"), gateCase("g2", "train", "accept", "accept"), gateCase("h1", "heldout", "accept", "accept")]);
    expect(decide({ success, regression, base, cand, securityRelevant: false }).outcome).toBe("ACCEPTED");
    expect(decide({ success, regression, base, cand, securityRelevant: true }).outcome).toBe("AWAITING_APPROVAL");
  });
  it("a better target metric does not hide a regression (rejecting a correct change)", () => {
    const cand = cards([gateCase("g1", "train", "reject", "reject"), gateCase("g2", "train", "accept", "reject"), gateCase("h1", "heldout", "accept", "accept")]);
    const d = decide({ success, regression, base, cand, securityRelevant: false });
    expect(d.outcome).toBe("REJECTED");
    expect(d.reasons.join()).toMatch(/regression: all functional.correctAccepts/);
  });
  it("held-out drops reject even when train improves (overfitting guard)", () => {
    const cand = cards([gateCase("g1", "train", "reject", "reject"), gateCase("g2", "train", "accept", "accept"), gateCase("h1", "heldout", "accept", "reject")]);
    expect(decide({ success, regression: [], base, cand, securityRelevant: false }).reasons.join()).toMatch(/held-out casesPassed dropped/);
  });
  it("newly falsely-accepted defective changes reject; unmeasured criteria never count as met", () => {
    const b2 = cards([gateCase("g1", "train", "reject", "reject")]);
    const c2 = cards([gateCase("g1", "train", "reject", "accept")]);
    expect(decide({ success: [{ metric: "functional.casesPassed", op: ">=", value: 0, split: "train" }], regression: [], base: b2, cand: c2, securityRelevant: false }).outcome).toBe("REJECTED");
    const d = decide({ success: [{ metric: "engineeringQuality.contextRecall", op: ">=", value: 1, split: "train" }], regression: [], base: b2, cand: b2, securityRelevant: false });
    expect(d.outcome).toBe("INCONCLUSIVE");
    expect(d.reasons.join()).toMatch(/not measured/);
  });
});

describe("experiments on the real pipeline", () => {
  let expId = "";
  it("baseline benchmark run persists every case and a scorecard with denominators", async () => {
    const r = await runSuite({ companyId: ws, configKey: "default", split: "all", actor: "t" });
    expect(r.run.status).toBe("COMPLETED");
    expect(r.run.executor).toMatch(/docker|host-trusted/);
    expect(await prisma.labCaseResult.count({ where: { runId: r.run.id } })).toBe(r.run.total);
    expect(r.run.errored).toBe(0);
    const bcr = r.card.all.dimensions.engineeringQuality.badChangeRejection;
    expect(bcr.denominator).toBeGreaterThan(0);
    expect(r.card.all.notMeasured.map((n) => n.dimension)).toContain("customerExperience");
    // Real execution happened: gate cases ran the fixture's test command.
    const g = r.outcomes.find((o) => o.benchmarkId === "gate-reject-failing-fix")!;
    expect(g.commands[0].exitCode).not.toBe(0);
    expect(g.status).toBe("PASSED");
    const back = await proposeBacklog(ws);
    expect(back.items[0].risk).toBe("critical"); // v1 lets security defects through
  }, 120_000);

  it("an experiment with evidence runs both arms on the same suite and decides; a rejected approach is not re-run blindly", async () => {
    const e = await proposeExperiment({ companyId: ws, actor: "t", key: "gate-v2-test", title: "gate v2", problem: "v1 accepts defective changes", evidence: [{ kind: "lab", ref: "x", detail: "y" }], hypothesis: "rules reject them", success: [{ metric: "engineeringQuality.badChangeRejection", op: "delta>=", value: 0.3, split: "all" }], regression: [{ metric: "economics.falseRejectRate", op: "<=", value: 0, split: "all" }], procedure: "full suite", rejectIf: "false rejects", baselineConfig: "default", candidateConfig: "gate=v2" });
    expId = e.id;
    const r = await runExperiment(ws, e.id, "t");
    expect(r.decision.outcome).toBe("AWAITING_APPROVAL"); // gate changes are security-relevant
    const runs = await prisma.labRun.findMany({ where: { experimentId: e.id } });
    expect(new Set(runs.map((x) => x.suiteVersion)).size).toBe(1);
    expect(new Set(runs.map((x) => x.executor)).size).toBe(1);
    expect(r.changedCases.every((c) => c.baseline === "FAILED" && c.candidate === "PASSED")).toBe(true);
    // A deliberately bad candidate (no change) on a context goal → INCONCLUSIVE, recorded honestly.
    const n = await proposeExperiment({ companyId: ws, actor: "t", key: "noop", title: "no-op", problem: "p".repeat(12), evidence: [{ kind: "lab", ref: "x", detail: "y" }], hypothesis: "h".repeat(12), success: [{ metric: "engineeringQuality.contextRecall", op: "delta>=", value: 0.1, split: "all" }], regression: [], procedure: "", rejectIf: "", baselineConfig: "default", candidateConfig: "default" });
    expect((await runExperiment(ws, n.id, "t")).decision.outcome).toBe("INCONCLUSIVE");
    await prisma.labExperiment.update({ where: { id: n.id }, data: { status: "REJECTED", decision: JSON.stringify({ reasons: ["no measurable benefit"] }) } });
    await expect(proposeExperiment({ companyId: ws, actor: "t", key: "noop", title: "again", problem: "p".repeat(12), evidence: [{ kind: "lab", ref: "x", detail: "y" }], hypothesis: "h".repeat(12), success: [{ metric: "functional.casesPassed", op: ">=", value: 1, split: "all" }], regression: [], procedure: "", rejectIf: "", baselineConfig: "default", candidateConfig: "default" })).rejects.toThrow(/already rejected.*no measurable benefit/);
  }, 240_000);

  it("interrupted experiments and stale state are reconciled on startup, not trusted", async () => {
    const e = await proposeExperiment({ companyId: ws, actor: "t", key: "crash", title: "crash", problem: "p".repeat(12), evidence: [{ kind: "lab", ref: "x", detail: "y" }], hypothesis: "h".repeat(12), success: [{ metric: "functional.casesPassed", op: ">=", value: 1, split: "all" }], regression: [], procedure: "", rejectIf: "", baselineConfig: "default", candidateConfig: "default" });
    await prisma.labExperiment.update({ where: { id: e.id }, data: { status: "RUNNING", createdAt: new Date(Date.now() - 3_600_000) } });
    await saveState(ws, { status: "RUNNING", activeExperimentId: e.id });
    const v = await verifyState(ws, { staleMs: 60_000 });
    expect(v.fixes.join()).toMatch(/interrupted experiment/);
    expect((await prisma.labExperiment.findUnique({ where: { id: e.id } }))!.status).toBe("INTERRUPTED");
    const st = await loadState(ws);
    expect(st.status).toBe("IDLE");
    expect(st.activeExperimentId).toBeNull();
    // It can be resumed (re-run from scratch; runs are idempotent).
    expect((await runExperiment(ws, e.id, "t")).experiment.status).not.toBe("RUNNING");
  }, 240_000);

  it("API: viewers/members cannot run or approve; admins approve; pause blocks runs; other tenants get nothing", async () => {
    await as("member");
    expect((await RunsRoute.POST(req("POST", { config: "default" }), ctx({ id: ws }))).status).toBe(403);
    expect((await ExpRoute.POST(req("POST", { action: "approve" }), ctx({ id: ws, experimentId: expId }))).status).toBe(403);
    expect((await LabRoute.GET(req(), ctx({ id: ws }))).status).toBe(200);
    await as("owner");
    expect((await LabRoute.POST(req("POST", { action: "pause" }), ctx({ id: ws }))).status).toBe(200);
    expect((await RunsRoute.POST(req("POST", { config: "default" }), ctx({ id: ws }))).status).toBe(409);
    expect((await LabRoute.POST(req("POST", { action: "resume" }), ctx({ id: ws }))).status).toBe(200);
    const ap = await ExpRoute.POST(req("POST", { action: "approve", note: "reviewed rules" }), ctx({ id: ws, experimentId: expId }));
    expect(ap.status).toBe(200);
    expect((await loadState(ws)).activeConfig).toBe("gate=v2");
    expect((await ExpRoute.POST(req("POST", { action: "approve" }), ctx({ id: ws, experimentId: expId }))).status).toBe(409);
    await as("outsider");
    expect([403, 404]).toContain((await LabRoute.GET(req(), ctx({ id: ws }))).status);
    expect((await ExpRoute.POST(req("POST", { action: "cancel" }), ctx({ id: otherWs, experimentId: expId }))).status).toBe(404);
    await as(null);
  }, 60_000);
});
