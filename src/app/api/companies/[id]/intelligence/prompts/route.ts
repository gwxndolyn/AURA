import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { listTemplates, createVersion } from "@/lib/intelligence/registry";
import { redact } from "@/lib/intelligence/redact";
import { domain } from "../_shared";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const CreateVersionSchema = z.object({
  templateKey: z.string().min(1).max(120),
  content: z.string().min(20).max(8000),
  changelog: z.string().min(3).max(1000),
  outputContract: z.string().max(2000).optional(),
});

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const [templates, promotions] = await Promise.all([
    listTemplates(id),
    prisma.promptPromotion.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return ok({ templates, promotions });
});

/** Create a new immutable DRAFT version. Prompt text is redacted for secrets. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, CreateVersionSchema);
  const content = redact(body.content, 8000);
  const v = await domain(() =>
    createVersion({ companyId: id, templateKey: body.templateKey, content, changelog: body.changelog, outputContract: body.outputContract, author: user.userId }),
  );
  return ok(v, { status: 201 });
});
