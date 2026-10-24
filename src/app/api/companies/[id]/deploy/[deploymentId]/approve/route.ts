import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { resolveApproval } from "@/lib/workflows/approval";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string; deploymentId: string }> };

const Schema = z.object({ decision: z.enum(["approve", "reject"]).default("approve") });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id, deploymentId } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const { decision } = await parseBody(req, Schema).catch(() => ({ decision: "approve" as const }));
  const result = await resolveApproval(id, deploymentId, decision);
  return ok(result);
});
