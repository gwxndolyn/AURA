import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Agent + verification activity relevant to the project, from persisted rows:
 * task runs of project missions (with the files they read/wrote from the tool
 * log), checks, reviewer/QA findings, and file changes. Nothing synthesized.
 */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const missions = await prisma.mission.findMany({ where: { companyId: id, workspaceId: { not: null } }, select: { id: true, title: true }, orderBy: { createdAt: "desc" }, take: 10 });
  const ids = missions.map((m) => m.id);
  const [runs, findings, checks, changes] = await Promise.all([
    prisma.missionTaskRun.findMany({ where: { companyId: id, missionId: { in: ids } }, orderBy: { startedAt: "desc" }, take: 60, select: { id: true, missionId: true, taskKey: true, agentKey: true, status: true, outcome: true, errorCategory: true, toolLog: true, startedAt: true, completedAt: true } }),
    prisma.missionFinding.findMany({ where: { companyId: id, missionId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, missionId: true, code: true, title: true, severity: true, status: true, supported: true, file: true, createdAt: true } }),
    prisma.execRun.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, check: true, status: true, changeId: true, passed: true, total: true, createdAt: true } }),
    prisma.fileChange.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, path: true, status: true, author: true, history: true, createdAt: true } }),
  ]);
  const title = new Map(missions.map((m) => [m.id, m.title]));
  type Item = { id: string; at: string; actor: string; kind: string; text: string; status: string; open?: { type: "file" | "change" | "check" | "mission"; id: string; path?: string } };
  const items: Item[] = [];
  for (const r of runs) {
    const tools = parseJSON<{ tool: string; status: string }[]>(r.toolLog, []);
    const reads = tools.filter((t) => t.tool === "code.read").length;
    const writes = tools.filter((t) => t.tool === "code.write").length;
    items.push({ id: `run-${r.id}`, at: (r.completedAt ?? r.startedAt).toISOString(), actor: r.agentKey, kind: "run", text: `${r.taskKey}: ${r.outcome || r.status.toLowerCase()}${r.errorCategory ? ` (${r.errorCategory})` : ""}${reads ? ` · read ${reads} file(s)` : ""}${writes ? ` · wrote ${writes} file(s)` : ""} — ${title.get(r.missionId) ?? ""}`, status: r.status, open: { type: "mission", id: r.missionId } });
  }
  for (const f of findings) items.push({ id: `finding-${f.id}`, at: f.createdAt.toISOString(), actor: "reviewer", kind: "finding", text: `${f.code} [${f.severity}] ${f.title}${f.supported ? "" : " (unsupported — not acted on)"}`, status: f.status, open: f.file ? { type: "file", id: f.file, path: f.file } : { type: "mission", id: f.missionId } });
  for (const c of checks) items.push({ id: `check-${c.id}`, at: c.createdAt.toISOString(), actor: "sandbox", kind: "check", text: `${c.check}: ${c.status.toLowerCase()}${c.total !== null ? ` (${c.passed}/${c.total})` : ""}${c.changeId ? " on a proposed change" : ""}`, status: c.status, open: { type: "check", id: c.id } });
  for (const c of changes) for (const h of parseJSON<{ at: string; actor: string; change: string }[]>(c.history, [])) items.push({ id: `change-${c.id}-${h.at}`, at: h.at, actor: h.actor, kind: "change", text: `${h.change} — ${c.path}`, status: c.status, open: { type: "change", id: c.id } });
  items.sort((a, b) => b.at.localeCompare(a.at));
  return ok(items.slice(0, 80));
});
