import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export interface SearchResult {
  type: "task" | "agent" | "project" | "incident" | "deployment" | "customer" | "decision" | "timeline";
  id: string;
  title: string;
  subtitle?: string;
  href: string; // relative to /app/:id
}

/** Global search across the company's entities. SQLite `contains` is case-insensitive for ASCII. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 1) return ok([] as SearchResult[]);

  const take = 6;
  const [tasks, agents, projects, incidents, deployments, customers, decisions, timeline] = await Promise.all([
    prisma.task.findMany({ where: { companyId: id, title: { contains: q } }, take, orderBy: { createdAt: "desc" } }),
    prisma.agent.findMany({ where: { companyId: id, OR: [{ name: { contains: q } }, { role: { contains: q } }] }, take }),
    prisma.project.findMany({ where: { companyId: id, name: { contains: q } }, take }),
    prisma.incident.findMany({ where: { companyId: id, title: { contains: q } }, take }),
    prisma.deployment.findMany({ where: { companyId: id, version: { contains: q } }, take }),
    prisma.customer.findMany({ where: { companyId: id, name: { contains: q } }, take }),
    prisma.decision.findMany({ where: { companyId: id, question: { contains: q } }, take }),
    prisma.timelineEvent.findMany({ where: { companyId: id, title: { contains: q } }, take }),
  ]);

  const results: SearchResult[] = [
    ...tasks.map((t) => ({ type: "task" as const, id: t.id, title: t.title, subtitle: `Task · ${t.status}`, href: "/projects" })),
    ...agents.map((a) => ({ type: "agent" as const, id: a.id, title: a.name, subtitle: a.role, href: "/agents" })),
    ...projects.map((p) => ({ type: "project" as const, id: p.id, title: p.name, subtitle: "Project", href: "/projects" })),
    ...incidents.map((i) => ({ type: "incident" as const, id: i.id, title: i.title, subtitle: `Incident #${i.number} · ${i.status}`, href: "/incidents" })),
    ...deployments.map((d) => ({ type: "deployment" as const, id: d.id, title: d.version, subtitle: `Deploy · ${d.env} · ${d.status}`, href: "/deployments" })),
    ...customers.map((c) => ({ type: "customer" as const, id: c.id, title: c.name, subtitle: `Customer · ${c.status}`, href: "/company" })),
    ...decisions.map((d) => ({ type: "decision" as const, id: d.id, title: d.question, subtitle: "Decision", href: "/decisions" })),
    ...timeline.map((t) => ({ type: "timeline" as const, id: t.id, title: t.title, subtitle: `Timeline · day ${t.simDay}`, href: "/activity" })),
  ];

  return ok(results);
});
