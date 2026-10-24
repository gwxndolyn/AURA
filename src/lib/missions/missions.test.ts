/**
 * Mission engine tests against the REAL Prisma DB, real agent runtime
 * (simulator when no API key), real permission checks and — when Docker is
 * running — the real sandbox. Sandbox-dependent assertions are explicit about
 * which mode they ran in; nothing is mocked to make tests pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { dockerAvailable } from "@/lib/sandbox/runner";
import { canMission, canTask } from "./state";
import { findCycle, eligible, blockedByFailure, levels } from "./graph";
import { checkoutFixPlan, validatePlan, genericPlan } from "./planner";
import { lineDiff } from "./diff";
import { createMission, planMission, decidePlan, advanceMission, runUntilBlocked, decideApproval, cancelMission, MissionError } from "./engine";
import { buildReport } from "./report";

let userA: string, userB: string, wsA: string, wsB: string;
let docker = false;

beforeAll(async () => {
  docker = await dockerAvailable();
  const a = await prisma.user.create({ data: { email: `ma_${Date.now()}@t.local`, name: "A" } });
  const b = await prisma.user.create({ data: { email: `mb_${Date.now()}@t.local`, name: "B" } });
  userA = a.id;
  userB = b.id;
  wsA = (await createCompany({ name: "MISSION-A", mission: "m", industry: "SaaS", ownerId: userA })).id;
  wsB = (await createCompany({ name: "MISSION-B", mission: "m", industry: "SaaS", ownerId: userB })).id;
}, 60_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await prisma.$disconnect();
});

describe("state machine", () => {
  it("allows the documented path and rejects skips", () => {
    expect(canMission("DRAFT", "PLANNING")).toBe(true);
    expect(canMission("AWAITING_APPROVAL", "READY")).toBe(true);
    expect(canMission("DRAFT", "RUNNING")).toBe(false);
    expect(canMission("COMPLETED", "RUNNING")).toBe(false);
    expect(canMission("RUNNING", "COMPLETED")).toBe(true);
    expect(canTask("PENDING", "SUCCEEDED")).toBe(false);
    expect(canTask("RUNNING", "WAITING_APPROVAL")).toBe(true);
    expect(canTask("SKIPPED", "READY")).toBe(false);
  });
});

describe("dependency graph", () => {
  const t = (key: string, dependsOn: string[], status = "PENDING") => ({ key, dependsOn, status });
  it("detects cycles and unknown dependencies", () => {
    expect(findCycle([t("a", ["b"]), t("b", ["a"])])).not.toBeNull();
    expect(findCycle([t("a", ["zzz"])])?.join()).toMatch(/unknown/);
    expect(findCycle([t("a", []), t("b", ["a"])])).toBeNull();
  });
  it("only schedules tasks whose dependencies succeeded; propagates failure", () => {
    const g = [t("a", [], "SUCCEEDED"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])];
    expect(eligible(g).sort()).toEqual(["b", "c"]);
    expect(blockedByFailure([t("a", [], "FAILED"), t("b", ["a"]), t("c", ["b"])]).sort()).toEqual(["b", "c"]);
  });
  it("groups parallel work into levels", () => {
    expect(levels([t("a", []), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])])).toEqual([["a"], ["b", "c"], ["d"]]);
  });
});

describe("planner validation", () => {
  it("accepts the showcase plan", () => {
    expect(validatePlan(checkoutFixPlan())).toEqual({ ok: true, errors: [] });
  });
  it("rejects a plan that grants an agent a tool outside its allowlist", () => {
    const p = checkoutFixPlan();
    p.tasks.find((x) => x.key === "fix")!.tools.push("deploy.run");
    const v = validatePlan(p);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/not permitted to use deploy\.run/);
  });
  it("rejects a code change with no verification step", () => {
    const p = checkoutFixPlan();
    p.tasks = p.tasks.filter((x) => x.key !== "verify").map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== "verify") }));
    expect(validatePlan(p).errors.join()).toMatch(/no TEST task/);
  });
  it("generic plans contain no unverifiable code tasks", () => {
    expect(genericPlan("Improve onboarding copy", "summary").tasks.some((x) => x.kind === "CODE_CHANGE")).toBe(false);
  });
});

describe("diff", () => {
  it("counts added and removed lines", () => {
    const d = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.text).toContain("- b");
  });
});

describe("checkout-fix mission end-to-end", () => {
  let missionId: string;

  it("creates a draft and plans it; nothing runs before approval", async () => {
    const m = await createMission({ companyId: wsA, createdById: userA, objective: "Investigate the failing checkout flow: a customer was undercharged by a cent. Fix it and prepare for approval.", source: "EXAMPLE" });
    missionId = m.id;
    expect(m.template).toBe("checkout-fix");
    await planMission(m.id, wsA);
    const after = await prisma.mission.findUnique({ where: { id: m.id } });
    expect(after!.status).toBe("AWAITING_APPROVAL");
    expect(after!.planVersion).toBe(1);
    const r = await advanceMission(m.id, wsA);
    expect(r.progressed).toBe(false);
    expect(r.waitingOn).toBe("plan approval");
    expect(await prisma.missionTask.count({ where: { missionId: m.id, status: { not: "PENDING" } } })).toBe(0);
  }, 60_000);

  it("another workspace cannot see or drive the mission", async () => {
    await expect(advanceMission(missionId, wsB)).rejects.toThrow(/not found/);
    await expect(decidePlan(missionId, wsB, "approve", userB)).rejects.toThrow(/not found/);
    expect(await buildReport(missionId, wsB)).toBeNull();
  });

  it("runs through real execution until the human approval gate", async () => {
    await decidePlan(missionId, wsA, "approve", userA);
    const r = await runUntilBlocked(missionId, wsA, 30);
    const tasks = await prisma.missionTask.findMany({ where: { missionId }, orderBy: { createdAt: "asc" } });
    const by = Object.fromEntries(tasks.map((t) => [t.key, t]));
    if (!docker) {
      // Without Docker, tests cannot run: reproduction must FAIL as unverified, never pretend to pass.
      expect(by.reproduce.status).toBe("FAILED");
      expect(by.reproduce.verification).toBe("UNVERIFIED");
      expect(r.status).toBe("FAILED");
      return;
    }
    expect(r.status).toBe("PAUSED");
    expect(by.requirements.status).toBe("SUCCEEDED");
    expect(by.architecture.status).toBe("SUCCEEDED");
    expect(by.review.status).toBe("SUCCEEDED");
    expect(by.reproduce.status).toBe("SUCCEEDED");
    expect(by.reproduce.output).toMatch(/tests fail on current code/);
    // Bounded repair: attempt 1 (partial) fails one test, attempt 2 passes.
    expect(await prisma.missionTaskRun.count({ where: { missionId, taskKey: "fix" } })).toBe(2);
    expect((await prisma.mission.findUnique({ where: { id: missionId } }))!.repairRounds).toBe(1);
    expect(by.verify.status).toBe("SUCCEEDED");
    expect(by.verify.verification).toBe("PASSED");
    expect(by["security-review"].status).toBe("SUCCEEDED");
    expect(by["approve-release"].status).toBe("WAITING_APPROVAL");
    expect(by.report.status).toBe("PENDING");
    const reports = await prisma.missionArtifact.findMany({ where: { missionId, kind: "TEST_REPORT" }, orderBy: { createdAt: "asc" } });
    const metas = reports.map((a) => JSON.parse(a.meta));
    expect(metas.every((x) => x.mode === "docker")).toBe(true);
    expect(metas[0].failed).toBeGreaterThan(0); // reproduce: real failures
    expect(metas[metas.length - 1].failed).toBe(0); // final verify: real pass
    expect(metas.some((x, i) => i > 0 && i < metas.length - 1 && x.failed > 0)).toBe(true); // failed repair attempt recorded
  }, 180_000);

  it("approval rejects a change that differs from what was reviewed", async () => {
    if (!docker) return;
    const approval = await prisma.missionApproval.findFirst({ where: { missionId, status: "PENDING" } });
    const file = await prisma.missionArtifact.findFirst({ where: { missionId, kind: "FILE" }, orderBy: { version: "desc" } });
    // Tamper: record a newer version of the file after review.
    await prisma.missionArtifact.create({ data: { missionId, companyId: wsA, kind: "FILE", name: file!.name, version: file!.version + 1, content: file!.content + "\n// unreviewed edit\n" } });
    await expect(decideApproval(approval!.id, wsA, "approve", userA)).rejects.toThrow(/modified after this approval/);
    expect((await prisma.missionApproval.findUnique({ where: { id: approval!.id } }))!.status).toBe("CANCELLED");
  }, 60_000);

  it("report reflects persisted results and keeps verified ≠ approved ≠ deployed", async () => {
    if (!docker) return;
    const rep = (await buildReport(missionId, wsA))!;
    expect(rep.finalTest?.mode).toBe("docker");
    expect(rep.finalTest?.failed).toBe(0);
    expect(rep.ledger.deployed).toBe(0);
    expect(rep.ledger.humanApproved).toBe(0);
    expect(rep.criteria.find((c) => /human approves/i.test(c.text))!.status).not.toBe("met");
    expect(rep.criteria.find((c) => /tests pass/i.test(c.text))!.status).toBe("met");
    expect(rep.repair.fixAttempts).toBe(2);
  });
});

describe("approval → completion, rejection, cancellation, recovery", () => {
  async function toGate() {
    const m = await createMission({ companyId: wsA, createdById: userA, objective: "Fix the checkout rounding bug that undercharges customers by one cent." });
    await planMission(m.id, wsA);
    await decidePlan(m.id, wsA, "approve", userA);
    await runUntilBlocked(m.id, wsA, 30);
    return m.id;
  }

  it("approving the exact tested diff completes the mission", async () => {
    if (!docker) return;
    const id = await toGate();
    const a = await prisma.missionApproval.findFirst({ where: { missionId: id, status: "PENDING" } });
    await decideApproval(a!.id, wsA, "approve", userA, "reviewed diff");
    const r = await runUntilBlocked(id, wsA, 5);
    expect(r.status).toBe("COMPLETED");
    const rep = (await buildReport(id, wsA))!;
    expect(rep.ledger.humanApproved).toBe(1);
    expect(rep.criteria.every((c) => c.status === "met")).toBe(true);
    await expect(decideApproval(a!.id, wsA, "approve", userA)).rejects.toThrow(/already approved/);
  }, 180_000);

  it("rejecting the gate fails the mission and skips downstream work", async () => {
    if (!docker) return;
    const id = await toGate();
    const a = await prisma.missionApproval.findFirst({ where: { missionId: id, status: "PENDING" } });
    await decideApproval(a!.id, wsA, "reject", userA, "needs product sign-off");
    const r = await runUntilBlocked(id, wsA, 5);
    expect(r.status).toBe("FAILED");
    expect((await prisma.missionTask.findFirst({ where: { missionId: id, key: "report" } }))!.status).toBe("SKIPPED");
  }, 180_000);

  it("cancellation stops all scheduling", async () => {
    const m = await createMission({ companyId: wsA, createdById: userA, objective: "Fix the checkout rounding bug that undercharges customers by one cent." });
    await planMission(m.id, wsA);
    await decidePlan(m.id, wsA, "approve", userA);
    await advanceMission(m.id, wsA); // one task
    await cancelMission(m.id, wsA, userA);
    const r = await advanceMission(m.id, wsA);
    expect(r.status).toBe("CANCELLED");
    expect(r.progressed).toBe(false);
    expect(await prisma.missionTask.count({ where: { missionId: m.id, status: { in: ["PENDING", "READY", "RUNNING"] } } })).toBe(0);
    await expect(cancelMission(m.id, wsA, userA)).rejects.toBeInstanceOf(MissionError);
  }, 60_000);

  it("recovers a task whose worker died (expired lease) instead of losing it", async () => {
    const m = await createMission({ companyId: wsA, createdById: userA, objective: "Review the architecture of the notification service for scaling risks." });
    await planMission(m.id, wsA);
    await decidePlan(m.id, wsA, "approve", userA);
    await prisma.mission.update({ where: { id: m.id }, data: { status: "RUNNING", startedAt: new Date() } });
    // Simulate a crashed worker: task left RUNNING with an expired lease.
    await prisma.missionTask.updateMany({ where: { missionId: m.id, key: "analyze" }, data: { status: "RUNNING", leaseOwner: "dead-worker", leaseExpiresAt: new Date(Date.now() - 1000), attempts: 1 } });
    const r = await runUntilBlocked(m.id, wsA, 10);
    expect(r.status).toBe("COMPLETED");
    const t = await prisma.missionTask.findFirst({ where: { missionId: m.id, key: "analyze" } });
    expect(t!.status).toBe("SUCCEEDED");
    expect(t!.output).toMatch(/Recovered after an interrupted run/);
  }, 60_000);

  it("only one concurrent worker wins a task lease", async () => {
    const m = await createMission({ companyId: wsA, createdById: userA, objective: "Review the architecture of the notification service for scaling risks." });
    await planMission(m.id, wsA);
    await decidePlan(m.id, wsA, "approve", userA);
    const [a, b] = await Promise.all([advanceMission(m.id, wsA, "w1"), advanceMission(m.id, wsA, "w2")]);
    const ran = [a, b].filter((x) => x.task).length;
    expect(ran).toBeLessThanOrEqual(1);
    const t = await prisma.missionTask.findFirst({ where: { missionId: m.id, key: "analyze" } });
    expect(t!.attempts).toBe(1); // executed exactly once
  }, 60_000);

  it("budget exhaustion stops further work", async () => {
    const m = await createMission({ companyId: wsA, createdById: userA, objective: "Review the architecture of the notification service for scaling risks." });
    await planMission(m.id, wsA);
    await decidePlan(m.id, wsA, "approve", userA);
    await prisma.mission.update({ where: { id: m.id }, data: { costUsd: 5, budgetUsd: 1 } });
    const r = await advanceMission(m.id, wsA);
    expect(r.status).toBe("FAILED");
    expect((await prisma.mission.findUnique({ where: { id: m.id } }))!.statusReason).toMatch(/budget/);
  }, 60_000);
});
