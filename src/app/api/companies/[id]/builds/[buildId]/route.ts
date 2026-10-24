import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { loadBuild, cancelBuild, retryBuild } from "@/lib/builder/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; buildId: string }> };

/** Run detail: phase, attempts, criteria with evidence, findings, every command with its exit code; ?command=<id> returns that command's output. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id, buildId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const b = await loadBuild(id, buildId);
  const cmd = new URL(req.url).searchParams.get("command");
  if (cmd) {
    const c = await prisma.commandRun.findFirst({ where: { id: cmd, buildId: b.id, companyId: id } });
    return ok(c ? { id: c.id, command: c.command, exitCode: c.exitCode, timedOut: c.timedOut, output: c.output, truncated: c.truncated } : null);
  }
  const job = b.jobId ? await prisma.job.findFirst({ where: { id: b.jobId, companyId: id }, select: { status: true, attempts: true, maxAttempts: true, lastError: true, errorKind: true, runAt: true } }) : null;
  const defects = await prisma.defect.findMany({ where: { buildId: b.id, companyId: id }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, category: true, status: true, occurrences: true, commandRunId: true, fixedByCommandRunId: true } });
  return ok({ ...b, criteria: parseJSON(b.criteria, []), findings: parseJSON(b.findings, []), changed: parseJSON(b.changed, []), impact: parseJSON(b.impact, {}), defects, job });
});

/** cancel (MEMBER) · retry a blocked/failed/cancelled run (MEMBER, quota-checked). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, buildId } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const { action } = await parseBody(req, z.object({ action: z.enum(["cancel", "retry"]) }));
  return ok(action === "cancel" ? await cancelBuild(id, buildId) : await retryBuild(id, buildId));
});
