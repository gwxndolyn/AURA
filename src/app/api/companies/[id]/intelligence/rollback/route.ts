import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { rollbackVersion } from "@/lib/intelligence/experiments";
import { domain } from "../_shared";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const RollbackSchema = z.object({
  templateKey: z.string().min(1).max(120),
  targetVersionId: z.string().min(1).max(40),
  reason: z.string().min(3).max(500),
});

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const body = await parseBody(req, RollbackSchema);
  return ok(await domain(() => rollbackVersion({ companyId: id, ...body, actor: user.userId })));
});
