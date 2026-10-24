/**
 * Operational intelligence tests.
 *   1. Detection quality on synthetic fixtures (pure rules): precision, recall,
 *      duplicate rate, unknown handling. Printed and asserted.
 *   2. Reconciliation against the real DB: dedupe, resolve, re-open,
 *      dismissed stays dismissed, notifications not repeated.
 *   3. Policy enforcement + real action execution + tenant isolation.
 *   4. Monitor lease (no overlapping runs), interval, disabled.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { evaluateRules, dedupeKeyFor, RULES } from "./rules";
import { SCENARIOS } from "./fixtures";
import { decidePolicy, executeAction, recommendationsFor } from "./actions";
import { runEvaluation, getMonitor } from "./monitor";
import { buildBriefing, aiSummary, prioritize } from "./briefing";
import { createMission, planMission, decidePlan, advanceMission } from "@/lib/missions/engine";
import { injectFault, clearFaults } from "@/lib/missions/faults";
import { runDeployment } from "@/lib/workflows/deploy";

let user: string, ws: string, otherWs: string, other: string;

beforeAll(async () => {
  const s = Date.now();
  user = (await prisma.user.create({ data: { email: `ops_${s}@t.local`, name: "O" } })).id;
  other = (await prisma.user.create({ data: { email: `ops_o_${s}@t.local`, name: "X" } })).id;
  ws = (await createCompany({ name: "OPS", mission: "m", industry: "SaaS", ownerId: user })).id;
  otherWs = (await createCompany({ name: "OPS-OTHER", mission: "m", industry: "SaaS", ownerId: other })).id;
}, 60_000);

afterAll(async () => {
  clearFaults();
  await prisma.company.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await prisma.user.deleteMany({ where: { id: { in: [user, other] } } });
  await prisma.$disconnect();
});

describe("detection quality on synthetic fixtures", () => {
  it("meets precision/recall targets, never duplicates, and reports unknowns", () => {
    let tp = 0, fp = 0, fn = 0, dupes = 0, fires = 0, unknownOk = 0, unknownExpected = 0;
    const rows: string[] = [];
    for (const sc of SCENARIOS) {
      const res = evaluateRules(sc.snapshot);
      const fired = res.filter((r) => r.outcome.kind === "fire").map((r) => dedupeKeyFor(r.rule.id, r.outcome.resource));
      const unique = new Set(fired);
      fires += fired.length;
      dupes += fired.length - unique.size;
      const expected = new Set(sc.expect);
      const forbidden = new Set(sc.forbid ?? []);
      let sTp = 0, sFp = 0, sFn = 0;
      // Any fired key that the scenario does not expect is a false positive (forbidden rules included).
      for (const k of unique) {
        if (expected.has(k)) sTp++;
        else sFp++;
      }
      for (const r of forbidden) if ([...unique].some((k) => k.startsWith(`${r}:`))) rows.push(`  ! ${sc.id}: forbidden rule ${r} fired`);
      for (const k of expected) if (!unique.has(k)) sFn++;
      for (const r of sc.unknown ?? []) {
        unknownExpected++;
        if (res.some((x) => x.rule.id === r && x.outcome.kind === "unknown")) unknownOk++;
      }
      tp += sTp;
      fp += sFp;
      fn += sFn;
      rows.push(`${sc.id.padEnd(34)} tp=${sTp} fp=${sFp} fn=${sFn}${sFp || sFn ? `  fired=${[...unique].join(",")}` : ""}`);
    }
    const precision = tp / (tp + fp || 1);
    const recall = tp / (tp + fn || 1);
    console.log(`DETECTION ${SCENARIOS.length} scenarios, ${RULES.length} rules\n${rows.join("\n")}\nprecision=${precision.toFixed(3)} recall=${recall.toFixed(3)} duplicateRate=${(dupes / (fires || 1)).toFixed(3)} unknownCorrect=${unknownOk}/${unknownExpected}`);
    expect(dupes).toBe(0);
    expect(recall).toBe(1);
    expect(precision).toBe(1);
    expect(unknownOk).toBe(unknownExpected);
  });

  it("every rule documents evidence, trigger, severity, dedupe, resolution, false positives and human action", () => {
    for (const r of RULES) for (const v of Object.values(r.definition)) expect(v.length).toBeGreaterThan(5);
  });
});

describe("policy (enforced in code)", () => {
  const base = { allowedAuto: [], autoActionsLastHour: 0, maxAutoPerHour: 5, target: { type: "task" as const, id: "t" } };
  it("Observe blocks every action, including user-initiated", () => {
    expect(decidePolicy({ ...base, level: "OBSERVE", action: "pause_mission", trigger: "user", role: "OWNER" }).decision).toBe("blocked");
  });
  it("Recommend allows users with the role, never automatic", () => {
    expect(decidePolicy({ ...base, level: "RECOMMEND", action: "retry_task", trigger: "user", role: "MEMBER" }).decision).toBe("allowed");
    expect(decidePolicy({ ...base, level: "RECOMMEND", action: "cancel_mission", trigger: "user", role: "MEMBER" }).rule).toBe("role_insufficient");
    expect(decidePolicy({ ...base, level: "RECOMMEND", action: "retry_task", trigger: "automatic", allowedAuto: ["retry_task"] }).decision).toBe("blocked");
  });
  it("Bounded runs only allow-listed, low-risk actions, rate-limited", () => {
    expect(decidePolicy({ ...base, level: "BOUNDED", action: "retry_task", trigger: "automatic" }).rule).toBe("not_in_allowlist");
    expect(decidePolicy({ ...base, level: "BOUNDED", action: "retry_task", trigger: "automatic", allowedAuto: ["retry_task"] }).decision).toBe("allowed");
    expect(decidePolicy({ ...base, level: "BOUNDED", action: "cancel_mission", trigger: "automatic", allowedAuto: ["cancel_mission"] }).rule).toBe("not_auto_eligible");
    expect(decidePolicy({ ...base, level: "CONTINUOUS", action: "retry_task", trigger: "automatic", allowedAuto: ["retry_task"], autoActionsLastHour: 5 }).rule).toBe("rate_limited");
  });
  it("production rollback always requires approval, at every level", () => {
    for (const level of ["RECOMMEND", "BOUNDED", "CONTINUOUS"] as const)
      expect(decidePolicy({ ...base, level, action: "rollback_deployment", trigger: "user", role: "OWNER", target: { type: "deployment", id: "d", env: "production" } }).decision).toBe("requires_approval");
  });
});

describe("findings lifecycle against persisted state", () => {
  let missionId: string;

  it("a controlled task timeout creates exactly one finding with real evidence", async () => {
    const m = await createMission({ companyId: ws, createdById: user, objective: "Inspect the checkout module, identify the cause of a failing validation test, implement a minimal fix." });
    missionId = m.id;
    await planMission(m.id, ws);
    await decidePlan(m.id, ws, "approve", "human@test");
    await advanceMission(m.id, ws); // requirements
    injectFault(m.id, "architecture", { point: "tool", tool: "code.read", mode: "timeout", times: 5 });
    await advanceMission(m.id, ws); // architecture → tool_timeout (retried once, then failed)
    await advanceMission(m.id, ws); // reproduce (independent branch)
    await advanceMission(m.id, ws); // mission fails: required task failed
    expect((await prisma.mission.findUnique({ where: { id: m.id } }))!.status).toBe("FAILED");

    const r1 = await runEvaluation(ws, "manual", { force: true, probe: false });
    const r2 = await runEvaluation(ws, "manual", { force: true, probe: false });
    expect(r1.ran && r2.ran).toBe(true);
    expect(r2.opened).toBe(0); // idempotent
    const findings = await prisma.opsFinding.findMany({ where: { companyId: ws, missionId: m.id, status: "OPEN" } });
    expect(findings.map((f) => f.ruleId)).toEqual(["mission.failed"]);
    const ev = JSON.parse(findings[0].evidence) as { kind: string; id: string }[];
    const archRun = await prisma.missionTaskRun.findFirst({ where: { missionId: m.id, taskKey: "architecture" } });
    expect(ev.some((e) => e.kind === "run" && e.id === archRun!.id)).toBe(true); // links the actual execution
    expect(JSON.parse(findings[0].facts)).toMatchObject({ taskKey: "architecture", errorCategory: "tool_timeout", transient: true });
    expect(findings[0].severity).toBe("medium");
    // Architecture failed with tool_timeout; the runtime retry consumed two code.read timeouts.
    const runs = await prisma.missionTaskRun.findMany({ where: { missionId: m.id, taskKey: "architecture" } });
    expect(runs[0].errorCategory).toBe("tool_timeout");
    expect(new Set(findings.map((f) => f.dedupeKey)).size).toBe(findings.length);
    const notif = await prisma.notification.count({ where: { companyId: ws } });
    await runEvaluation(ws, "manual", { force: true, probe: false });
    expect(await prisma.notification.count({ where: { companyId: ws } })).toBe(notif); // no repeat notifications
  }, 120_000);

  it("recommends a retry for the transient failure; Observe blocks it; Recommend runs it through the engine; the finding resolves only after the mission leaves FAILED", async () => {
    const task = await prisma.missionTask.findFirst({ where: { missionId, key: "architecture" } });
    const f = (await prisma.opsFinding.findFirst({ where: { companyId: ws, missionId, ruleId: "mission.failed" } }))!;
    const recs = await recommendationsFor(f);
    const retry = recs.find((r) => r.action === "retry_task" && r.target.taskKey === "architecture");
    expect(retry).toBeTruthy();
    expect(retry!.unavailable).toBeNull();

    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { policyLevel: "OBSERVE" } });
    const blocked = await executeAction({ companyId: ws, action: "retry_task", target: retry!.target, findingId: f.id, actor: "owner@test", role: "OWNER", trigger: "user" });
    expect(blocked.decision.decision).toBe("blocked");
    expect(blocked.action.policyRule).toBe("level_observe");
    expect((await prisma.missionTask.findUnique({ where: { id: task!.id } }))!.status).toBe("FAILED"); // nothing changed

    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { policyLevel: "RECOMMEND" } });
    const ok = await executeAction({ companyId: ws, action: "retry_task", target: retry!.target, findingId: f.id, actor: "owner@test", role: "OWNER", trigger: "user" });
    expect(ok.action.status).toBe("succeeded");
    expect(JSON.parse(ok.action.result).service.reopened).toContain("architecture");
    expect((await prisma.mission.findUnique({ where: { id: missionId } }))!.status).toBe("RUNNING");
    // Running again is NOT recovery: the finding stays open until the retried task succeeds.
    await runEvaluation(ws, "manual", { force: true, probe: false });
    expect((await prisma.opsFinding.findUnique({ where: { id: f.id } }))!.status).toBe("OPEN");
    clearFaults(); // the injected tool hang is gone (the "transient" cause cleared)
    await advanceMission(missionId, ws); // architecture re-runs and succeeds
    expect((await prisma.missionTask.findFirst({ where: { missionId, key: "architecture" } }))!.status).toBe("SUCCEEDED");
    await runEvaluation(ws, "manual", { force: true, probe: false });
    const after = (await prisma.opsFinding.findUnique({ where: { id: f.id } }))!;
    expect(after.status).toBe("RESOLVED");
    expect(after.resolvedBy).toBe("rule");
    expect(JSON.parse(after.history).map((h: { change: string }) => h.change)).toEqual(["opened", "action retry_task succeeded", "resolved"]);
    // The blocked attempt is part of the audit trail.
    const acts = await prisma.opsAction.findMany({ where: { findingId: f.id }, orderBy: { createdAt: "asc" } });
    expect(acts.map((a) => `${a.decision}:${a.policyRule}`)).toEqual(["blocked:level_observe", "allowed:user_initiated@recommend"]);
  }, 60_000);

  it("non-transient failures are not offered as runnable retries", async () => {
    const m = await createMission({ companyId: ws, createdById: user, objective: "Inspect the checkout module, identify the cause of a failing validation test, implement a minimal fix." });
    await planMission(m.id, ws);
    await decidePlan(m.id, ws, "approve", "human@test");
    await prisma.missionTask.updateMany({ where: { missionId: m.id, key: "requirements" }, data: { status: "FAILED", errorCategory: "security_policy_violation" } });
    const f = await prisma.opsFinding.create({ data: { companyId: ws, ruleId: "engineering.tests_failing", ruleVersion: 1, dedupeKey: `t2:${m.id}`, category: "engineering", certainty: "confirmed", severity: "high", title: "t", explanation: "e", resourceType: "mission", resourceId: m.id, missionId: m.id } });
    const recs = await recommendationsFor(f);
    expect(recs.find((r) => r.action === "retry_task")!.unavailable).toMatch(/not transient/);
    await prisma.opsFinding.delete({ where: { id: f.id } });
  });

  it("resolves only when the criterion is met, re-opens on recurrence, and a dismissed finding stays dismissed", async () => {
    const m = await createMission({ companyId: ws, createdById: user, objective: "Inspect the checkout module, identify the cause of a failing validation test, implement a minimal fix.", budgetUsd: 1 });
    await planMission(m.id, ws);
    await decidePlan(m.id, ws, "approve", "human@test");
    await prisma.mission.update({ where: { id: m.id }, data: { status: "RUNNING", costUsd: 0.9 } });
    await runEvaluation(ws, "manual", { force: true, probe: false });
    const key = `mission.budget:mission:${m.id}`;
    expect((await prisma.opsFinding.findFirst({ where: { companyId: ws, dedupeKey: key } }))!.status).toBe("OPEN");
    // Still over → still open (no false resolution)
    await runEvaluation(ws, "manual", { force: true, probe: false });
    expect((await prisma.opsFinding.findFirst({ where: { companyId: ws, dedupeKey: key } }))!.status).toBe("OPEN");
    // Budget raised → resolves by rule
    await prisma.mission.update({ where: { id: m.id }, data: { budgetUsd: 5 } });
    await runEvaluation(ws, "manual", { force: true, probe: false });
    const resolved = (await prisma.opsFinding.findFirst({ where: { companyId: ws, dedupeKey: key } }))!;
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedBy).toBe("rule");
    // Recurs → re-opened, same row (no duplicate)
    await prisma.mission.update({ where: { id: m.id }, data: { budgetUsd: 1 } });
    const r = await runEvaluation(ws, "manual", { force: true, probe: false });
    expect(r.reopened).toBe(1);
    expect(await prisma.opsFinding.count({ where: { companyId: ws, dedupeKey: key } })).toBe(1);
    const h = JSON.parse((await prisma.opsFinding.findFirst({ where: { companyId: ws, dedupeKey: key } }))!.history);
    expect(h.map((x: { change: string }) => x.change)).toEqual(["opened", "resolved", "reopened"]);
    // Dismissed stays dismissed while the condition persists
    await prisma.opsFinding.updateMany({ where: { companyId: ws, dedupeKey: key }, data: { status: "DISMISSED" } });
    await runEvaluation(ws, "manual", { force: true, probe: false });
    expect((await prisma.opsFinding.findFirst({ where: { companyId: ws, dedupeKey: key } }))!.status).toBe("DISMISSED");
  }, 60_000);

  it("a real failed staging deploy produces a finding; rollback runs through the real pipeline and the finding resolves", async () => {
    // The simulated pipeline has a small random failure chance; get one real successful baseline first.
    let good = await runDeployment(ws, "staging");
    for (let i = 0; i < 5 && !good.success; i++) good = await runDeployment(ws, "staging");
    expect(good.success).toBe(true);
    const bad = await runDeployment(ws, "staging", { forceFailStage: "TEST" });
    expect(bad.success).toBe(false);
    await runEvaluation(ws, "manual", { force: true, probe: false });
    const f = (await prisma.opsFinding.findFirst({ where: { companyId: ws, dedupeKey: "engineering.deployment_failed:deployment:staging" } }))!;
    expect(f.status).toBe("OPEN");
    const rec = (await recommendationsFor(f)).find((r) => r.action === "rollback_deployment")!;
    expect(rec.unavailable).toBeNull();
    // MEMBER lacks the role; OWNER may run it.
    const denied = await executeAction({ companyId: ws, action: "rollback_deployment", target: rec.target, findingId: f.id, actor: "m@test", role: "MEMBER", trigger: "user" });
    expect(denied.action.policyRule).toBe("role_insufficient");
    const done = await executeAction({ companyId: ws, action: "rollback_deployment", target: rec.target, findingId: f.id, actor: "o@test", role: "OWNER", trigger: "user" });
    const svc = JSON.parse(done.action.result).service;
    expect(done.action.status).toBe("succeeded");
    // The finding resolves only if the real re-run succeeded.
    await runEvaluation(ws, "manual", { force: true, probe: false });
    const after = (await prisma.opsFinding.findFirst({ where: { id: f.id } }))!;
    expect(after.status).toBe(svc.success ? "RESOLVED" : "OPEN");
  }, 60_000);

  it("another workspace cannot act on or read this workspace's findings", async () => {
    const f = (await prisma.opsFinding.findFirst({ where: { companyId: ws } }))!;
    await expect(executeAction({ companyId: otherWs, action: "pause_mission", target: { type: "mission", id: f.missionId ?? "x" }, findingId: f.id, actor: "x", role: "OWNER", trigger: "user" })).rejects.toThrow(/not found/i);
    const b = await buildBriefing(otherWs);
    expect(b.attention.some((x) => x.id === f.id)).toBe(false);
  });
});

describe("monitor", () => {
  it("never runs two evaluations at once (lease) and respects the interval and disable switch", async () => {
    await getMonitor(ws);
    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { leaseOwner: null, leaseExpiresAt: null, lastRunAt: null, intervalSec: 300, enabled: true } });
    expect((await runEvaluation(ws, "scheduled", { probe: false })).ran).toBe(true);
    // A live lease held by another worker blocks every run (manual included) — no overlapping evaluations.
    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { leaseOwner: "other-worker", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    expect((await runEvaluation(ws, "manual", { force: true, probe: false })).reason).toBe("another evaluation is running");
    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { leaseOwner: null, leaseExpiresAt: null } });
    expect((await runEvaluation(ws, "scheduled", { probe: false })).reason).toBe("interval not elapsed");
    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { enabled: false, lastRunAt: null } });
    expect((await runEvaluation(ws, "scheduled", { probe: false })).reason).toBe("monitoring disabled");
    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { enabled: true } });
  }, 60_000);

  it("takes over an expired lease (worker restart)", async () => {
    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { leaseOwner: "dead", leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect((await runEvaluation(ws, "manual", { force: true, probe: false })).ran).toBe(true);
  });

  it("bounded autonomy performs only allow-listed actions once, and records the policy", async () => {
    const m = await createMission({ companyId: ws, createdById: user, objective: "Inspect the checkout module, identify the cause of a failing validation test, implement a minimal fix.", budgetUsd: 1 });
    await planMission(m.id, ws);
    await decidePlan(m.id, ws, "approve", "human@test");
    await prisma.mission.update({ where: { id: m.id }, data: { status: "RUNNING", costUsd: 0.95 } });
    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { policyLevel: "BOUNDED", allowedAutoActions: JSON.stringify(["pause_mission"]) } });
    const r = await runEvaluation(ws, "manual", { force: true, probe: false });
    expect(r.autoActions).toBeGreaterThanOrEqual(1);
    const act = await prisma.opsAction.findFirst({ where: { companyId: ws, trigger: "automatic", actionType: "pause_mission", target: { contains: m.id } } });
    expect(act!.policyRule).toBe("auto_allowlisted@bounded");
    expect(act!.status).toBe("succeeded");
    const mm = (await prisma.mission.findUnique({ where: { id: m.id } }))!;
    expect(mm.status).toBe("PAUSED");
    expect(mm.operatorHold).toBe(true);
    await runEvaluation(ws, "manual", { force: true, probe: false });
    expect(await prisma.opsAction.count({ where: { companyId: ws, trigger: "automatic", target: { contains: m.id } } })).toBe(1); // not repeated
    await prisma.opsMonitor.update({ where: { companyId: ws }, data: { policyLevel: "RECOMMEND", allowedAutoActions: "[]" } });
  }, 60_000);
});

describe("briefing", () => {
  it("prioritizes confirmed, human-blocking issues over suspicions of the same severity", () => {
    const now = new Date();
    const confirmed = prioritize({ severity: "high", certainty: "confirmed", requiresHuman: true, lastObservedAt: now, status: "OPEN" }, now).score;
    const suspicion = prioritize({ severity: "high", certainty: "suspicion", requiresHuman: false, lastObservedAt: now, status: "OPEN" }, now).score;
    const ackd = prioritize({ severity: "high", certainty: "confirmed", requiresHuman: true, lastObservedAt: now, status: "ACKNOWLEDGED" }, now).score;
    expect(confirmed).toBeGreaterThan(ackd);
    expect(ackd).toBeGreaterThan(suspicion);
  });

  it("without a model the summary is the deterministic one, and no model call is made", async () => {
    const before = await prisma.agentRun.count({ where: { companyId: ws } });
    const r = await aiSummary(ws);
    expect(r.mode).toBe("deterministic");
    expect(await prisma.agentRun.count({ where: { companyId: ws } })).toBe(before);
  });
});
