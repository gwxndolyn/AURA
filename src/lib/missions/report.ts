/**
 * Mission completion report. Built ONLY from persisted rows (mission, plans,
 * tasks, artifacts, approvals, agent runs). Separates proposed / executed /
 * verified / approved / deployed so a reviewer never mistakes one for another.
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";

export interface TestRunSummary {
  artifactId: string;
  name: string;
  taskKey: string | null;
  mode: string; // docker | simulated
  passed: number;
  failed: number;
  total: number;
  cases: { name: string; ok: boolean }[];
  createdAt: string;
}

export async function buildReport(missionId: string, companyId: string) {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, companyId },
    include: {
      plans: { orderBy: { version: "asc" } },
      tasks: { orderBy: { createdAt: "asc" } },
      artifacts: { orderBy: { createdAt: "asc" } },
      approvals: { orderBy: { createdAt: "asc" } },
      findings: { orderBy: { createdAt: "asc" } },
      runs: { orderBy: { startedAt: "asc" } },
    },
  });
  if (!m) return null;

  const current = m.tasks.filter((t) => t.planVersion === m.planVersion);
  const count = (s: string) => current.filter((t) => t.status === s).length;
  const tests: TestRunSummary[] = m.artifacts
    .filter((a) => a.kind === "TEST_REPORT")
    .map((a) => {
      const meta = parseJSON<{ mode?: string; passed?: number; failed?: number; total?: number; cases?: { name: string; ok: boolean }[] }>(a.meta, {});
      return { artifactId: a.id, name: a.name, taskKey: a.taskKey, mode: meta.mode ?? "unknown", passed: meta.passed ?? 0, failed: meta.failed ?? 0, total: meta.total ?? 0, cases: meta.cases ?? [], createdAt: a.createdAt.toISOString() };
    });
  const testTaskKeys = new Set(current.filter((t) => t.kind === "TEST").map((t) => t.key));
  const finalTest = [...tests].reverse().find((t) => t.taskKey && testTaskKeys.has(t.taskKey)) ?? null;
  const diffs = m.artifacts.filter((a) => a.kind === "DIFF");
  const lastDiff = diffs[diffs.length - 1];
  const security = m.artifacts.filter((a) => a.kind === "SECURITY_REPORT").pop();
  const securityMeta = security ? parseJSON<{ checks?: { check: string; pass: boolean }[] }>(security.meta, {}) : {};

  const acceptance = parseJSON<string[]>(m.acceptance, []);
  const approval = m.approvals[m.approvals.length - 1];
  const fixTask = current.find((t) => t.kind === "CODE_CHANGE");
  const verifyTask = current.find((t) => t.kind === "TEST");
  const fixRuns = m.runs.filter((r) => r.taskKey === fixTask?.key && r.status !== "ABANDONED");

  // Each mission-level criterion is evaluated against concrete evidence, or marked unverified.
  const criteria = acceptance.map((text) => {
    let status: "met" | "not met" | "unverified" = "unverified";
    let evidence = "No recorded evidence for this criterion.";
    if (/tests pass/i.test(text) && finalTest) {
      status = finalTest.mode === "docker" && finalTest.failed === 0 && finalTest.total > 0 ? "met" : finalTest.mode !== "docker" ? "unverified" : "not met";
      evidence = `${finalTest.passed}/${finalTest.total} passed (${finalTest.mode === "docker" ? "Docker sandbox" : "simulated, not executed"}) — ${finalTest.name}`;
    } else if (/negative quantit/i.test(text) && finalTest) {
      const c = finalTest.cases.find((x) => /negative quantity/i.test(x.name));
      status = c ? (c.ok && finalTest.mode === "docker" ? "met" : c.ok ? "unverified" : "not met") : "unverified";
      evidence = c ? `Test "${c.name}" ${c.ok ? "passed" : "failed"}` : "No test covers this.";
    } else if (/independent review/i.test(text)) {
      const reviewRuns = m.runs.filter((r) => current.some((t) => t.kind === "REVIEW" && t.key === r.taskKey) && r.status === "SUCCEEDED");
      const last = reviewRuns[reviewRuns.length - 1];
      const open = m.findings.filter((f) => f.blocking && (f.status === "OPEN" || f.status === "UNRESOLVED"));
      status = !last ? "unverified" : open.length ? "not met" : last.outcome === "approved" ? "met" : "not met";
      evidence = last ? `${last.outcome === "approved" ? "Approved" : "Changes requested"} after ${reviewRuns.length} review run(s); ${m.findings.filter((f) => f.status === "RESOLVED").length} finding(s) resolved, ${open.length} blocking open, ${m.findings.filter((f) => f.status === "UNSUPPORTED").length} unsupported` : "No completed review run.";
    } else if (/write scope/i.test(text)) {
      const writes = m.artifacts.filter((a) => a.kind === "FILE");
      const scope = new Set(current.filter((t) => t.kind === "CODE_CHANGE").flatMap((t) => parseJSON<string[]>(t.files, [])));
      const outside = writes.filter((w) => !scope.has(w.name));
      status = writes.length ? (outside.length ? "not met" : "met") : "unverified";
      evidence = writes.length ? `${writes.length} file version(s) written, ${outside.length} outside the scope (${[...scope].join(", ")}); writes are enforced by the tool runner` : "No file was written.";
    } else if (/failing (validation )?test passes/i.test(text) && finalTest) {
      status = finalTest.mode === "docker" && finalTest.failed === 0 && finalTest.total > 0 ? "met" : finalTest.mode !== "docker" ? "unverified" : "not met";
      evidence = `${finalTest.passed}/${finalTest.total} passed (${finalTest.mode === "docker" ? "Docker sandbox" : "not executed"}) — ${finalTest.name}`;
    } else if (/security review/i.test(text) && securityMeta.checks) {
      const failed = securityMeta.checks.filter((c) => !c.pass);
      status = failed.length ? "not met" : "met";
      evidence = `${securityMeta.checks.length - failed.length}/${securityMeta.checks.length} deterministic checks passed on the final code`;
    } else if (/human approves/i.test(text)) {
      status = approval?.status === "APPROVED" ? "met" : approval?.status === "REJECTED" ? "not met" : "unverified";
      evidence = approval ? `Approval ${approval.status.toLowerCase()}${approval.decidedAt ? ` at ${approval.decidedAt.toISOString()}` : ""}` : "No approval requested yet.";
    } else if (/analysis/i.test(text)) {
      const a = m.artifacts.find((x) => x.kind === "ANALYSIS");
      status = a ? "met" : "unverified";
      evidence = a ? "Analysis artifact recorded" : evidence;
    }
    return { text, status, evidence };
  });

  const agentKeys = [...new Set(current.map((t) => t.agentKey))];
  const durationMs = m.startedAt ? (m.completedAt ?? new Date()).getTime() - m.startedAt.getTime() : null;

  return {
    mission: {
      id: m.id,
      title: m.title,
      objective: m.objective,
      status: m.status,
      statusReason: m.statusReason,
      source: m.source,
      template: m.template,
      planVersion: m.planVersion,
      createdAt: m.createdAt.toISOString(),
      startedAt: m.startedAt?.toISOString() ?? null,
      completedAt: m.completedAt?.toISOString() ?? null,
      durationMs,
    },
    plan: { versions: m.plans.map((p) => ({ version: p.version, status: p.status, changeReason: p.changeReason, decidedBy: p.decidedBy, decidedAt: p.decidedAt?.toISOString() ?? null })) },
    tasks: {
      total: current.length,
      succeeded: count("SUCCEEDED"),
      failed: count("FAILED"),
      skipped: count("SKIPPED"),
      pending: count("PENDING") + count("READY") + count("RUNNING") + count("WAITING_APPROVAL"),
      list: current.map((t) => ({ key: t.key, title: t.title, kind: t.kind, agentKey: t.agentKey, status: t.status, verification: t.verification, attempts: t.attempts, output: t.output, errorCategory: t.errorCategory })),
    },
    agents: agentKeys,
    usage: { costUsd: m.costUsd, modelCalls: m.modelCalls, toolCalls: m.toolCalls, budgetUsd: m.budgetUsd, costNote: "Estimated from token counts; not billed cost." },
    repair: { fixAttempts: fixRuns.length, repairRounds: m.repairRounds, maxRepairs: m.maxRepairs, maxAttempts: m.maxRepairs + 1, testRuns: tests.length },
    findings: m.findings.map((f) => ({ code: f.code, source: f.source, severity: f.severity, blocking: f.blocking, title: f.title, status: f.status, supported: f.supported, repairAttempts: f.repairAttempts })),
    runs: {
      total: m.runs.length,
      modelCalls: m.runs.reduce((s, r) => s + r.modelCalls, 0),
      toolCalls: m.runs.reduce((s, r) => s + r.toolCalls, 0),
      tokensIn: m.runs.reduce((s, r) => s + r.tokensIn, 0),
      tokensOut: m.runs.reduce((s, r) => s + r.tokensOut, 0),
      usageEstimated: m.runs.some((r) => r.usageEstimated),
      byAgent: Object.entries(
        m.runs.reduce<Record<string, { runs: number; costUsd: number; modelCalls: number }>>((acc, r) => {
          const a = (acc[r.agentKey] ??= { runs: 0, costUsd: 0, modelCalls: 0 });
          a.runs++;
          a.costUsd += r.costUsd;
          a.modelCalls += r.modelCalls;
          return acc;
        }, {}),
      ).map(([agentKey, v]) => ({ agentKey, ...v })),
    },
    tests,
    finalTest,
    files: lastDiff ? [{ path: lastDiff.name.replace(/ \(attempt \d+\)$/, ""), diffArtifactId: lastDiff.id, ...parseJSON<{ added?: number; removed?: number; author?: string }>(lastDiff.meta, {}) }] : [],
    security: securityMeta.checks ?? [],
    criteria,
    approvals: m.approvals.map((a) => ({ id: a.id, action: a.action, status: a.status, decidedBy: a.decidedBy, decidedAt: a.decidedAt?.toISOString() ?? null, onApprove: a.onApprove })),
    // The five levels a reviewer must keep separate.
    ledger: {
      proposed: current.length,
      executed: current.filter((t) => t.status === "SUCCEEDED" || t.status === "FAILED" || t.attempts > 0).length,
      verified: current.filter((t) => t.verification === "PASSED").length,
      humanApproved: m.approvals.filter((a) => a.status === "APPROVED").length,
      deployed: 0,
      deployedNote: "AURA does not deploy mission changes. Approval marks the change ready to release.",
    },
    unresolved: [
      ...current.filter((t) => t.status === "FAILED").map((t) => `${t.title}: ${t.output.split("\n").pop()}`),
      ...m.findings.filter((f) => f.status === "UNRESOLVED" || (f.status === "OPEN" && f.blocking)).map((f) => `${f.code} ${f.title} (${f.status.toLowerCase()})`),
      ...criteria.filter((c) => c.status !== "met").map((c) => `Criterion ${c.status}: ${c.text}`),
      ...(verifyTask?.verification === "UNVERIFIED" ? ["Tests were not executed (sandbox unavailable)."] : []),
    ],
  };
}
