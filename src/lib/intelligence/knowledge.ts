/**
 * Controlled learning loop. Completed tasks / evaluations / experiments produce
 * PROPOSED knowledge entries with evidence + source attribution. Nothing is
 * promoted to shared knowledge (or agent memory) without human review.
 *
 * Rules:
 *  - Proposals are generated deterministically from recorded outcomes (test
 *    results, failure categories, gate reports) — not from free-form model text.
 *  - User input, retrieved content, and generated code are treated as untrusted
 *    DATA: they are redacted and quoted as evidence, never stored as policy.
 *  - Entries can be approved, rejected, edited (creates a superseding entry),
 *    deprecated, or deleted. Only APPROVED entries are retrievable as knowledge.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { parseJSON } from "@/lib/utils";
import { FAILURE_META, type FailureCategory } from "./failures";
import { redact } from "./redact";

export const KNOWLEDGE_STATUSES = ["PROPOSED", "APPROVED", "REJECTED", "DEPRECATED"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

interface Evidence {
  type: string;
  ref: string;
  detail: string;
}

function confidenceFrom(samples: number): "low" | "medium" | "high" {
  return samples >= 10 ? "high" : samples >= 3 ? "medium" : "low";
}

/** Propose a lesson from a completed task (DONE or BLOCKED). */
export async function proposeFromTask(companyId: string, taskId: string, actor = "system") {
  const task = await prisma.task.findFirst({ where: { id: taskId, companyId }, include: { assignee: true } });
  if (!task) throw new Error("Task not found");
  if (!["DONE", "BLOCKED"].includes(task.status)) return null;
  const existing = await prisma.knowledgeEntry.findFirst({ where: { companyId, sourceType: "TASK", sourceId: taskId } });
  if (existing) return existing;

  const criteria = parseJSON<{ text: string; met: boolean }[]>(task.acceptance, []);
  const evidence: Evidence[] = [
    { type: "task", ref: task.id, detail: redact(`"${task.title}" → ${task.status} after ${task.attempts || 1} attempt(s)`, 300) },
    { type: "acceptance", ref: task.id, detail: `${criteria.filter((c) => c.met).length}/${criteria.length} criteria met` },
  ];
  const testEvents = await prisma.simulationEvent.findMany({ where: { companyId, type: "TEST_COMPLETED" }, orderBy: { createdAt: "desc" }, take: 3 });
  for (const e of testEvents) evidence.push({ type: "test", ref: e.id, detail: redact(e.message, 200) });

  const lesson =
    task.status === "DONE" && task.attempts > 1
      ? `Tasks like "${redact(task.title, 80)}" may need a repair loop: it passed real tests only after ${task.attempts} attempts. Keep the self-healing path enabled for this task type.`
      : task.status === "BLOCKED"
        ? `Tasks like "${redact(task.title, 80)}" exhausted repair attempts. Investigate code generation / QA feedback quality before retrying.`
        : `Tasks like "${redact(task.title, 80)}" passed acceptance on the first attempt via the standard quality gate.`;

  const entry = await prisma.knowledgeEntry.create({
    data: {
      companyId,
      title: `Task outcome: ${redact(task.title, 80)}`,
      lesson,
      evidence: JSON.stringify(evidence),
      sourceType: "TASK",
      sourceId: task.id,
      agentKey: task.assignee?.key,
      workflow: "executeTask",
      confidence: "low", // a single task is anecdotal
      createdBy: actor,
    },
  });
  await audit(companyId, actor, "KNOWLEDGE_PROPOSED", entry.id, `from task ${task.id}`);
  return entry;
}

/** Propose lessons from an evaluation's recurring failure categories. */
export async function proposeFromEvaluation(companyId: string, evaluationId: string, actor = "system") {
  const ev = await prisma.evaluation.findFirst({ where: { id: evaluationId, companyId }, include: { results: true } });
  if (!ev) throw new Error("Evaluation not found");
  const failed = ev.results.filter((r) => !r.pass && !r.skipped && r.failureCategory);
  const byCat = new Map<string, typeof failed>();
  for (const r of failed) byCat.set(r.failureCategory!, [...(byCat.get(r.failureCategory!) ?? []), r]);
  const created = [];
  for (const [cat, rows] of byCat) {
    const exists = await prisma.knowledgeEntry.findFirst({ where: { companyId, sourceType: "EVALUATION", sourceId: ev.id, title: { contains: cat } } });
    if (exists) continue;
    const meta = FAILURE_META[cat as FailureCategory];
    const entry = await prisma.knowledgeEntry.create({
      data: {
        companyId,
        title: `${ev.agentKey}: recurring ${cat} on ${ev.datasetId}@${ev.datasetVersion}`,
        lesson: `Hypothesis (unverified): ${meta?.hint ?? "investigate"} — observed in ${rows.length}/${ev.total} case(s) for ${ev.promptKey}@v${ev.promptVersion}.`,
        evidence: JSON.stringify(rows.map((r) => ({ type: "eval-case", ref: `${ev.id}/${r.caseId}`, detail: redact(r.actual, 200) }))),
        sourceType: "EVALUATION",
        sourceId: ev.id,
        agentKey: ev.agentKey,
        workflow: ev.workflow,
        confidence: confidenceFrom(rows.length),
        createdBy: actor,
      },
    });
    created.push(entry);
  }
  if (created.length) await audit(companyId, actor, "KNOWLEDGE_PROPOSED", ev.id, `${created.length} from evaluation`);
  return created;
}

export async function reviewKnowledge(args: {
  companyId: string;
  id: string;
  action: "approve" | "reject" | "deprecate" | "edit" | "delete";
  reviewer: string;
  note?: string;
  edit?: { title?: string; lesson?: string; confidence?: "low" | "medium" | "high" };
}) {
  const entry = await prisma.knowledgeEntry.findFirst({ where: { id: args.id, companyId: args.companyId } });
  if (!entry) throw new Error("Knowledge entry not found");

  if (args.action === "delete") {
    await prisma.knowledgeEntry.delete({ where: { id: entry.id } });
    await audit(args.companyId, args.reviewer, "KNOWLEDGE_DELETED", entry.id, args.note ?? "");
    return { deleted: true };
  }
  if (args.action === "edit") {
    // Edits never mutate history: create a new PROPOSED entry that supersedes the old one.
    const next = await prisma.knowledgeEntry.create({
      data: {
        companyId: args.companyId,
        title: redact(args.edit?.title ?? entry.title, 200),
        lesson: redact(args.edit?.lesson ?? entry.lesson, 2000),
        evidence: entry.evidence,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        agentKey: entry.agentKey,
        workflow: entry.workflow,
        confidence: args.edit?.confidence ?? entry.confidence,
        createdBy: args.reviewer,
      },
    });
    await prisma.knowledgeEntry.update({ where: { id: entry.id }, data: { status: "DEPRECATED", supersededById: next.id, reviewedBy: args.reviewer, reviewNote: "superseded by edit" } });
    await audit(args.companyId, args.reviewer, "KNOWLEDGE_EDITED", entry.id, `superseded by ${next.id}`);
    return next;
  }

  const allowed: Record<string, KnowledgeStatus[]> = {
    approve: ["PROPOSED"],
    reject: ["PROPOSED"],
    deprecate: ["APPROVED", "PROPOSED"],
  };
  if (!allowed[args.action].includes(entry.status as KnowledgeStatus)) throw new Error(`Cannot ${args.action} an entry that is ${entry.status}`);
  const status = args.action === "approve" ? "APPROVED" : args.action === "reject" ? "REJECTED" : "DEPRECATED";
  const updated = await prisma.knowledgeEntry.update({
    where: { id: entry.id },
    data: { status, reviewedBy: args.reviewer, reviewNote: redact(args.note ?? "", 500), lastVerifiedAt: status === "APPROVED" ? new Date() : entry.lastVerifiedAt },
  });
  await audit(args.companyId, args.reviewer, `KNOWLEDGE_${status}`, entry.id, args.note ?? "");
  return updated;
}

/** Only APPROVED, non-superseded entries are usable as shared knowledge. */
export async function approvedKnowledge(companyId: string, agentKey?: string) {
  return prisma.knowledgeEntry.findMany({
    where: { companyId, status: "APPROVED", supersededById: null, ...(agentKey ? { OR: [{ agentKey }, { agentKey: null }] } : {}) },
    orderBy: { lastVerifiedAt: "desc" },
  });
}
