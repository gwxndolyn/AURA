import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { runSuite, loadState } from "@/lib/lab/lab";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const runId = new URL(req.url).searchParams.get("run");
  if (runId) {
    const r = await prisma.labRun.findFirst({ where: { id: runId, companyId: id }, include: { cases: { orderBy: { createdAt: "asc" } } } });
    if (!r) throw new ApiError("Run not found", 404);
    return ok({ ...r, metrics: parseJSON(r.metrics, {}), cases: r.cases.map((c) => ({ ...c, criteria: parseJSON(c.criteria, []), measures: parseJSON(c.measures, {}), commands: parseJSON(c.commands, []) })) });
  }
  return ok(await prisma.labRun.findMany({ where: { companyId: id }, orderBy: { startedAt: "desc" }, take: 50 }));
});

/** Run the benchmark suite under a configuration (ADMIN; seconds, bounded by AURA_LAB_MAX_RUN_MS). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const b = await parseBody(req, z.object({ config: z.string().max(120).default("default"), split: z.enum(["train", "heldout", "all"]).default("all") }));
  if ((await loadState(id)).status === "PAUSED") throw new ApiError("The improvement loop is paused", 409);
  const r = await runSuite({ companyId: id, configKey: b.config, split: b.split, actor: user.email });
  return ok({ runId: r.run.id, passed: r.run.passed, total: r.run.total, executor: r.run.executor }, { status: 201 });
});
