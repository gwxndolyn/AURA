import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { addItem } from "@/lib/factory/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

const Add = z.object({
  parentKey: z.string().max(40),
  title: z.string().min(3).max(160),
  description: z.string().max(800).default(""),
  kind: z.enum(["DESIGN", "ARCHITECTURE", "FRONTEND", "BACKEND", "DATA", "TEST", "DOCS"]),
  acceptance: z.array(z.string().min(2).max(400)).min(1).max(6),
  dependsOn: z.array(z.string().max(40)).max(6).default([]),
  files: z.array(z.string().max(200)).max(8).default([]),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]).default("LOW"),
});

export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "MEMBER");
  const item = await addItem(id, productId, user.email, await parseBody(req, Add));
  return ok({ key: item.key, executable: item.executable }, { status: 201 });
});
