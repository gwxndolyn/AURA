import { ok, handler } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { deleteSecret } from "@/lib/security/secrets";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; name: string }> };

export const DELETE = handler(async (_req, ctx: Ctx) => {
  const { id, name } = await ctx.params;
  const { user } = await requirePermission(id, "secret.manage");
  return ok(await deleteSecret(id, decodeURIComponent(name), user.email));
});
