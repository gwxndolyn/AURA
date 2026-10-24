/** Read models for the product control centre (persisted state only). */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { PHASE_LABEL, progress, type Phase } from "./lifecycle";
import { AUTONOMY_HELP, ACTION_CLASS_HELP, type Autonomy } from "./policy";
import { remoteStatus } from "./git";
import { loadProduct, limitsOf } from "./store";

export async function listProducts(companyId: string) {
  const rows = await prisma.product.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 50 });
  const items = await prisma.backlogItem.findMany({ where: { companyId, productId: { in: rows.map((r) => r.id) } }, select: { productId: true, level: true, status: true, executable: true } });
  return rows.map((r) => {
    const mine = items.filter((i) => i.productId === r.id);
    return { id: r.id, title: r.title, phase: r.phase, phaseLabel: PHASE_LABEL[r.phase as Phase] ?? r.phase, status: r.status, autonomy: r.autonomy, scopeApproved: r.scopeApproved, createdAt: r.createdAt, progress: progress(mine), blocked: mine.filter((i) => i.status === "BLOCKED").length };
  });
}

export async function productDetail(companyId: string, productId: string) {
  const p = await loadProduct(companyId, productId);
  const [briefs, items, artifacts, transitions, approvals, repo, gitOps] = await Promise.all([
    prisma.productBrief.findMany({ where: { productId }, orderBy: { version: "desc" } }),
    prisma.backlogItem.findMany({ where: { productId }, orderBy: [{ priority: "asc" }, { key: "asc" }] }),
    prisma.productArtifact.findMany({ where: { productId }, orderBy: [{ kind: "asc" }, { version: "desc" }] }),
    prisma.lifecycleTransition.findMany({ where: { productId }, orderBy: { createdAt: "asc" } }),
    prisma.productApproval.findMany({ where: { productId }, orderBy: { createdAt: "desc" } }),
    p.repoId ? prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId } }) : null,
    prisma.gitOperation.findMany({ where: { productId, companyId }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  const missionIds = items.map((i) => i.missionId).filter(Boolean) as string[];
  const missions = missionIds.length ? await prisma.mission.findMany({ where: { id: { in: missionIds }, companyId }, select: { id: true, status: true, statusReason: true, costUsd: true, modelCalls: true, toolCalls: true, repairRounds: true } }) : [];
  const tasks = items.filter((i) => i.level === "TASK" || i.level === "REPAIR");
  const active = tasks.filter((t) => ["IN_PROGRESS", "IN_REVIEW"].includes(t.status));
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const brief = briefs[0];
  const toItem = (i: (typeof items)[number]) => ({
    ...i,
    acceptance: parseJSON<string[]>(i.acceptance, []), dependsOn: parseJSON<string[]>(i.dependsOn, []), capabilities: parseJSON<string[]>(i.capabilities, []),
    files: parseJSON<string[]>(i.files, []), verifyBy: parseJSON<string[]>(i.verifyBy, []), evidence: parseJSON<{ kind: string; ref: string; detail: string }[]>(i.evidence, []),
    history: parseJSON<{ at: string; actor: string; change: string }[]>(i.history, []), mission: missions.find((m) => m.id === i.missionId) ?? null,
  });
  const next = blocked.length ? `Resolve ${blocked.length} blocked task(s)` : approvals.some((a) => a.status === "PENDING") ? "Decide the pending approval(s)" : active.length ? `Agents are working on ${active.map((a) => a.key).join(", ")}` : p.scopeApproved ? "Run the next scheduler tick to dispatch ready work" : "Approve the scope to start";
  return {
    product: { ...p, limits: limitsOf(p), phaseLabel: PHASE_LABEL[p.phase as Phase] ?? p.phase, autonomyHelp: AUTONOMY_HELP[p.autonomy as Autonomy] },
    brief: brief ? { version: brief.version, source: brief.source, author: brief.author, note: brief.note, createdAt: brief.createdAt, content: parseJSON<Record<string, unknown>>(brief.content, {}) } : null,
    briefVersions: briefs.map((b) => ({ version: b.version, source: b.source, author: b.author, createdAt: b.createdAt, note: b.note })),
    items: items.map(toItem),
    artifacts: artifacts.map((a) => ({ ...a, content: parseJSON<Record<string, unknown>>(a.content, {}), feedback: parseJSON<{ at: string; by: string; text: string }[]>(a.feedback, []), consumedBy: parseJSON<string[]>(a.consumedBy, []) })),
    transitions: transitions.map((t) => ({ ...t, evidence: parseJSON<unknown[]>(t.evidence, []) })),
    approvals: approvals.map((a) => ({ ...a, risks: parseJSON<string[]>(a.risks, []), evidence: parseJSON<unknown[]>(a.evidence, []), classHelp: ACTION_CLASS_HELP[a.actionClass as keyof typeof ACTION_CLASS_HELP] })),
    repo: repo ? { id: repo.id, provider: repo.provider, name: repo.name, defaultBranch: repo.defaultBranch, remoteUrl: repo.remoteUrl, credentialEnv: repo.credentialEnv, webhookEnv: repo.webhookEnv, triggers: parseJSON<Record<string, string>>(repo.triggers, {}), detected: parseJSON<Record<string, unknown>>(repo.detected, {}), status: remoteStatus({ provider: repo.provider as "local", name: repo.name, remoteUrl: repo.remoteUrl, credentialEnv: repo.credentialEnv }) } : null,
    gitOps,
    overview: {
      phase: p.phase,
      milestone: brief ? parseJSON<{ milestones?: { id: string; name: string }[] }>(brief.content, {}).milestones?.[0] ?? null : null,
      progress: progress(items),
      active: active.map((a) => ({ key: a.key, title: a.title, status: a.status })),
      blocked: blocked.map((b) => ({ key: b.key, title: b.title, reason: b.blockedReason })),
      verified: tasks.filter((t) => t.status === "VERIFIED").map((t) => ({ key: t.key, title: t.title })),
      failedChecks: tasks.filter((t) => t.verification === "FAILED").map((t) => t.key),
      pendingApprovals: approvals.filter((a) => a.status === "PENDING").length,
      usage: { costUsd: missions.reduce((s, m) => s + m.costUsd, 0), modelCalls: missions.reduce((s, m) => s + m.modelCalls, 0), toolCalls: missions.reduce((s, m) => s + m.toolCalls, 0), note: "Estimated from token counts of recorded agent runs; not billed cost." },
      next,
    },
  };
}

/** Product timeline: lifecycle transitions, item history, approvals, git ops — all persisted. */
export async function productTimeline(companyId: string, productId: string) {
  const d = await productDetail(companyId, productId);
  const out: { at: string; kind: string; actor: string; text: string; ref?: string }[] = [];
  for (const t of d.transitions) out.push({ at: t.createdAt.toISOString(), kind: "phase", actor: t.actor, text: `${t.fromPhase} → ${t.toPhase}: ${t.reason}` });
  for (const i of d.items) for (const h of i.history) out.push({ at: h.at, kind: "item", actor: h.actor, text: `${i.key} ${h.change}`, ref: i.key });
  for (const a of d.approvals) {
    out.push({ at: a.createdAt.toISOString(), kind: "approval", actor: "system", text: `Approval requested: ${a.summary}` });
    if (a.decidedAt) out.push({ at: a.decidedAt.toISOString(), kind: "approval", actor: a.decidedBy ?? "", text: `${a.status.toLowerCase()}: ${a.summary}${a.note ? ` (${a.note})` : ""}` });
  }
  for (const g of d.gitOps) out.push({ at: g.createdAt.toISOString(), kind: "git", actor: "devops", text: `${g.op} ${g.branch ?? ""} ${g.sha?.slice(0, 8) ?? ""} ${g.status.toLowerCase()} ${g.detail}`.trim() });
  for (const a of d.artifacts) out.push({ at: a.createdAt.toISOString(), kind: "artifact", actor: a.producedBy, text: `${a.title} (${a.source}, ${a.status.toLowerCase()})` });
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300);
}
