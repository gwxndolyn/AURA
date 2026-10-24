import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { askCeo } from "@/lib/workflows/decide";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ question: z.string().min(2).max(300) });

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const { question } = await parseBody(req, Schema);
  const result = await askCeo(id, question);
  return ok(result);
});
