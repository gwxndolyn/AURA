import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { makeDecision } from "@/lib/workflows/decide";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const decisions = await prisma.decision.findMany({
    where: { companyId: id },
    orderBy: { createdAt: "desc" },
  });
  return ok(decisions);
});

const Schema = z.object({ question: z.string().min(3).max(300) });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const { question } = await parseBody(req, Schema);
  const decision = await makeDecision(id, question);
  return ok(decision);
});
