/**
 * Read models for the operations center. Every query is scoped by companyId,
 * and nested ids are re-checked against it (IDOR-safe).
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { ruleById } from "./rules";
import { recommendationsFor, decidePolicy, type PolicyLevel } from "./actions";

export interface FindingFilter {
  status?: string[];
  severity?: string[];
  category?: string[];
  resourceType?: string;
  since?: Date;
}

export async function listFindings(companyId: string, f: FindingFilter = {}) {
  const rows = await prisma.opsFinding.findMany({
    where: {
      companyId,
      ...(f.status?.length ? { status: { in: f.status } } : {}),
      ...(f.severity?.length ? { severity: { in: f.severity } } : {}),
      ...(f.category?.length ? { category: { in: f.category } } : {}),
      ...(f.resourceType ? { resourceType: f.resourceType } : {}),
      ...(f.since ? { lastObservedAt: { gte: f.since } } : {}),
    },
    orderBy: [{ lastObservedAt: "desc" }],
    take: 200,
  });
  return rows.map(({ evidence, facts, history, ...r }) => ({ ...r, evidenceCount: parseJSON<unknown[]>(evidence, []).length, factsPreview: parseJSON(facts, {}), historyCount: parseJSON<unknown[]>(history, []).length }));
}

/**
 * Resolve evidence refs into linkable items, verifying each one still exists
 * in THIS workspace (a ref to another tenant's row resolves to "not found").
 */
async function resolveEvidence(companyId: string, refs: { kind: string; id: string; label: string; detail?: string }[]) {
  return Promise.all(
    refs.map(async (e) => {
      let exists: boolean | null = null;
      let href: string | null = null;
      let missionId: string | null = null;
      switch (e.kind) {
        case "mission": {
          const m = await prisma.mission.findFirst({ where: { id: e.id, companyId }, select: { id: true } });
          exists = !!m;
          href = m ? `/missions/${m.id}` : null;
          break;
        }
        case "task": {
          const t = await prisma.missionTask.findFirst({ where: { id: e.id, companyId }, select: { missionId: true } });
          exists = !!t;
          missionId = t?.missionId ?? null;
          href = t ? `/missions/${t.missionId}` : null;
          break;
        }
        case "run": {
          const r = await prisma.missionTaskRun.findFirst({ where: { id: e.id, companyId }, select: { missionId: true, status: true, errorCategory: true, error: true, toolLog: true } });
          exists = !!r;
          missionId = r?.missionId ?? null;
          href = r ? `/missions/${r.missionId}?run=${e.id}` : null;
          if (r) return { ...e, exists, href, missionId, log: { status: r.status, errorCategory: r.errorCategory, error: r.error.slice(0, 500), tools: parseJSON<unknown[]>(r.toolLog, []).slice(0, 12) } };
          break;
        }
        case "finding": {
          const f = await prisma.missionFinding.findFirst({ where: { id: e.id, companyId }, select: { missionId: true } });
          exists = !!f;
          href = f ? `/missions/${f.missionId}` : null;
          break;
        }
        case "approval": {
          const a = await prisma.missionApproval.findFirst({ where: { id: e.id, companyId }, select: { missionId: true } });
          exists = !!a;
          href = a ? `/missions/${a.missionId}` : null;
          break;
        }
        case "deployment": {
          exists = !!(await prisma.deployment.findFirst({ where: { id: e.id, companyId }, select: { id: true } }));
          href = exists ? "/deployments" : null;
          break;
        }
        case "evaluation": {
          exists = !!(await prisma.evaluation.findFirst({ where: { id: e.id, companyId }, select: { id: true } }));
          href = exists ? "/intelligence" : null;
          break;
        }
        case "tool_call": {
          exists = !!(await prisma.toolCall.findFirst({ where: { id: e.id, run: { companyId } }, select: { id: true } }));
          break;
        }
        default:
          exists = null; // config values: not rows
      }
      return { ...e, exists, href, missionId };
    }),
  );
}

export async function findingDetail(companyId: string, findingId: string, role: string) {
  const f = await prisma.opsFinding.findFirst({ where: { id: findingId, companyId } });
  if (!f) return null;
  const rule = ruleById(f.ruleId);
  const mon = await prisma.opsMonitor.findUnique({ where: { companyId } });
  const level = (mon?.policyLevel ?? "RECOMMEND") as PolicyLevel;
  const recs = await recommendationsFor(f);
  const recsWithPolicy = await Promise.all(
    recs.map(async (r) => {
      const env = r.target.type === "deployment" ? (await prisma.deployment.findFirst({ where: { id: r.target.id, companyId }, select: { env: true } }))?.env : undefined;
      return { ...r, policy: decidePolicy({ level, action: r.action, trigger: "user", role, allowedAuto: [], autoActionsLastHour: 0, maxAutoPerHour: 0, target: { ...r.target, env } }) };
    }),
  );
  const actions = await prisma.opsAction.findMany({ where: { companyId, findingId }, orderBy: { createdAt: "desc" }, take: 30 });
  return {
    ...f,
    evidence: await resolveEvidence(companyId, parseJSON(f.evidence, [])),
    facts: parseJSON<Record<string, unknown>>(f.facts, {}),
    history: parseJSON<unknown[]>(f.history, []),
    rule: rule ? { id: rule.id, version: rule.version, title: rule.title, definition: rule.definition, currentVersion: rule.version !== f.ruleVersion ? rule.version : null } : null,
    recommendations: recsWithPolicy,
    actions: actions.map((a) => ({ ...a, target: parseJSON(a.target, {}), result: parseJSON(a.result, {}) })),
    policyLevel: level,
  };
}

export async function recentOpsEvents(companyId: string, opts: { severity?: string[]; since?: Date } = {}) {
  return prisma.simulationEvent.findMany({
    where: { companyId, severity: opts.severity?.length ? { in: opts.severity } : { not: null }, ...(opts.since ? { createdAt: { gte: opts.since } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, type: true, message: true, level: true, severity: true, source: true, resourceType: true, resourceId: true, resolution: true, meta: true, createdAt: true },
  });
}
