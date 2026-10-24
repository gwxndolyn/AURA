import { z } from "zod";
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { evidenceRoot } from "@/lib/builder/browser";
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
  const shot = new URL(req.url).searchParams.get("screenshot");
  if (shot !== null) {
    const r = (parseJSON<{ routes?: { screenshot: string | null }[] }>(b.browser, {}).routes ?? [])[Number(shot)];
    const root = resolve(evidenceRoot(), id, b.id);
    const file = r?.screenshot ? resolve(r.screenshot) : null;
    if (!file || !file.startsWith(root + sep)) throw new ApiError("Screenshot not found", 404);
    const buf = await readFile(file).catch(() => null);
    if (!buf) throw new ApiError("Screenshot expired or removed by retention", 404);
    return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  }
  const cmd = new URL(req.url).searchParams.get("command");
  if (cmd) {
    const c = await prisma.commandRun.findFirst({ where: { id: cmd, buildId: b.id, companyId: id } });
    return ok(c ? { id: c.id, command: c.command, exitCode: c.exitCode, timedOut: c.timedOut, output: c.output, truncated: c.truncated } : null);
  }
  const job = b.jobId ? await prisma.job.findFirst({ where: { id: b.jobId, companyId: id }, select: { status: true, attempts: true, maxAttempts: true, lastError: true, errorKind: true, runAt: true } }) : null;
  const defects = await prisma.defect.findMany({ where: { buildId: b.id, companyId: id }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, category: true, status: true, occurrences: true, commandRunId: true, fixedByCommandRunId: true } });
  const browser = parseJSON<{ routes?: { screenshot: string | null }[] }>(b.browser, {});
  // Screenshots are served through ?screenshot=<n> (tenant-checked); local file paths never leave the server.
  const shots = (browser.routes ?? []).map((r, i) => ({ ...r, screenshot: r.screenshot ? `/api/companies/${id}/builds/${b.id}?screenshot=${i}` : null }));
  return ok({ ...b, criteria: parseJSON(b.criteria, []), findings: parseJSON(b.findings, []), changed: parseJSON(b.changed, []), impact: parseJSON(b.impact, {}), orchestration: parseJSON(b.orchestration, {}), contextManifest: parseJSON(b.contextManifest, []), browser: { ...browser, routes: shots }, defects, job });
});

/** cancel (MEMBER) · retry a blocked/failed/cancelled run (MEMBER, quota-checked). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, buildId } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const { action } = await parseBody(req, z.object({ action: z.enum(["cancel", "retry"]) }));
  return ok(action === "cancel" ? await cancelBuild(id, buildId) : await retryBuild(id, buildId));
});
