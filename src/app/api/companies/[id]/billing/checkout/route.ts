import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { startPlanChange } from "@/lib/billing/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ plan: z.enum(["pro", "team"]), interval: z.enum(["month", "year"]).default("month") });

/**
 * Start a subscription (provider Checkout URL) or change an existing one in
 * place (prorated). billing.manage (ADMIN+). Access changes only when the
 * signed webhook arrives or the provider is queried server-side.
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requirePermission(id, "billing.manage");
  const { plan, interval } = await parseBody(req, Schema);
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  return ok(await startPlanChange(id, user, plan, interval, origin));
});
