/**
 * In-app notifications. One row per open condition (unique dedupe key), so a
 * finding that stays open never re-notifies. Escalation (severity increase)
 * updates the same row rather than adding a new one. No email/SMS — AURA has
 * no outbound messaging integration.
 */
import { prisma } from "@/lib/db";

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

interface FindingLike {
  id: string;
  dedupeKey: string;
  severity: string;
  title: string;
  explanation: string;
  requiresHuman: boolean;
}

export async function notifyForFinding(companyId: string, f: FindingLike, minSeverity = "high", escalation = false) {
  // Findings that need a person always notify; others only at/above the workspace threshold.
  if (!f.requiresHuman && (RANK[f.severity] ?? 0) < (RANK[minSeverity] ?? 2)) return;
  const kind = f.requiresHuman ? "intervention" : "finding";
  const data = { kind, severity: f.severity, title: escalation ? `Escalated: ${f.title}` : f.title, body: f.explanation.slice(0, 400), href: `/operations?finding=${f.id}`, findingId: f.id };
  const existing = await prisma.notification.findUnique({ where: { companyId_dedupeKey: { companyId, dedupeKey: f.dedupeKey } } });
  if (existing && !escalation) return;
  await prisma.notification.upsert({
    where: { companyId_dedupeKey: { companyId, dedupeKey: f.dedupeKey } },
    create: { companyId, dedupeKey: f.dedupeKey, ...data },
    update: { ...data, readBy: "[]", createdAt: new Date() },
  });
}

/** Condition cleared: drop the notification so a future recurrence notifies again. */
export async function resolveNotification(companyId: string, dedupeKey: string) {
  await prisma.notification.deleteMany({ where: { companyId, dedupeKey } });
}
