import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess, requirePermission } from "@/lib/auth/authz";
import { listSecrets, putSecret, secretsConfigured } from "@/lib/security/secrets";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Secret names and timestamps (never values). Any member can see which names exist. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const cfg = secretsConfigured();
  return ok({ configured: cfg.configured, reason: cfg.configured ? null : cfg.reason, secrets: cfg.configured ? await listSecrets(id) : [] });
});

const Schema = z.object({ name: z.string().min(1).max(64), value: z.string().min(1).max(16384) });

/** Create or replace a secret (secret.manage). The value is encrypted immediately and is write-only from then on. */
export const PUT = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requirePermission(id, "secret.manage");
  const { name, value } = await parseBody(req, Schema);
  return ok(await putSecret(id, name, value, user.email));
});
