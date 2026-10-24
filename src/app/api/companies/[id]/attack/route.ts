import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { runAttackDefense } from "@/lib/workflows/security";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ attackType: z.string().max(80).optional() });

/** Launch a simulated attack/defense cycle inside the isolated cyber range. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema).catch(() => ({ attackType: undefined }));
  const result = await runAttackDefense(id, body);
  return ok(result);
});
