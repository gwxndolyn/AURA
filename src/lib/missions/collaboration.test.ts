/**
 * Multi-agent collaboration + adversarial failure tests.
 *
 * Real Prisma DB, real agent runtime (simulator when no API key), real tool
 * runner + permission checks, real Docker sandbox (tests that need it say so
 * and assert the honest "unverified" path when Docker is down). Faults are
 * injected through src/lib/missions/faults.ts (test-only) — validation and
 * authorization are never weakened to make a test pass.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { dockerAvailable } from "@/lib/sandbox/runner";
import { callTool, ToolError } from "@/lib/agents/tools";
import { validateRegistry, assignAgent, AssignmentError, capabilityFor } from "@/lib/agents/capabilities";
import { validateOutput, validateHandoff, extractJson } from "@/lib/agents/contracts";
import { permissionsFor } from "@/lib/agents/permissions";
import { createMission, planMission, decidePlan, advanceMission, runUntilBlocked, cancelMission, decideApproval } from "./engine";
import { engineeringPlan, validatePlan } from "./planner";
import { fitToBudget, ContextOverflowError, type ContextSource } from "./context";
import { injectFault, clearFaults } from "./faults";
import { buildReport } from "./report";
import { VALIDATION_FIXTURE } from "./repos";

const SCENARIO = "Inspect the checkout module, identify the cause of a failing validation test, implement a minimal fix, run the relevant tests, and explain the result.";

let user: string, ws: string, other: string, otherWs: string;
let docker = false;

beforeAll(async () => {
  docker = await dockerAvailable();
  const stamp = Date.now();
  user = (await prisma.user.create({ data: { email: `collab_${stamp}@t.local`, name: "C" } })).id;
  other = (await prisma.user.create({ data: { email: `collab_o_${stamp}@t.local`, name: "O" } })).id;
  ws = (await createCompany({ name: "COLLAB", mission: "m", industry: "SaaS", ownerId: user })).id;
  otherWs = (await createCompany({ name: "COLLAB-OTHER", mission: "m", industry: "SaaS", ownerId: other })).id;
}, 60_000);

afterEach(() => clearFaults());

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await prisma.user.deleteMany({ where: { id: { in: [user, other] } } });
  await prisma.$disconnect();
});

async function planned(objective = SCENARIO, extra: Parameters<typeof createMission>[0] extends infer A ? Partial<A> : never = {}) {
  const m = await createMission({ companyId: ws, createdById: user, objective, ...extra });
  await planMission(m.id, ws);
  await decidePlan(m.id, ws, "approve", "human@test");
  return m.id;
}
const runOf = (missionId: string, taskKey: string) => prisma.missionTaskRun.findMany({ where: { missionId, taskKey }, orderBy: { startedAt: "asc" } });
const taskOf = (missionId: string, key: string) => prisma.missionTask.findFirst({ where: { missionId, key } });

// ---------------------------------------------------------------------------
describe("capability registry + contracts", () => {
  it("registry is internally consistent and never widens role permissions", () => {
    expect(validateRegistry()).toEqual([]);
    for (const k of ["product-manager", "architect", "backend-engineer", "qa-engineer", "reviewer", "security-engineer", "devops"]) {
      const cap = capabilityFor(k)!;
      for (const t of cap.tools) expect(permissionsFor(k)).toContain(t);
    }
  });

  it("agents are meaningfully different: kinds, tools, writes, verification", () => {
    const qa = capabilityFor("qa-engineer")!, rev = capabilityFor("reviewer")!, be = capabilityFor("backend-engineer")!;
    expect(qa.canWriteCode || rev.canWriteCode).toBe(false);
    expect(be.canWriteCode).toBe(true);
    expect(rev.verification).toContain("probe-evidence");
    expect(qa.verification).toContain("sandbox-tests");
    expect(new Set([qa, rev, be].map((c) => c.taskKinds.join()))).toHaveProperty("size", 3);
  });

  it("delegation picks by capability, and fails with reasons when nobody fits", () => {
    expect(assignAgent({ key: "x", kind: "CODE_CHANGE", domain: "backend", tools: ["code.write"], writes: true }).agentKey).toBe("backend-engineer");
    expect(assignAgent({ key: "x", kind: "CODE_CHANGE", domain: "frontend", tools: ["code.write"], writes: true }).agentKey).toBe("frontend-engineer");
    expect(assignAgent({ key: "x", kind: "REVIEW", domain: "backend", tools: ["sandbox.exec"], writes: false }).agentKey).toBe("reviewer");
    expect(() => assignAgent({ key: "x", kind: "CODE_CHANGE", domain: "backend", tools: ["deploy.run"], writes: true })).toThrow(AssignmentError);
    expect(() => assignAgent({ key: "x", kind: "TRANSLATE", tools: [], writes: false })).toThrow(/no agent handles TRANSLATE/);
    // Independence: the reviewer can never be the implementer.
    expect(() => assignAgent({ key: "x", kind: "REVIEW", domain: "backend", tools: [], writes: false, excludeAgents: ["reviewer"] })).toThrow(AssignmentError);
  });

  it("validates structured outputs and rejects malformed ones", () => {
    expect(validateOutput("REVIEW", { verdict: "approve" }).ok).toBe(false);
    expect(validateOutput("NOPE", {}).ok).toBe(false);
    expect(extractJson("Sure: {affectedFiles: [src")).toBeNull();
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("rejects an incomplete handoff", () => {
    const v = validateHandoff({ missionId: "m", taskKey: "fix", fromAgent: "backend-engineer" });
    expect(v.ok).toBe(false);
  });
});

describe("plan validation (risk, independence, conflicts, cycles)", () => {
  it("composes the workflow by risk", () => {
    const keys = (r: "LOW" | "MEDIUM" | "HIGH") => engineeringPlan("checkout-validation", { risk: r }).tasks.map((t) => t.key);
    expect(keys("LOW")).not.toContain("security-review");
    expect(keys("MEDIUM")).toContain("security-review");
    expect(keys("MEDIUM")).not.toContain("approve-release");
    expect(keys("HIGH")).toEqual(expect.arrayContaining(["security-review", "approve-release"]));
    for (const r of ["LOW", "MEDIUM", "HIGH"] as const) expect(validatePlan(engineeringPlan("checkout-validation", { risk: r }))).toEqual({ ok: true, errors: [] });
  });

  it("rejects a dependency cycle before execution", () => {
    const p = engineeringPlan("checkout-validation");
    p.tasks.find((t) => t.key === "requirements")!.dependsOn = ["review"];
    expect(validatePlan(p).errors.join()).toMatch(/dependency cycle/);
  });

  it("rejects two concurrently-runnable tasks writing the same file", () => {
    const p = engineeringPlan("checkout-validation");
    const fix = p.tasks.find((t) => t.key === "fix")!;
    p.tasks.push({ ...fix, key: "fix-two", dependsOn: ["architecture"], title: "Parallel fix" });
    p.tasks.find((t) => t.key === "verify")!.dependsOn.push("fix-two");
    expect(validatePlan(p).errors.join()).toMatch(/may run concurrently and both write src\/checkout\/validation\.js/);
  });

  it("rejects self-review and agents assigned a kind they cannot own", () => {
    const p = engineeringPlan("checkout-validation");
    p.tasks.find((t) => t.key === "review")!.agentKey = "backend-engineer";
    const errs = validatePlan(p).errors.join();
    expect(errs).toMatch(/backend-engineer cannot perform REVIEW/);
    expect(errs).toMatch(/cannot review its own change/);
  });
});

describe("context assembly", () => {
  const src = (id: string, kind: ContextSource["kind"], chars: number, required: boolean, truncatable = true, priority = 5): ContextSource => ({ id, kind, ref: id, text: "x".repeat(chars), required, truncatable, priority });

  it("omits optional sources first and records it", () => {
    const r = fitToBudget([src("task", "task", 400, true, false, 0), src("hist", "attempts", 4000, false)], 300);
    expect(r.provenance.find((p) => p.id === "hist")!.included).toBe(false);
    expect(r.notes.join()).toMatch(/Omitted optional attempts/);
  });

  it("never silently drops required context: truncates truncatable sources with a note, or fails", () => {
    const ok = fitToBudget([src("task", "task", 400, true, false, 0), src("code", "code", 2000, true, true)], 400);
    expect(ok.provenance.find((p) => p.id === "code")!.truncated).toBe(true);
    expect(ok.notes.join()).toMatch(/Truncated required code/);
    expect(() => fitToBudget([src("task", "task", 4000, true, false, 0)], 100)).toThrow(ContextOverflowError);
  });
});

describe("tool runner enforcement", () => {
  let runId: string;
  beforeAll(async () => {
    const agent = await prisma.agent.findFirst({ where: { companyId: ws, key: "backend-engineer" } });
    runId = (await prisma.agentRun.create({ data: { companyId: ws, agentId: agent!.id, objective: "tool test", model: "none", tier: "NONE", status: "COMPLETED" } })).id;
  });
  const ctx = (extra = {}) => ({ companyId: ws, agentKey: "backend-engineer", runId, writeScope: ["src/checkout/validation.js"], ...extra });

  it("rejects malformed arguments before running the tool", async () => {
    let ran = false;
    await expect(callTool(ctx(), "code.write", { path: "../../etc/passwd", change: "x" }, async () => ((ran = true), { path: "x", bytes: 1 }))).rejects.toMatchObject({ code: "invalid_args" });
    expect(ran).toBe(false);
  });

  it("refuses a write outside the task's write scope", async () => {
    await expect(callTool(ctx(), "code.write", { path: "src/checkout/checkout.js", change: "x" }, async () => ({ path: "x", bytes: 1 }))).rejects.toMatchObject({ code: "out_of_scope" });
  });

  it("times out a hung tool and records it", async () => {
    await expect(callTool(ctx({ timeoutMs: 30 }), "code.read", { path: "src/checkout/validation.js" }, () => new Promise(() => {}))).rejects.toMatchObject({ code: "timeout" });
    const last = await prisma.toolCall.findFirst({ where: { runId }, orderBy: { createdAt: "desc" } });
    expect(last!.status).toBe("timeout");
  });

  it("rejects a malformed tool result", async () => {
    await expect(callTool(ctx(), "code.read", { path: "src/checkout/validation.js" }, async () => "<<garbage>>" as never)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("requires an approved human approval for consequential actions", async () => {
    await expect(callTool({ companyId: ws, agentKey: "devops", runId }, "deploy.run", { env: "production" }, async () => "deployed")).rejects.toMatchObject({ code: "approval_required" });
  });

  it("records a tool error as a classified failure", async () => {
    const e = await callTool(ctx(), "code.read", { path: "src/checkout/validation.js" }, async () => {
      throw new Error("disk on fire");
    }).catch((x) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).category).toBe("tool_execution_error");
  });
});

// ---------------------------------------------------------------------------
describe("acceptance scenario: failing validation test → fix → QA → review → repair → report", () => {
  let id: string;
  it("plans with capability-assigned agents and measurable criteria", async () => {
    const m = await createMission({ companyId: ws, createdById: user, objective: SCENARIO });
    id = m.id;
    expect(m.template).toBe("checkout-validation");
    await planMission(id, ws);
    const tasks = await prisma.missionTask.findMany({ where: { missionId: id } });
    const by = Object.fromEntries(tasks.map((t) => [t.key, t]));
    expect(by.fix.agentKey).toBe("backend-engineer");
    expect(by.verify.agentKey).toBe("qa-engineer");
    expect(by.review.agentKey).toBe("reviewer");
    expect(by.review.assignmentReason).toMatch(/reviewer handles REVIEW/);
    expect(JSON.parse(by.fix.files)).toEqual(["src/checkout/validation.js"]);
    expect(JSON.parse((await prisma.mission.findUnique({ where: { id } }))!.acceptance).join()).toMatch(/failing validation test passes/);
  });

  it("executes through real tools; the reviewer finds a real defect; one bounded repair resolves it", async () => {
    await decidePlan(id, ws, "approve", "human@test");
    const r = await runUntilBlocked(id, ws, 40);
    if (!docker) {
      expect(r.status).toBe("FAILED");
      expect((await taskOf(id, "reproduce"))!.verification).toBe("UNVERIFIED");
      return;
    }
    expect(r.status).toBe("COMPLETED");

    // Reproduce: the real suite fails on the original code.
    const repro = (await runOf(id, "reproduce"))[0];
    expect(JSON.parse(repro.output).tests.failing.join()).toMatch(/rejects a zero quantity/);

    // Fix #1 makes the test pass (QA verifies it) — but the reviewer's executed probes find it incomplete.
    const fixes = await runOf(id, "fix");
    const verifies = await runOf(id, "verify");
    const reviews = await runOf(id, "review");
    expect(fixes).toHaveLength(2);
    expect(JSON.parse(verifies[0].output).tests.mode).toBe("docker");
    expect(JSON.parse(verifies[0].output).passed).toBe(true);
    expect(reviews[0].outcome).toBe("changes_requested");
    const findings = await prisma.missionFinding.findMany({ where: { missionId: id }, orderBy: { createdAt: "asc" } });
    const supported = findings.filter((f) => f.supported);
    expect(supported.length).toBeGreaterThan(0);
    expect(supported.every((f) => JSON.parse(f.evidence).artifactId)).toBe(true);
    // Unsupported concerns are recorded but never block.
    const unsupported = findings.filter((f) => !f.supported);
    expect(unsupported.length).toBeGreaterThan(0);
    expect(unsupported.every((f) => !f.blocking && f.status === "UNSUPPORTED")).toBe(true);

    // The repair references the findings it addresses; re-verification resolves them on the new code only.
    expect(JSON.parse(fixes[1].output).addressesFindings).toEqual(expect.arrayContaining(supported.map((f) => f.code)));
    expect(supported.every((f) => f.status === "RESOLVED" && f.addressedByRunId === fixes[1].id && f.resolvedByRunId === reviews[1].id)).toBe(true);
    expect(reviews[1].outcome).toBe("approved");
    expect((await prisma.missionArtifact.findFirst({ where: { missionId: id, kind: "FILE" }, orderBy: { version: "desc" } }))!.content).toBe(VALIDATION_FIXTURE.FIXED);

    // Every downstream task consumed a validated handoff; every run recorded context provenance + usage.
    const handoffs = await prisma.missionHandoff.findMany({ where: { missionId: id } });
    expect(handoffs.length).toBeGreaterThanOrEqual(8);
    expect(handoffs.every((h) => h.valid)).toBe(true);
    const runs = await prisma.missionTaskRun.findMany({ where: { missionId: id } });
    expect(runs.every((x) => x.outputValid)).toBe(true);
    expect(runs.every((x) => JSON.parse(x.contextSources).some((s: { kind: string; included: boolean }) => s.kind === "task" && s.included))).toBe(true);
    const fixCtx = JSON.parse(fixes[1].contextSources) as { kind: string; included: boolean }[];
    expect(fixCtx.some((s) => s.kind === "findings" && s.included)).toBe(true);
    expect(runs.filter((x) => x.modelCalls > 0).every((x) => x.tokensIn > 0 && x.usageEstimated === (x.mode !== "live"))).toBe(true);

    // Report reflects persisted evidence.
    const rep = (await buildReport(id, ws))!;
    expect(rep.criteria.every((c) => c.status === "met")).toBe(true);
    expect(rep.repair.repairRounds).toBe(1);
    expect(rep.finalTest!.mode).toBe("docker");
  }, 240_000);

  it("another workspace cannot read or drive it", async () => {
    await expect(advanceMission(id, otherWs)).rejects.toThrow(/not found/);
    expect(await buildReport(id, otherWs)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("failure modes fail safely and keep history", () => {
  it("malformed structured output: retried within policy, then fails as invalid_structured_output", async () => {
    const id = await planned();
    injectFault(id, "requirements", { point: "model", mode: "malformed", times: 5 });
    const r = await runUntilBlocked(id, ws, 5);
    expect(r.status).toBe("FAILED");
    const [run] = await runOf(id, "requirements");
    expect(run.errorCategory).toBe("invalid_structured_output");
    expect(run.retries).toBe(1); // product-manager policy: 2 attempts
    expect(run.outputValid).toBe(false);
    expect((await taskOf(id, "architecture"))!.status).toBe("SKIPPED");
    expect(await prisma.missionHandoff.count({ where: { missionId: id, fromTaskKey: "requirements" } })).toBe(0);
  }, 60_000);

  it("a transient malformed output recovers on retry", async () => {
    const id = await planned();
    injectFault(id, "requirements", { point: "model", mode: "malformed", times: 1 });
    await advanceMission(id, ws);
    const [run] = await runOf(id, "requirements");
    expect(run.status).toBe("SUCCEEDED");
    expect(run.retries).toBe(1);
    expect(JSON.parse(run.toolLog).some((l: { status: string }) => l.status === "retrying")).toBe(true);
  }, 60_000);

  it("an unexpected response shape is rejected by the contract", async () => {
    const id = await planned();
    injectFault(id, "requirements", { point: "model", mode: "unexpected", times: 5 });
    await runUntilBlocked(id, ws, 3);
    const [run] = await runOf(id, "requirements");
    expect(run.errorCategory).toBe("invalid_structured_output");
    expect(JSON.parse(run.validationErrors).join()).toMatch(/requirements/);
  }, 60_000);

  it("a refusal is classified and not retried", async () => {
    const id = await planned();
    injectFault(id, "requirements", { point: "model", mode: "refusal", times: 5 });
    await runUntilBlocked(id, ws, 3);
    const [run] = await runOf(id, "requirements");
    expect(run.errorCategory).toBe("model_refusal");
    expect(run.retries).toBe(0);
  }, 60_000);

  it("a tool timeout is retried per policy then recorded as tool_timeout", async () => {
    const id = await planned();
    await advanceMission(id, ws); // requirements
    injectFault(id, "architecture", { point: "tool", tool: "code.read", mode: "timeout", times: 5 });
    await advanceMission(id, ws);
    const [run] = await runOf(id, "architecture");
    expect(run.errorCategory).toBe("tool_timeout");
    expect(run.retries).toBe(1);
    expect((await taskOf(id, "architecture"))!.status).toBe("FAILED");
  }, 60_000);

  it("a tool error is recorded as tool_execution_error", async () => {
    const id = await planned();
    await advanceMission(id, ws);
    injectFault(id, "architecture", { point: "tool", tool: "code.read", mode: "error", times: 5 });
    await advanceMission(id, ws);
    expect((await runOf(id, "architecture"))[0].errorCategory).toBe("tool_execution_error");
  }, 60_000);

  it("an incomplete handoff blocks the dependent task (no silent default)", async () => {
    const id = await planned();
    await advanceMission(id, ws); // requirements → handoff
    // Corrupt the handoff the architect depends on.
    await prisma.missionHandoff.updateMany({ where: { missionId: id, fromTaskKey: "requirements" }, data: { valid: false } });
    await advanceMission(id, ws);
    const [run] = await runOf(id, "architecture");
    expect(run.errorCategory).toBe("agent_handoff_failure");
    expect(run.error).toMatch(/handoffs/);
  }, 60_000);

  it("two writers of the same file never run at once (file lock)", async () => {
    const id = await planned();
    // A lock held by another task on the fix task's file blocks claiming it.
    await runUntilBlocked(id, ws, 3); // requirements, architecture, reproduce
    await prisma.missionLock.create({ data: { missionId: id, companyId: ws, path: "src/checkout/validation.js", taskKey: "other-writer", owner: "w-x", expiresAt: new Date(Date.now() + 60_000) } });
    const r = await advanceMission(id, ws);
    expect(r.note).toMatch(/file lock/);
    expect((await taskOf(id, "fix"))!.status).toBe("READY");
    await prisma.missionLock.deleteMany({ where: { missionId: id } });
  }, 120_000);

  it("a repair attempt that changes nothing fails instead of looping", async () => {
    if (!docker) return;
    const id = await planned();
    await runUntilBlocked(id, ws, 6); // through review → repair round scheduled
    injectFault(id, "fix", { point: "candidate", code: VALIDATION_FIXTURE.MINIMAL });
    await runUntilBlocked(id, ws, 3);
    const fixes = await runOf(id, "fix");
    expect(fixes[fixes.length - 1].errorCategory).toBe("code_generation_failure");
    expect((await prisma.mission.findUnique({ where: { id } }))!.status).toBe("FAILED");
  }, 240_000);

  it("the repair limit is enforced: findings become UNRESOLVED and the mission fails", async () => {
    if (!docker) return;
    const id = await planned(SCENARIO, { maxRepairs: 0 });
    const r = await runUntilBlocked(id, ws, 40);
    expect(r.status).toBe("FAILED");
    const review = await taskOf(id, "review");
    expect(review!.output).toMatch(/repair limit reached/);
    expect(await prisma.missionFinding.count({ where: { missionId: id, status: "UNRESOLVED" } })).toBeGreaterThan(0);
    const rep = (await buildReport(id, ws))!;
    expect(rep.criteria.find((c) => /independent review/i.test(c.text))!.status).toBe("not met");
    expect(rep.unresolved.join()).toMatch(/unresolved/);
  }, 240_000);

  it("mission budget exhausted at a step boundary: no task runs, the reason says what remains", async () => {
    const id = await planned(SCENARIO, { budgetUsd: 0.0001 }); // planning alone costs more than this
    const r = await runUntilBlocked(id, ws, 10);
    expect(r.status).toBe("FAILED");
    expect(r.note).toBe("budget");
    expect((await prisma.mission.findUnique({ where: { id } }))!.statusReason).toMatch(/budget exhausted.*remaining tasks were not run/);
    expect(await prisma.missionTaskRun.count({ where: { missionId: id } })).toBe(0);
    expect(await prisma.missionTask.count({ where: { missionId: id, status: "SKIPPED" } })).toBe(await prisma.missionTask.count({ where: { missionId: id } }));
  }, 60_000);

  it("mission budget exhausted mid-step: the retry is refused before calling the model again", async () => {
    const id = await planned();
    const { costUsd } = (await prisma.mission.findUnique({ where: { id } }))!;
    // First model call returns junk (retryable); the hook then exhausts the budget, so the retry must be stopped by the per-call guard.
    injectFault(id, "requirements", { point: "model", mode: "malformed", times: 1 });
    const origCreate = prisma.agentRun.create.bind(prisma.agentRun);
    (prisma.agentRun as { create: unknown }).create = async (args: Parameters<typeof origCreate>[0]) => {
      const res = await origCreate(args);
      await prisma.mission.update({ where: { id }, data: { costUsd: costUsd + 5 } });
      return res;
    };
    try {
      await advanceMission(id, ws);
    } finally {
      (prisma.agentRun as { create: unknown }).create = origCreate;
    }
    const [run] = await runOf(id, "requirements");
    expect(run.errorCategory).toBe("budget_exceeded");
    expect(run.error).toMatch(/mission budget exhausted/);
    expect(run.modelCalls).toBe(1); // the retry never reached the model
  }, 60_000);

  it("per-task budget is enforced before each model call", async () => {
    const id = await planned();
    await prisma.missionTask.updateMany({ where: { missionId: id, key: "requirements" }, data: { budgetUsd: 0 } });
    await advanceMission(id, ws);
    const [run] = await runOf(id, "requirements");
    expect(run.errorCategory).toBe("budget_exceeded");
    expect(run.modelCalls).toBe(0);
  }, 60_000);

  it("a worker restart mid-task: the abandoned attempt is recorded and the task re-runs", async () => {
    const id = await planned();
    await prisma.mission.update({ where: { id }, data: { status: "RUNNING", startedAt: new Date() } });
    const t = (await taskOf(id, "requirements"))!;
    await prisma.missionTask.update({ where: { id: t.id }, data: { status: "RUNNING", leaseOwner: "dead", leaseExpiresAt: new Date(Date.now() - 1000), attempts: 1 } });
    await prisma.missionTaskRun.create({ data: { missionId: id, companyId: ws, taskId: t.id, taskKey: t.key, attempt: 1, agentKey: t.agentKey, worker: "dead" } });
    await advanceMission(id, ws);
    const runs = await runOf(id, "requirements");
    expect(runs.map((r) => r.status)).toEqual(["ABANDONED", "SUCCEEDED"]);
    expect(runs[0].errorCategory).toBe("worker_lost");
  }, 60_000);

  it("cancellation during a step discards the result and schedules nothing more", async () => {
    const id = await planned();
    injectFault(id, "requirements", { point: "afterExecute", fn: () => cancelMission(id, ws, "human@test") });
    const r = await advanceMission(id, ws);
    expect(r.status).toBe("CANCELLED");
    expect((await taskOf(id, "requirements"))!.status).toBe("SKIPPED");
    expect((await runOf(id, "requirements"))[0].status).toBe("CANCELLED");
    expect((await advanceMission(id, ws)).progressed).toBe(false);
    expect(await prisma.missionTaskRun.count({ where: { missionId: id } })).toBe(1);
  }, 60_000);

  it("a required verification step that cannot execute is UNVERIFIED, never passed", async () => {
    const id = await planned();
    await advanceMission(id, ws); // requirements
    injectFault(id, "reproduce", { point: "docker" });
    await runUntilBlocked(id, ws, 3);
    const t = await taskOf(id, "reproduce");
    expect(t!.verification).toBe("UNVERIFIED");
    expect(t!.errorCategory).toBe("sandbox_failure");
    expect((await prisma.mission.findUnique({ where: { id } }))!.status).toBe("FAILED");
  }, 60_000);

  it("a mission with no executable codebase never schedules code work", async () => {
    const m = await createMission({ companyId: ws, createdById: user, objective: "Reduce onboarding drop-off for new trial accounts." });
    await planMission(m.id, ws);
    const kinds = (await prisma.missionTask.findMany({ where: { missionId: m.id } })).map((t) => t.kind);
    expect(kinds).not.toContain("CODE_CHANGE");
  });

  it("an approval cannot be decided from another workspace, and agents cannot reach the gate", async () => {
    if (!docker) return;
    const m = await createMission({ companyId: ws, createdById: user, objective: "Fix the checkout rounding bug that undercharges customers by one cent." });
    await planMission(m.id, ws);
    await decidePlan(m.id, ws, "approve", "human@test");
    const r = await runUntilBlocked(m.id, ws, 40);
    expect(r.status).toBe("PAUSED");
    const a = await prisma.missionApproval.findFirst({ where: { missionId: m.id, status: "PENDING" } });
    await expect(decideApproval(a!.id, otherWs, "approve", "intruder")).rejects.toThrow(/not found/);
    // No agent role holds a tool that decides approvals; deploys need an APPROVED id.
    await expect(callTool({ companyId: ws, agentKey: "devops" }, "deploy.run", { env: "production" }, async () => "x")).rejects.toMatchObject({ code: "approval_required" });
  }, 240_000);
});
