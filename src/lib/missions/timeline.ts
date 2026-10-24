/**
 * Collaboration timeline + mission-based agent scorecards.
 *
 * Built ONLY from persisted rows (plans, task runs, handoffs, findings,
 * approvals). Each entry separates what the system verified (`facts`, from
 * tool results) from what the agent said (`claim`). Nothing is synthesized.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { sampleConfidence, type SampleConfidence } from "@/lib/intelligence/scorecard";

export interface TimelineEntry {
  id: string;
  at: string;
  actor: string; // agent key, "human:<email>", or "system"
  action: string;
  taskKey: string | null;
  result: "success" | "failure" | "warning" | "info";
  summary: string;
  facts: string[]; // system-verified (tool results, recorded evidence)
  claim: string; // agent narrative — not verified
  refs: { kind: "run" | "handoff" | "finding" | "artifact" | "approval" | "plan"; id: string; label: string }[];
  usage?: { modelCalls: number; toolCalls: number; tokensIn: number; tokensOut: number; costUsd: number; estimated: boolean; latencyMs: number; model: string; mode: string; retries: number };
}

const KIND_VERB: Record<string, string> = {
  REQUIREMENTS: "defined requirements",
  ARCHITECTURE: "submitted an architecture proposal",
  ANALYSIS: "submitted an analysis",
  REPRODUCE: "reproduced the defect",
  CODE_CHANGE: "submitted a change",
  TEST: "ran the test suite",
  REVIEW: "reviewed the change",
  SECURITY_REVIEW: "ran the security review",
  APPROVAL: "requested human approval",
  REPORT: "wrote the mission report",
};

export async function missionTimeline(missionId: string, companyId: string): Promise<TimelineEntry[] | null> {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, companyId },
    include: {
      plans: true,
      tasks: true,
      runs: { orderBy: { startedAt: "asc" } },
      handoffs: true,
      findings: true,
      approvals: true,
    },
  });
  if (!m) return null;
  const kindOf = new Map(m.tasks.map((t) => [t.key, t.kind]));
  const out: TimelineEntry[] = [];

  for (const p of m.plans) {
    out.push({ id: `plan-${p.id}`, at: p.createdAt.toISOString(), actor: "product-manager", action: `proposed plan v${p.version}`, taskKey: null, result: "info", summary: p.summary.slice(0, 300), facts: [`${m.tasks.filter((t) => t.planVersion === p.version).length} tasks; agents assigned by capability`], claim: "", refs: [{ kind: "plan", id: p.id, label: `plan v${p.version}` }] });
    if (p.decidedAt) out.push({ id: `plan-d-${p.id}`, at: p.decidedAt.toISOString(), actor: p.decidedBy === "demo-setup" ? "system" : `human:${p.decidedBy}`, action: `${p.status === "APPROVED" ? "approved" : "rejected"} plan v${p.version}`, taskKey: null, result: p.status === "APPROVED" ? "success" : "warning", summary: p.changeReason, facts: [], claim: "", refs: [{ kind: "plan", id: p.id, label: `plan v${p.version}` }] });
  }

  for (const r of m.runs) {
    const kind = kindOf.get(r.taskKey) ?? "";
    const output = parseJSON<Record<string, unknown>>(r.output, {});
    const facts: string[] = [];
    const tests = output.tests as { passed: number; total: number; mode: string; failing: string[]; artifactId: string } | undefined;
    if (tests) facts.push(`${tests.passed}/${tests.total} tests passed (${tests.mode === "docker" ? "executed in Docker" : "not executed"})${tests.failing.length ? ` — failing: ${tests.failing.join("; ")}` : ""}`);
    if (Array.isArray(output.checks)) {
      const checks = output.checks as { pass: boolean; probe?: string; check?: string }[];
      facts.push(`${checks.filter((c) => c.pass).length}/${checks.length} ${kind === "REVIEW" ? "probes" : "checks"} passed (executed)`);
    }
    if (Array.isArray(output.files)) for (const f of output.files as { path: string; added: number; removed: number }[]) facts.push(`wrote ${f.path} (+${f.added} −${f.removed}) inside the enforced write scope`);
    if (Array.isArray(output.addressesFindings) && (output.addressesFindings as string[]).length) facts.push(`addresses ${(output.addressesFindings as string[]).join(", ")}`);
    if (Array.isArray(output.affectedFiles)) facts.push(`named ${(output.affectedFiles as string[]).join(", ") || "no existing files"} (checked against the repository)`);
    if (!r.outputValid && r.status !== "RUNNING") facts.push(`output failed contract validation: ${parseJSON<string[]>(r.validationErrors, []).slice(0, 2).join("; ")}`);
    const ctxNotes = parseJSON<string[]>(r.contextNotes, []);
    if (ctxNotes.length) facts.push(...ctxNotes.slice(0, 2));
    const failed = r.status === "FAILED" || r.status === "ABANDONED";
    const resultOf: TimelineEntry["result"] = failed ? "failure" : ["tests_failed", "changes_requested"].includes(r.outcome) ? "warning" : r.status === "CANCELLED" ? "warning" : "success";
    const handoff = m.handoffs.find((h) => h.runId === r.id);
    out.push({
      id: `run-${r.id}`,
      at: (r.completedAt ?? r.startedAt).toISOString(),
      actor: r.agentKey,
      action: r.status === "ABANDONED" ? "attempt abandoned (worker lost)" : r.status === "CANCELLED" ? "attempt cancelled" : failed ? `failed: ${KIND_VERB[kind] ?? kind}` : r.outcome === "changes_requested" ? "requested changes" : r.outcome === "tests_failed" ? "ran tests — failures found" : KIND_VERB[kind] ?? kind,
      taskKey: r.taskKey,
      result: resultOf,
      summary: failed ? `${r.errorCategory ?? "failed"}: ${r.error.slice(0, 240)}` : `attempt ${r.attempt}${r.retries ? `, ${r.retries} retr${r.retries === 1 ? "y" : "ies"}` : ""}`,
      facts,
      claim: r.claims.slice(0, 600),
      refs: [{ kind: "run", id: r.id, label: `${r.taskKey} #${r.attempt}` }, ...(handoff ? [{ kind: "handoff" as const, id: handoff.id, label: `handoff → ${parseJSON<string[]>(handoff.toAgents, []).join(", ") || "report"}` }] : [])],
      usage: { modelCalls: r.modelCalls, toolCalls: r.toolCalls, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd, estimated: r.usageEstimated, latencyMs: r.latencyMs, model: r.model, mode: r.mode, retries: r.retries },
    });
  }

  for (const f of m.findings) {
    out.push({
      id: `finding-${f.id}`,
      at: f.createdAt.toISOString(),
      actor: f.source === "qa" ? "qa-engineer" : f.source === "security" ? "security-engineer" : "reviewer",
      action: f.supported ? `raised finding ${f.code}` : `recorded unsupported concern ${f.code}`,
      taskKey: f.taskKey,
      result: f.supported ? (f.blocking ? "warning" : "info") : "info",
      summary: `[${f.severity}${f.blocking ? ", blocking" : ""}] ${f.title}`,
      // Supported findings are written by the engine from an executed probe/test — a fact, not an agent claim.
      facts: f.supported ? [f.description.slice(0, 300), `status: ${f.status.toLowerCase()}`] : ["no executed evidence — not acted on", `status: ${f.status.toLowerCase()}`],
      claim: f.supported ? "" : f.description.slice(0, 400),
      refs: [{ kind: "finding", id: f.id, label: f.code }, ...(parseJSON<{ artifactId?: string }>(f.evidence, {}).artifactId ? [{ kind: "artifact" as const, id: parseJSON<{ artifactId: string }>(f.evidence, { artifactId: "" }).artifactId, label: "evidence" }] : [])],
    });
    if (f.resolvedAt) out.push({ id: `finding-r-${f.id}`, at: f.resolvedAt.toISOString(), actor: "system", action: `verified ${f.code} resolved`, taskKey: null, result: "success", summary: f.title, facts: ["re-verified on the repaired code"], claim: "", refs: [{ kind: "finding", id: f.id, label: f.code }] });
  }

  for (const a of m.approvals) {
    out.push({ id: `appr-${a.id}`, at: a.createdAt.toISOString(), actor: "system", action: "approval requested", taskKey: a.taskKey, result: "info", summary: a.action, facts: ["change hash recorded; re-checked at decision time"], claim: "", refs: [{ kind: "approval", id: a.id, label: "approval" }] });
    if (a.decidedAt) out.push({ id: `appr-d-${a.id}`, at: a.decidedAt.toISOString(), actor: `human:${a.decidedBy}`, action: a.status === "APPROVED" ? "approved the change" : "rejected the change", taskKey: a.taskKey, result: a.status === "APPROVED" ? "success" : "warning", summary: a.note || a.action, facts: [], claim: "", refs: [{ kind: "approval", id: a.id, label: "approval" }] });
  }

  return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export async function handoffDetail(missionId: string, companyId: string, handoffId: string) {
  const h = await prisma.missionHandoff.findFirst({ where: { id: handoffId, missionId, companyId } });
  if (!h) return null;
  return { ...h, payload: parseJSON(h.payload, {}), toAgents: parseJSON<string[]>(h.toAgents, []), errors: parseJSON<string[]>(h.errors, []) };
}

export async function runDetail(missionId: string, companyId: string, runId: string) {
  const r = await prisma.missionTaskRun.findFirst({ where: { id: runId, missionId, companyId } });
  if (!r) return null;
  const toolCalls = await prisma.toolCall.findMany({ where: { runId: { in: parseJSON<string[]>(r.agentRunIds, []) } }, orderBy: { createdAt: "asc" }, select: { tool: true, status: true, durationMs: true, ok: true, createdAt: true } });
  return { ...r, output: parseJSON(r.output, {}), contextSources: parseJSON(r.contextSources, []), contextNotes: parseJSON<string[]>(r.contextNotes, []), validationErrors: parseJSON<string[]>(r.validationErrors, []), toolLog: parseJSON(r.toolLog, []), toolCalls };
}

// ---------------------------------------------------------------------------
// Scorecards (mission evidence)
// ---------------------------------------------------------------------------

export interface MissionMetric {
  value: number | null;
  numerator: number;
  denominator: number;
  definition: string;
}
const metric = (num: number, den: number, definition: string): MissionMetric => ({ value: den ? num / den : null, numerator: num, denominator: den, definition });

export interface AgentMissionScorecard {
  agentKey: string;
  attempts: number; // evaluated attempts (excludes running/cancelled/abandoned)
  confidence: SampleConfidence;
  period: { from: string | null; to: string | null };
  taskSuccess: MissionMetric;
  outputValidity: MissionMetric;
  testPassRate: MissionMetric | null; // QA only
  reviewDefectRate: MissionMetric | null; // implementers: share of their changes that drew a supported finding
  repairSuccess: MissionMetric | null; // implementers: repairs whose findings were then resolved
  findingPrecision: MissionMetric | null; // reviewers: supported / all concerns raised
  avgLatencyMs: number | null;
  costPerSuccess: number | null;
  costEstimated: boolean;
  humanInterventionRate: MissionMetric;
}

/**
 * Mission-derived scorecards. Denominators exclude attempts that were still
 * running, cancelled or abandoned by a crashed worker — those are not
 * evidence of quality either way.
 */
export async function missionScorecards(companyId: string): Promise<AgentMissionScorecard[]> {
  const runs = await prisma.missionTaskRun.findMany({ where: { companyId, status: { in: ["SUCCEEDED", "FAILED"] }, mission: { source: { not: "SEEDED" } } }, orderBy: { startedAt: "asc" } });
  const findings = await prisma.missionFinding.findMany({ where: { companyId, mission: { source: { not: "SEEDED" } } } });
  const tasks = await prisma.missionTask.findMany({ where: { companyId }, select: { key: true, missionId: true, kind: true } });
  const kindOf = new Map(tasks.map((t) => [`${t.missionId}:${t.key}`, t.kind]));
  const agents = [...new Set(runs.map((r) => r.agentKey))];
  return agents.map((agentKey) => {
    const mine = runs.filter((r) => r.agentKey === agentKey);
    const kinds = new Set(mine.map((r) => kindOf.get(`${r.missionId}:${r.taskKey}`)));
    const ok = mine.filter((r) => r.status === "SUCCEEDED" && r.outputValid && !["tests_failed", "changes_requested"].includes(r.outcome));
    const qa = kinds.has("TEST") ? mine.filter((r) => kindOf.get(`${r.missionId}:${r.taskKey}`) === "TEST" && r.outcome && ["passed", "tests_failed"].includes(r.outcome)) : null;
    const changes = kinds.has("CODE_CHANGE") ? mine.filter((r) => kindOf.get(`${r.missionId}:${r.taskKey}`) === "CODE_CHANGE" && r.status === "SUCCEEDED") : null;
    const reviews = kinds.has("REVIEW");
    const raised = findings.filter((f) => f.source === "reviewer" && mine.some((r) => r.id === f.runId));
    const failuresNeedingHuman = mine.filter((r) => r.status === "FAILED" && !["budget_exceeded"].includes(r.errorCategory ?? "")).length;
    const cost = mine.reduce((s, r) => s + r.costUsd, 0);
    return {
      agentKey,
      attempts: mine.length,
      confidence: sampleConfidence(mine.length),
      period: { from: mine[0]?.startedAt.toISOString() ?? null, to: mine[mine.length - 1]?.startedAt.toISOString() ?? null },
      taskSuccess: metric(ok.length, mine.length, "attempts that succeeded with a valid output and no failing verdict ÷ evaluated attempts (running, cancelled and abandoned attempts excluded)"),
      outputValidity: metric(mine.filter((r) => r.outputValid).length, mine.length, "attempts whose structured output passed its contract ÷ evaluated attempts"),
      testPassRate: qa ? metric(qa.filter((r) => r.outcome === "passed").length, qa.length, "QA test runs where every test passed in Docker ÷ QA test runs") : null,
      reviewDefectRate: changes ? metric(changes.filter((c) => findings.some((f) => f.supported && f.againstRunId === c.id)).length, changes.length, "changes that drew at least one evidence-backed finding (QA or review) ÷ changes submitted") : null,
      repairSuccess: changes
        ? (() => {
            const repairs = changes.filter((c) => findings.some((f) => f.addressedByRunId === c.id));
            const fixed = repairs.filter((c) => findings.filter((f) => f.addressedByRunId === c.id).every((f) => f.status === "RESOLVED"));
            return metric(fixed.length, repairs.length, "repairs whose addressed findings were all verified resolved ÷ repairs that addressed a finding");
          })()
        : null,
      findingPrecision: reviews ? metric(raised.filter((f) => f.supported).length, raised.length, "concerns reproduced by an executed probe ÷ concerns raised") : null,
      avgLatencyMs: mine.length ? Math.round(mine.reduce((s, r) => s + r.latencyMs, 0) / mine.length) : null,
      costPerSuccess: ok.length ? cost / ok.length : null,
      costEstimated: mine.some((r) => r.usageEstimated),
      humanInterventionRate: metric(failuresNeedingHuman, mine.length, "attempts that ended in a failure requiring a person (excludes budget stops) ÷ evaluated attempts"),
    };
  });
}
