import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { planSprint } from "@/lib/workflows/sprint";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ capacity: z.number().int().min(1).max(200).optional() });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema).catch(() => ({ capacity: undefined }));
  const result = await planSprint(id, body);
  return ok(result);
});
