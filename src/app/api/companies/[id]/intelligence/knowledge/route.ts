import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { proposeFromTask, proposeFromEvaluation } from "@/lib/intelligence/knowledge";
import { domain } from "../_shared";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const ProposeSchema = z.object({
  source: z.enum(["task", "evaluation"]),
  sourceId: z.string().min(1).max(40),
});

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  return ok(await prisma.knowledgeEntry.findMany({ where: { companyId: id, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 200 }));
});

/** Generate PROPOSED entries from a completed task or evaluation (never auto-approved). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, ProposeSchema);
  const created = await domain(async () =>
    body.source === "task" ? [await proposeFromTask(id, body.sourceId, user.userId)].filter(Boolean) : proposeFromEvaluation(id, body.sourceId, user.userId),
  );
  return ok(created, { status: 201 });
});
