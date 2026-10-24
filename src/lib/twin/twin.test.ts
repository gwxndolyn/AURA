/**
 * Digital twin tests: engine determinism + rules, scenario criteria,
 * persisted runs (reproducibility by hash), what-if isolation from live
 * state, comparison explanations, config versioning, and tenant isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { createMission, planMission } from "@/lib/missions/engine";
import { simulate, validateDecisions, DEFAULT_DECISIONS, RULES_VERSION, type Decisions } from "./engine";
import { SCENARIOS } from "./scenarios";
import { runScenario, verifyReproducible, compareRuns, decodeRun, reviewRun, saveRun, discardUnsaved } from "./runs";
import { getConfig, updateConfig, previewImpact } from "./config";
import { liveDepartments } from "./departments";
import { operationalMetrics } from "./metrics";
import { companyTimeline } from "./timeline";

const crunch = SCENARIOS.delivery_crunch;
let user: string, ws: string, other: string, otherWs: string;

beforeAll(async () => {
  const s = Date.now();
  user = (await prisma.user.create({ data: { email: `twin_${s}@t.local`, name: "T" } })).id;
  other = (await prisma.user.create({ data: { email: `twin_o_${s}@t.local`, name: "O" } })).id;
  ws = (await createCompany({ name: "TWIN", mission: "m", industry: "SaaS", ownerId: user })).id;
  otherWs = (await createCompany({ name: "TWIN-OTHER", mission: "m", industry: "SaaS", ownerId: other })).id;
}, 60_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await prisma.user.deleteMany({ where: { id: { in: [user, other] } } });
  await prisma.$disconnect();
});

describe("engine", () => {
  it("is deterministic: same state + decisions + seed → identical transitions and result", () => {
    const a = simulate(crunch.initial, crunch.defaults, crunch.seed);
    const b = simulate(structuredClone(crunch.initial), structuredClone(crunch.defaults), crunch.seed);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.result.rulesVersion).toBe(RULES_VERSION);
  });

  it("a different seed changes only seeded outcomes (QA defects), not the deterministic schedule rules", () => {
    const seeds = [1, 2, 3, 4, 5].map((s) => simulate(crunch.initial, crunch.defaults, s).transitions.filter((t) => t.type === "verify_fail").length);
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("validates decisions", () => {
    expect(validateDecisions({ ...DEFAULT_DECISIONS, allocation: { feature: 0.5, quality: 0.5, reliability: 0.5, security: 0 } }).join()).toMatch(/sum to 100%/);
    expect(validateDecisions({ ...DEFAULT_DECISIONS, allocation: { feature: 0.05, quality: 0.45, reliability: 0.25, security: 0.25 } }).join()).toMatch(/at least 10%/);
    expect(validateDecisions({ ...DEFAULT_DECISIONS, capacity: { qa: 99 } }).join()).toMatch(/qa capacity/);
    expect(validateDecisions({ ...DEFAULT_DECISIONS, priorities: ["ship_feature", "ship_feature", "reduce_cost", "fix_reliability"] }).join()).toMatch(/exactly once/);
    expect(() => simulate(crunch.initial, { ...DEFAULT_DECISIONS, capacity: { engineering: 0 } }, 1)).toThrow(/Invalid decisions/);
  });

  it("decisions change outcomes through the rules, not labels", () => {
    const base = simulate(crunch.initial, crunch.defaults, crunch.seed).result;
    const moreQa = simulate(crunch.initial, { ...crunch.defaults, capacity: { qa: 2 } }, crunch.seed).result;
    const noGate = simulate(crunch.initial, { ...crunch.defaults, verificationGate: false }, crunch.seed).result;
    expect(moreQa.metrics.avgWaitTicks).toBeLessThan(base.metrics.avgWaitTicks);
    expect(moreQa.metrics.delivered).toBeGreaterThanOrEqual(base.metrics.delivered);
    // Turning the gate off ships faster but delivers nothing verified.
    expect(noGate.metrics.delivered).toBe(0);
    expect(noGate.metrics.escapedUnverified).toBe(crunch.initial.items.length);
    // Priority order changes scheduling.
    const relFirst = simulate(SCENARIOS.reliability_crisis.initial, { ...DEFAULT_DECISIONS, priorities: ["fix_reliability", "ship_feature", "resolve_security", "reduce_cost"], allocation: { feature: 0.3, quality: 0.2, reliability: 0.4, security: 0.1 }, capacity: { infra: 2 } }, SCENARIOS.reliability_crisis.seed).result;
    const relBase = simulate(SCENARIOS.reliability_crisis.initial, SCENARIOS.reliability_crisis.defaults, SCENARIOS.reliability_crisis.seed).result;
    expect(relFirst.metrics.incidentDowntime).toBeLessThan(relBase.metrics.incidentDowntime);
  });

  it("the flagship is never counted delivered unless verified", () => {
    const r = simulate(crunch.initial, { ...crunch.defaults, verificationGate: false }, crunch.seed).result;
    const flagship = r.items.find((i) => i.id === "SIM-CHECKOUT-V2")!;
    expect(flagship.status).toBe("escaped");
    expect(crunch.successCriteria.find((c) => c.id === "flagship")!.check(r.metrics, r.items)).toBe(false);
  });

  it("dependencies and external blockers are respected", () => {
    const { transitions, result } = simulate(crunch.initial, crunch.defaults, crunch.seed);
    const payDone = result.items.find((i) => i.id === "SIM-PAYMENTS-API")!.doneAt!;
    const flagStart = transitions.find((t) => t.type === "started" && t.item === "SIM-CHECKOUT-V2")?.t ?? Infinity;
    expect(flagStart).toBeGreaterThan(payDone);
    expect(transitions.find((t) => t.type === "started" && t.item === "SIM-PAYMENTS-API")!.t).toBeGreaterThanOrEqual(3);
  });

  it("rollback shortens the reliability incident; risk policy delays security work via simulated approvals", () => {
    const rc = SCENARIOS.reliability_crisis;
    expect(simulate(rc.initial, { ...rc.defaults, useRollback: true }, rc.seed).result.metrics.incidentDowntime).toBeLessThan(simulate(rc.initial, rc.defaults, rc.seed).result.metrics.incidentDowntime);
    const sg = SCENARIOS.security_growth;
    const cautious = simulate(sg.initial, { ...sg.defaults, riskPolicy: "cautious" }, sg.seed);
    const aggressive = simulate(sg.initial, { ...sg.defaults, riskPolicy: "aggressive" }, sg.seed);
    expect(cautious.transitions.some((t) => t.type === "approval_wait")).toBe(true);
    expect(aggressive.transitions.some((t) => t.type === "approval_wait")).toBe(false);
  });

  it("composite score exposes its formula and components", () => {
    const r = simulate(crunch.initial, crunch.defaults, crunch.seed).result;
    const sum = Object.values(r.composite.components).reduce((n, c) => n + c.contribution, 0);
    expect(Math.abs(sum - r.composite.score)).toBeLessThan(0.01);
    expect(r.composite.formula).toMatch(/0\.35/);
  });
});

describe("Delivery Crunch acceptance (persisted runs)", () => {
  let baselineId: string, whatIfId: string;

  it("baseline run records initial state, rules version, seed, inputs and result", async () => {
    const run = await runScenario({ companyId: ws, scenario: "delivery_crunch", decisions: crunch.defaults, kind: "baseline", actor: "ceo@test" });
    baselineId = run.id;
    const d = decodeRun(run);
    expect(d.rulesVersion).toBe(RULES_VERSION);
    expect(d.seed).toBe(crunch.seed);
    expect(d.initialState.items.map((i) => i.id)).toEqual(crunch.initial.items.map((i) => i.id));
    expect(d.transitions.length).toBeGreaterThan(5);
    expect(d.result.criteria.find((c) => c.id === "flagship")!.met).toBe(false); // baseline misses the flagship deadline
  });

  it("is reproducible: re-running the stored inputs gives the same result hash", async () => {
    expect(await verifyReproducible(ws, baselineId)).toMatchObject({ reproducible: true, inputHash: true });
    const again = await runScenario({ companyId: ws, scenario: "delivery_crunch", decisions: crunch.defaults, kind: "baseline", actor: "ceo@test" });
    const first = await prisma.twinRun.findUnique({ where: { id: baselineId } });
    expect(again.inputHash).toBe(first!.inputHash);
    expect(again.resultHash).toBe(first!.resultHash);
    await prisma.twinRun.delete({ where: { id: again.id } });
  });

  it("a what-if uses an isolated copy of the baseline and changes the outcome; no live state is mutated", async () => {
    const m = await createMission({ companyId: ws, createdById: user, objective: "Review the notification service design for scaling risks." });
    await planMission(m.id, ws);
    const snapshot = async () => JSON.stringify({
      missions: await prisma.mission.findMany({ where: { companyId: ws }, orderBy: { id: "asc" } }),
      tasks: await prisma.missionTask.findMany({ where: { companyId: ws }, orderBy: { id: "asc" } }),
      deployments: await prisma.deployment.findMany({ where: { companyId: ws }, orderBy: { id: "asc" } }),
      agents: await prisma.agent.findMany({ where: { companyId: ws }, orderBy: { id: "asc" }, select: { key: true, status: true, available: true, currentTask: true } }),
      approvals: await prisma.missionApproval.count({ where: { companyId: ws } }),
      toolCalls: await prisma.toolCall.count({ where: { run: { companyId: ws } } }),
      agentRuns: await prisma.agentRun.count({ where: { companyId: ws } }),
    });
    const before = await snapshot();
    const decisions: Decisions = { ...crunch.defaults, capacity: { qa: 2 } };
    const w = await runScenario({ companyId: ws, scenario: "delivery_crunch", decisions, kind: "what_if", baselineId, label: "QA +1", actor: "ceo@test" });
    whatIfId = w.id;
    expect(await snapshot()).toBe(before);
    const d = decodeRun(w);
    expect(d.seed).toBe(crunch.seed);
    expect(d.baselineId).toBe(baselineId);
    expect(d.result.criteria.every((c) => c.met)).toBe(true);
  });

  it("comparison explains the difference from the transitions and rules", async () => {
    const c = await compareRuns(ws, [baselineId, whatIfId]);
    expect(c.decisionDiffs[0].diffs).toContain("qa capacity 1 → 2 slots");
    const delivered = c.metrics.find((m) => m.key === "delivered")!;
    expect(delivered.values[1]).toBeGreaterThan(delivered.values[0] as number);
    expect(c.explanations[0].notes.join(" ")).toMatch(/SIM-CHECKOUT-V2/);
    expect(c.caveat).toMatch(/not a forecast/);
    const review = reviewRun(decodeRun((await prisma.twinRun.findUnique({ where: { id: baselineId } }))!));
    expect(review.join(" ")).toMatch(/Not met: SIM-CHECKOUT-V2/);
  });

  it("saving persists; discarding removes only unsaved runs of this scenario in this workspace", async () => {
    await saveRun(ws, whatIfId, "ceo@test", "Preferred: QA +1");
    const scratch = await runScenario({ companyId: ws, scenario: "delivery_crunch", decisions: crunch.defaults, kind: "what_if", baselineId, actor: "ceo@test" });
    const otherRun = await runScenario({ companyId: otherWs, scenario: "delivery_crunch", decisions: crunch.defaults, kind: "baseline", actor: "x@test" });
    const missionsBefore = await prisma.mission.count({ where: { companyId: ws } });
    const r = await discardUnsaved(ws, "delivery_crunch", "ceo@test");
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.twinRun.findUnique({ where: { id: scratch.id } })).toBeNull();
    expect((await prisma.twinRun.findUnique({ where: { id: whatIfId } }))!.saved).toBe(true);
    expect(await prisma.twinRun.findUnique({ where: { id: otherRun.id } })).not.toBeNull();
    expect(await prisma.mission.count({ where: { companyId: ws } })).toBe(missionsBefore);
  });

  it("another workspace cannot read, compare, reproduce or what-if against these runs", async () => {
    await expect(compareRuns(otherWs, [baselineId, whatIfId])).rejects.toThrow(/not found/i);
    await expect(verifyReproducible(otherWs, baselineId)).rejects.toThrow(/not found/i);
    await expect(saveRun(otherWs, whatIfId, "x")).rejects.toThrow(/not found/i);
    await expect(runScenario({ companyId: otherWs, scenario: "delivery_crunch", decisions: crunch.defaults, kind: "what_if", baselineId, actor: "x" })).rejects.toThrow(/not found/i);
    expect((await companyTimeline(otherWs, { runId: baselineId })).length).toBe(0);
  });

  it("timeline labels simulation events and filters by run", async () => {
    const items = await companyTimeline(ws, { runId: whatIfId });
    expect(items.length).toBeGreaterThan(3);
    expect(items.every((i) => i.provenance === "simulation")).toBe(true);
    expect(items.some((i) => i.type === "verify_pass" && i.dept === "qa")).toBe(true);
  });
});

describe("CEO configuration, live departments, operational metrics", () => {
  it("config is versioned, validated and conflict-checked; preview is simulated only", async () => {
    const c = await getConfig(ws);
    await expect(updateConfig(ws, "ceo@test", { allocation: { feature: 0.9, quality: 0.2, reliability: 0, security: 0 } }, c.version)).rejects.toThrow(/sum to 100%/);
    const next = await updateConfig(ws, "ceo@test", { priorities: ["fix_reliability", "ship_feature", "resolve_security", "reduce_cost"] }, c.version);
    expect(next.version).toBe(c.version + 1);
    expect(next.history.at(-1)!.change).toMatch(/priorities fix_reliability > ship_feature/);
    await expect(updateConfig(ws, "ceo@test", { riskPolicy: "cautious" }, c.version)).rejects.toThrow(/changed since you loaded it/);
    const p = previewImpact("delivery_crunch", crunch.defaults, { ...crunch.defaults, capacity: { qa: 2 } });
    expect(p.simulated).toBe(true);
    expect(p.proposed.delivered).toBeGreaterThanOrEqual(p.current.delivered as number);
  });

  it("departments reflect real rows; metrics report insufficient data instead of inventing numbers", async () => {
    const live = await liveDepartments(ws);
    const eng = live.departments.find((d) => d.key === "engineering")!;
    expect(eng.agents.map((a) => a.key).sort()).toEqual(["backend-engineer", "frontend-engineer"]);
    const mission = await prisma.mission.findFirst({ where: { companyId: ws, status: "AWAITING_APPROVAL" } });
    expect(mission).toBeTruthy();
    const m = await operationalMetrics(ws);
    expect(m.find((x) => x.key === "mission_failure_rate")!.value).toBeNull(); // no finished missions
    expect(m.find((x) => x.key === "verification_pass_rate")!.note).toMatch(/fewer than 3/);
    expect(m.every((x) => x.kind === "operational" && x.definition && x.source && x.window)).toBe(true);
  });
});
