/**
 * Operational briefing: what needs attention, what is blocked/failing, top
 * risks, waiting approvals, evaluation regressions, and the next step.
 *
 * Deterministic and computed from persisted rows; it never depends on a model.
 * An optional AI summary (`aiSummary`) receives ONLY the structured findings
 * (ids, titles, facts) — no raw logs or database access — and its output is
 * validated: it must cite only known finding ids, separate facts from
 * interpretation, and is stored as untrusted text. If the model is unavailable
 * or the output is invalid, the deterministic summary is used.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { complete, aiMode } from "@/lib/ai/claude";
import { extractJson } from "@/lib/agents/contracts";
import { ACTIVE } from "./reconcile";

const SEV: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const CERT: Record<string, number> = { confirmed: 1, warning: 0.8, prediction: 0.6, suspicion: 0.3 };

export interface BriefItem {
  id: string;
  title: string;
  severity: string;
  certainty: string;
  status: string;
  category: string;
  resourceLabel: string;
  missionId: string | null;
  requiresHuman: boolean;
  nextAction: string;
  lastObservedAt: string;
  priority: number;
  priorityReason: string;
}

/**
 * Priority = severity × evidence strength × urgency. Human-blocking items are
 * urgent (work cannot continue); suspicions are damped so they never outrank
 * a confirmed failure of the same severity.
 */
export function prioritize(f: { severity: string; certainty: string; requiresHuman: boolean; lastObservedAt: Date; status: string }, now = new Date()) {
  const sev = SEV[f.severity] ?? 1;
  const cert = CERT[f.certainty] ?? 0.5;
  const urgency = f.requiresHuman ? 1.5 : 1;
  const staleDays = (now.getTime() - f.lastObservedAt.getTime()) / 864e5;
  const fresh = staleDays > 1 ? 0.7 : 1;
  const ack = f.status === "ACKNOWLEDGED" || f.status === "INVESTIGATING" ? 0.6 : 1;
  const score = sev * cert * urgency * fresh * ack;
  const reason = [`${f.severity}`, f.certainty, f.requiresHuman ? "needs a person" : null, fresh < 1 ? "not seen in the last day" : null, ack < 1 ? "already acknowledged" : null].filter(Boolean).join(" · ");
  return { score: Math.round(score * 100) / 100, reason };
}

export async function buildBriefing(companyId: string) {
  const now = new Date();
  const [findings, approvals, plans, missions, mon, lastEval] = await Promise.all([
    prisma.opsFinding.findMany({ where: { companyId, status: { in: [...ACTIVE] } } }),
    prisma.missionApproval.findMany({ where: { companyId, status: "PENDING", mission: { source: { not: "SEEDED" } } }, include: { mission: { select: { id: true, title: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.mission.findMany({ where: { companyId, status: "AWAITING_APPROVAL", source: { not: "SEEDED" } }, select: { id: true, title: true, createdAt: true } }),
    prisma.mission.findMany({ where: { companyId, source: { not: "SEEDED" }, status: { in: ["RUNNING", "PAUSED", "FAILED", "READY"] } }, select: { id: true, title: true, status: true, statusReason: true, operatorHold: true, completedAt: true }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.opsMonitor.findUnique({ where: { companyId } }),
    prisma.opsEvaluation.findFirst({ where: { companyId, status: "COMPLETED" }, orderBy: { startedAt: "desc" } }),
  ]);

  const items: BriefItem[] = findings
    .map((f) => {
      const p = prioritize(f, now);
      return { id: f.id, title: f.title, severity: f.severity, certainty: f.certainty, status: f.status, category: f.category, resourceLabel: f.resourceLabel, missionId: f.missionId, requiresHuman: f.requiresHuman, nextAction: f.nextAction, lastObservedAt: f.lastObservedAt.toISOString(), priority: p.score, priorityReason: p.reason };
    })
    .sort((a, b) => b.priority - a.priority);

  const unknown = parseJSON<{ ruleId: string; resource: string; reason: string }[]>(lastEval?.unknown, []);
  const failing = missions.filter((m) => m.status === "FAILED" && m.completedAt && now.getTime() - m.completedAt.getTime() < 7 * 864e5);
  const blocked = missions.filter((m) => m.status === "PAUSED");
  const regressions = items.filter((i) => i.category === "evaluation");

  // Next step: the highest-priority human-blocking item, else the top item, else nothing.
  const top = items.find((i) => i.requiresHuman) ?? items[0];
  const next = top ? { findingId: top.id, text: top.nextAction, because: top.title } : approvals[0] ? { findingId: null, text: `Decide the approval for "${approvals[0].mission.title}"`, because: "An approval is waiting." } : null;

  const coverage = lastEval
    ? { evaluatedAt: lastEval.completedAt?.toISOString() ?? lastEval.startedAt.toISOString(), rules: lastEval.rulesRun, unknownCount: unknown.length }
    : null;

  // Deterministic summary — the always-available baseline.
  const counts = { critical: items.filter((i) => i.severity === "critical").length, high: items.filter((i) => i.severity === "high").length, other: items.filter((i) => SEV[i.severity] < 3).length };
  const summary = !coverage
    ? "No health evaluation has run yet, so AURA cannot say anything about operational state. Run an evaluation."
    : items.length === 0
      ? `No qualifying issues were detected from the available evidence (last evaluation ${coverage.evaluatedAt}). ${unknown.length ? `${unknown.length} check(s) had insufficient evidence and are unknown, not healthy.` : ""}`.trim()
      : `${items.length} open finding(s): ${counts.critical ? `${counts.critical} critical, ` : ""}${counts.high} high, ${counts.other} lower. ${approvals.length + plans.length ? `${approvals.length + plans.length} decision(s) waiting on a person. ` : ""}${unknown.length ? `${unknown.length} check(s) could not be evaluated for lack of evidence.` : ""}`.trim();

  return {
    generatedAt: now.toISOString(),
    monitor: mon ? { enabled: mon.enabled, policyLevel: mon.policyLevel, intervalSec: mon.intervalSec, lastRunAt: mon.lastRunAt?.toISOString() ?? null, aiSummaries: mon.aiSummaries } : null,
    coverage,
    summary,
    attention: items.slice(0, 8),
    totalOpen: items.length,
    blockedOrFailing: [...blocked.map((m) => ({ id: m.id, title: m.title, status: m.operatorHold ? "PAUSED (operator hold)" : "PAUSED (approval gate)", reason: m.statusReason })), ...failing.map((m) => ({ id: m.id, title: m.title, status: "FAILED", reason: m.statusReason }))],
    approvals: [...approvals.map((a) => ({ id: a.id, missionId: a.mission.id, title: a.mission.title, what: a.action, since: a.createdAt.toISOString() })), ...plans.map((p) => ({ id: p.id, missionId: p.id, title: p.title, what: "Plan approval", since: p.createdAt.toISOString() }))],
    regressions: regressions.map((r) => ({ id: r.id, title: r.title, certainty: r.certainty })),
    unknown: unknown.slice(0, 10),
    next,
  };
}

// ---------------------------------------------------------------------------
// Optional AI summary
// ---------------------------------------------------------------------------

const AiSummarySchema = z.object({
  facts: z.array(z.object({ text: z.string().min(3).max(300), refs: z.array(z.string()).min(1).max(5) })).max(8),
  interpretation: z.string().max(600),
  uncertainty: z.string().max(400),
});
export type AiSummary = z.infer<typeof AiSummarySchema>;

export async function aiSummary(companyId: string): Promise<{ mode: "ai" | "deterministic"; summary: AiSummary | string; model?: string; costUsd?: number; note: string }> {
  const b = await buildBriefing(companyId);
  if (aiMode() !== "live") return { mode: "deterministic", summary: b.summary, note: "No API key: showing the deterministic summary." };
  if (!b.attention.length) return { mode: "deterministic", summary: b.summary, note: "Nothing to summarize." };
  const known = new Set(b.attention.map((a) => a.id));
  const input = b.attention.map((a) => ({ ref: a.id, title: a.title, severity: a.severity, certainty: a.certainty, resource: a.resourceLabel, nextAction: a.nextAction }));
  const r = await complete({
    tier: "FAST",
    system: "You summarize engineering findings for an operator. Use ONLY the findings provided. Every fact must cite at least one ref from the input. Do not invent causes. Never claim an action was taken. State uncertainty explicitly. Reply with one JSON object: {\"facts\":[{\"text\",\"refs\":[]}],\"interpretation\":string,\"uncertainty\":string}.",
    prompt: `# Findings (structured, system-recorded)\n${JSON.stringify(input)}`,
    maxTokens: 600,
    temperature: 0,
  });
  const parsed = AiSummarySchema.safeParse(extractJson(r.text));
  if (!parsed.success) return { mode: "deterministic", summary: b.summary, note: "The model's summary failed validation; showing the deterministic summary." };
  // Reject citations to anything not in the input.
  const bad = parsed.data.facts.flatMap((f) => f.refs).filter((ref) => !known.has(ref));
  if (bad.length) return { mode: "deterministic", summary: b.summary, note: `The model cited unknown references (${bad.slice(0, 3).join(", ")}); showing the deterministic summary.` };
  if (/\b(i (have )?(paused|retried|rolled back|cancelled|fixed)|was (paused|retried|rolled back|fixed) by (me|aura))\b/i.test(JSON.stringify(parsed.data))) {
    return { mode: "deterministic", summary: b.summary, note: "The model claimed an action was executed; summary rejected." };
  }
  return { mode: "ai", summary: parsed.data, model: r.model, costUsd: r.cost, note: "AI summary of the listed findings. Treat as interpretation; the findings and their evidence are authoritative." };
}
