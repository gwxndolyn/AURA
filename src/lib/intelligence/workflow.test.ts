/**
 * Integration tests for the intelligence layer against the REAL Prisma DB and
 * the REAL evaluation harness (simulation mode when no ANTHROPIC_API_KEY — the
 * deterministic simulator — which these tests assert explicitly).
 *
 * Covers: dataset loading, registry + immutability, evaluation persistence,
 * workspace isolation, experiment comparison, promotion gates (block + pass),
 * rollback, knowledge approval, and the acceptance scenario end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AGENT_DEFS } from "@/lib/agents/definitions";
import { prisma } from "@/lib/db";
import { DATASETS, validateDataset, getDataset } from "./datasets";
import { ensureBuiltinPrompts, createVersion, agentPromptKey, verifyIntegrity, setStatus, getActiveVersion, resolveAgentPrompt } from "./registry";
import { runEvaluation, EvaluationError } from "./evaluation";
import { runExperiment, promoteVersion, rollbackVersion } from "./experiments";
import { proposeFromEvaluation, reviewKnowledge, approvedKnowledge } from "./knowledge";
import { agentScorecards, overview, failureAnalysis, routingDecisions } from "./insights";
import { aiMode } from "@/lib/ai/claude";

let userA: string, userB: string, wsA: string, wsB: string;

beforeAll(async () => {
  const a = await prisma.user.create({ data: { email: `ia_${Date.now()}@t.local`, name: "A" } });
  const b = await prisma.user.create({ data: { email: `ib_${Date.now()}@t.local`, name: "B" } });
  userA = a.id;
  userB = b.id;
  const cA = await prisma.company.create({ data: { name: "INTEL-A", mission: "m", industry: "SaaS", ownerId: userA } });
  const cB = await prisma.company.create({ data: { name: "INTEL-B", mission: "m", industry: "SaaS", ownerId: userB } });
  wsA = cA.id;
  wsB = cB.id;
  // Agents must exist for production runs; evaluations don't need them.
});

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await prisma.$disconnect();
});

describe("datasets", () => {
  it("covers the 10 required agent categories with valid, versioned cases", () => {
    const required = ["product-manager", "architect", "frontend-engineer", "backend-engineer", "qa-engineer", "devops", "security-engineer", "ceo", "red-team", "blue-team"];
    for (const id of required) expect(getDataset(id), id).toBeTruthy();
    for (const d of DATASETS) expect(validateDataset(d), d.id).toEqual([]);
  });
  it("includes the required difficult-case types", () => {
    const all = DATASETS.flatMap((d) => d.cases);
    expect(all.some((c) => c.harness?.type === "budget")).toBe(true);
    expect(all.some((c) => c.harness?.type === "injection")).toBe(true);
    expect(all.some((c) => c.harness?.type === "tool" && c.harness.behavior === "timeout")).toBe(true);
    expect(all.some((c) => c.harness?.type === "tool" && c.harness.behavior === "malformed")).toBe(true);
    expect(all.some((c) => c.expectation.policy?.toolMustBeDenied)).toBe(true);
    expect(all.some((c) => c.expectation.policy?.mustRefuse)).toBe(true);
    expect(all.some((c) => c.expectation.policy?.mustEscalate)).toBe(true);
    expect(all.some((c) => c.tags?.includes("conflict"))).toBe(true);
    expect(all.some((c) => c.harness?.type === "sandbox-repair")).toBe(true);
  });
});

describe("prompt registry", () => {
  it("imports built-in prompts as v1 ACTIVE, idempotently", async () => {
    await ensureBuiltinPrompts(wsA);
    await ensureBuiltinPrompts(wsA);
    const t = await prisma.promptTemplate.findMany({ where: { companyId: wsA } });
    expect(t.length).toBe(AGENT_DEFS.length);
    const active = await getActiveVersion(wsA, agentPromptKey("qa-engineer"));
    expect(active?.version).toBe(1);
    expect(verifyIntegrity(active!)).toBe(true);
    const resolved = await resolveAgentPrompt(wsA, "qa-engineer");
    expect(resolved.promptRef).toBe("agent.qa-engineer.system@v1");
  });

  it("creates new versions without overwriting history; rejects no-op versions", async () => {
    const before = await getActiveVersion(wsA, agentPromptKey("qa-engineer"));
    const v2 = await createVersion({ companyId: wsA, templateKey: agentPromptKey("qa-engineer"), content: before!.content + " Report results as JSON.", changelog: "json", author: userA });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe("DRAFT");
    const v1 = await prisma.promptVersion.findUnique({ where: { id: before!.id } });
    expect(v1!.content).toBe(before!.content); // untouched
    expect(v1!.contentHash).toBe(before!.contentHash);
    await expect(createVersion({ companyId: wsA, templateKey: agentPromptKey("qa-engineer"), content: v2.content, changelog: "dup", author: userA })).rejects.toThrow(/identical/);
  });

  it("detects tampering via the content hash", async () => {
    const v = await getActiveVersion(wsA, agentPromptKey("qa-engineer"));
    expect(verifyIntegrity({ ...v!, content: v!.content + "x" })).toBe(false);
  });

  it("forbids activation outside the promotion path and illegal transitions", async () => {
    const draft = await prisma.promptVersion.findFirst({ where: { companyId: wsA, status: "DRAFT" } });
    await expect(setStatus(wsA, draft!.id, "ACTIVE", userA)).rejects.toThrow(/promotion/);
    await expect(setStatus(wsA, draft!.id, "APPROVED", userA)).rejects.toThrow(/Illegal/);
  });
});

describe("evaluation engine", () => {
  it("runs a dataset, persists every case, records versions + mode honestly", async () => {
    const out = await runEvaluation({ companyId: wsA, agentKey: "security-engineer", datasetId: "security-engineer", createdBy: userA });
    expect(out.status).toBe("COMPLETED");
    const ev = await prisma.evaluation.findUnique({ where: { id: out.evaluationId }, include: { results: true } });
    expect(ev!.results.length).toBe(getDataset("security-engineer")!.cases.length);
    expect(ev!.promptKey).toBe("agent.security-engineer.system");
    expect(ev!.promptVersion).toBe(1);
    expect(ev!.datasetVersion).toBe("1.0.0");
    expect(ev!.mode).toBe(aiMode());
    // The unsafe real-target case is refused by the deterministic policy.
    const unsafe = ev!.results.find((r) => r.caseId === "sec-unsafe-real-target")!;
    expect(unsafe.pass).toBe(true);
    // Injection case: deploy.run requested by retrieved content is denied.
    const inj = ev!.results.find((r) => r.caseId === "sec-injection-in-retrieved")!;
    expect(JSON.parse(inj.telemetry).toolDenied).toBe(true);
    expect(inj.pass).toBe(true);
  });

  it("budget, timeout, malformed-tool and denied-tool cases are handled and classified", async () => {
    const be = await runEvaluation({ companyId: wsA, agentKey: "backend-engineer", datasetId: "backend-engineer", createdBy: userA });
    const by = Object.fromEntries(be.run.cases.map((c) => [c.caseId, c]));
    expect(by["be-tool-timeout"].pass).toBe(true);
    expect(be.telemetry["be-tool-timeout"].timedOut).toBe(true);
    expect(by["be-malformed-tool-output"].pass).toBe(true);
    // Sandbox case is skipped (not passed) when Docker is absent.
    const repair = by["be-test-failure-repair"];
    if (repair.skipped) expect(repair.skipReason).toBe("docker-unavailable");

    const pm = await runEvaluation({ companyId: wsA, agentKey: "product-manager", datasetId: "product-manager", createdBy: userA });
    const budget = pm.run.cases.find((c) => c.caseId === "pm-budget-limit")!;
    expect(budget.pass).toBe(true);
    expect(budget.tokensIn ?? 0).toBe(0); // stopped before spending

    const red = await runEvaluation({ companyId: wsA, agentKey: "red-team", datasetId: "red-team", createdBy: userA });
    expect(red.run.cases.find((c) => c.caseId === "red-unauthorized-deploy")!.pass).toBe(true);
    expect(red.run.cases.find((c) => c.caseId === "red-real-target-refusal")!.pass).toBe(true);
  }, 30_000);

  it("is reproducible in simulation mode for the same seed", async () => {
    if (aiMode() === "live") return; // live models are nondeterministic by design
    const a = await runEvaluation({ companyId: wsA, agentKey: "qa-engineer", datasetId: "qa-engineer", createdBy: userA, seedSalt: "repro" });
    const b = await runEvaluation({ companyId: wsA, agentKey: "qa-engineer", datasetId: "qa-engineer", createdBy: userA, seedSalt: "repro" });
    expect(a.run.cases.map((c) => [c.caseId, c.pass, c.outputSummary])).toEqual(b.run.cases.map((c) => [c.caseId, c.pass, c.outputSummary]));
  });

  it("rejects mismatched dataset/agent and cross-workspace prompt versions", async () => {
    await expect(runEvaluation({ companyId: wsA, agentKey: "ceo", datasetId: "red-team", createdBy: userA })).rejects.toBeInstanceOf(EvaluationError);
    const vA = await getActiveVersion(wsA, agentPromptKey("ceo"));
    await ensureBuiltinPrompts(wsB);
    await expect(runEvaluation({ companyId: wsB, agentKey: "ceo", datasetId: "ceo", promptVersionId: vA!.id, createdBy: userB })).rejects.toThrow(/not found/);
  });
});

describe("workspace isolation of intelligence data", () => {
  it("workspace B sees none of A's evaluations, scorecard data, or knowledge", async () => {
    const ovB = await overview(wsB);
    expect(ovB.evaluations).toBe(0);
    expect(ovB.passRate).toBeNull();
    const scB = await agentScorecards(wsB);
    expect(scB.every((s) => s.sampleSize === 0 && s.confidence.level === "none")).toBe(true);
    const ovA = await overview(wsA);
    expect(ovA.evaluations).toBeGreaterThan(0);
  });
});

describe("acceptance scenario: baseline → candidate → compare → gate → promote → rollback", () => {
  const key = agentPromptKey("ceo");

  it("runs a controlled experiment: same dataset version, both arms persisted, recommendation recorded", async () => {
    const baseline = await getActiveVersion(wsA, key);
    // NOTE: in simulation mode the deterministic simulator does not read the
    // system prompt, so both arms produce identical outputs — this test proves
    // the experiment machinery, not prompt quality. Live mode measures wording.
    const bad = await createVersion({ companyId: wsA, templateKey: key, content: "You are a CEO. Answer in one word.", changelog: "terse experiment", author: userA });
    const exp = await runExperiment({ companyId: wsA, templateKey: key, baselineVersionId: baseline!.id, candidateVersionId: bad.id, createdBy: userA });
    expect(["promote", "block", "needs-approval"]).toContain(exp.comparison.recommendation);
    expect(exp.experiment.status).toBe("COMPLETED");
    // Two evaluations per arm per repetition were persisted against the same dataset version.
    const evals = await prisma.evaluation.findMany({ where: { experimentId: exp.experiment.id } });
    expect(evals.length).toBe(2);
    expect(new Set(evals.map((e) => e.datasetVersion)).size).toBe(1);
  });

  it("refuses to promote a DRAFT version and records nothing active-changing", async () => {
    const draft = await createVersion({ companyId: wsA, templateKey: key, content: "Draft never evaluated.", changelog: "draft", author: userA });
    await expect(promoteVersion({ companyId: wsA, candidateVersionId: draft.id, actor: userA })).rejects.toThrow(/APPROVED/);
    const active = await getActiveVersion(wsA, key);
    expect(active!.version).toBe(1);
  });

  it("promotes an approved candidate only after a fresh regression run passes gates; rollback restores v1", async () => {
    const v1 = await getActiveVersion(wsA, key);
    const cand = await createVersion({ companyId: wsA, templateKey: key, content: v1!.content + " Always cite the specific metric behind each decision.", changelog: "cite metrics", author: userA });
    const exp = await runExperiment({ companyId: wsA, templateKey: key, baselineVersionId: v1!.id, candidateVersionId: cand.id, createdBy: userA });

    const after = await prisma.promptVersion.findUnique({ where: { id: cand.id } });
    if (exp.comparison.recommendation !== "promote") {
      // Evidence did not support promotion → it must stay non-active.
      expect(after!.status).not.toBe("ACTIVE");
      const res = await promoteVersion({ companyId: wsA, candidateVersionId: cand.id, actor: userA }).catch((e) => e);
      expect(res instanceof Error || res.promoted === false).toBe(true);
      expect((await getActiveVersion(wsA, key))!.id).toBe(v1!.id);
      return;
    }
    expect(after!.status).toBe("APPROVED");
    const promo = await promoteVersion({ companyId: wsA, candidateVersionId: cand.id, actor: userA });
    expect(promo.promoted).toBe(true);
    expect(promo.gates.passed).toBe(true);
    expect((await getActiveVersion(wsA, key))!.id).toBe(cand.id);
    // Production runs now record the new version.
    expect((await resolveAgentPrompt(wsA, "ceo")).promptRef).toBe(`${key}@v${cand.version}`);
    // Exactly one active version.
    const t = await prisma.promptTemplate.findUnique({ where: { companyId_key: { companyId: wsA, key } } });
    expect(await prisma.promptVersion.count({ where: { templateId: t!.id, status: "ACTIVE" } })).toBe(1);

    const rb = await rollbackVersion({ companyId: wsA, templateKey: key, targetVersionId: v1!.id, actor: userA, reason: "acceptance test" });
    expect(rb.activeVersionId).toBe(v1!.id);
    expect((await getActiveVersion(wsA, key))!.id).toBe(v1!.id);
    expect((await prisma.promptVersion.findUnique({ where: { id: cand.id } }))!.status).toBe("ROLLED_BACK");
    const history = await prisma.promptPromotion.findMany({ where: { companyId: wsA, templateId: t!.id }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["PROMOTE", "ROLLBACK"]));
  });

  it("cannot roll back to a version that was never active", async () => {
    const never = await createVersion({ companyId: wsA, templateKey: key, content: "never active " + Date.now(), changelog: "x", author: userA });
    await expect(rollbackVersion({ companyId: wsA, templateKey: key, targetVersionId: never.id, actor: userA, reason: "x" })).rejects.toThrow(/previously active/);
  });
});

describe("release gates on real persisted evaluations", () => {
  it("a candidate whose regression run fails a hard gate is BLOCKED and the active version is kept", async () => {
    const { evaluateGates } = await import("./gates");
    const { loadEvaluationRun } = await import("./evaluation");
    const ev = await prisma.evaluation.findFirst({ where: { companyId: wsA, status: "COMPLETED" }, orderBy: { startedAt: "desc" } });
    const run = (await loadEvaluationRun(wsA, ev!.id))!;
    // Simulate a security regression in the candidate by flipping one security case.
    const sec = run.cases.find((c) => c.verdicts.some((v) => v.evaluator === "policy"));
    if (!sec) return;
    const regressed = { ...run, cases: run.cases.map((c) => (c === sec ? { ...c, pass: false, failureCategory: "security_policy_violation" as const } : c)) };
    const report = evaluateGates(run, regressed);
    expect(report.recommendation).toBe("block");
    expect(report.blockedReasons.join(" ")).toMatch(/security/);
  });
});

describe("knowledge review loop", () => {
  it("proposals require approval; only approved entries are usable; edits supersede", async () => {
    const ev = await prisma.evaluation.findFirst({ where: { companyId: wsA, failed: { gt: 0 } } });
    if (!ev) return; // every case passed — nothing to learn from failures
    const proposals = await proposeFromEvaluation(wsA, ev.id, userA);
    expect(proposals.every((p) => p.status === "PROPOSED")).toBe(true);
    expect((await approvedKnowledge(wsA)).length).toBe(0);
    const first = proposals[0];
    await reviewKnowledge({ companyId: wsA, id: first.id, action: "approve", reviewer: userA, note: "verified" });
    expect((await approvedKnowledge(wsA)).map((k) => k.id)).toContain(first.id);
    const edited = await reviewKnowledge({ companyId: wsA, id: first.id, action: "edit", reviewer: userA, edit: { lesson: "corrected lesson" } });
    expect((edited as { status: string }).status).toBe("PROPOSED");
    expect((await approvedKnowledge(wsA)).map((k) => k.id)).not.toContain(first.id);
    await expect(reviewKnowledge({ companyId: wsB, id: first.id, action: "approve", reviewer: userB })).rejects.toThrow(/not found/);
  });
});

describe("read models derive from persisted records", () => {
  it("scorecards, failure analysis and routing reflect real evaluations", async () => {
    const cards = await agentScorecards(wsA);
    const sec = cards.find((c) => c.agentKey === "security-engineer")!;
    expect(sec.sampleSize).toBeGreaterThan(0);
    expect(sec.security.injectionResistanceRate.denominator).toBeGreaterThan(0);
    const fa = await failureAnalysis(wsA);
    expect(Array.isArray(fa.distribution)).toBe(true);
    const r = await routingDecisions(wsA);
    expect(r.decisions.length).toBeGreaterThan(0);
    if (aiMode() === "simulation") {
      // Fixture evidence never drives routing: every category uses the safe default.
      expect(r.performance.every((p) => p.evidenceMode === "simulation")).toBe(true);
      expect(r.decisions.every((d) => d.usedSafeDefault)).toBe(true);
    }
  });
});
