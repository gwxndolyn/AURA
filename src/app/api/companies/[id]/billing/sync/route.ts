import { ok, handler } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { syncFromProvider } from "@/lib/billing/service";
import { rateLimit } from "@/lib/auth/rateLimit";
import { ApiError } from "@/lib/api";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Re-read the subscription from the payment provider (server-side; never trusts the browser). */
export const POST = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requirePermission(id, "billing.manage");
  if (!rateLimit(`billing-sync:${id}`, 10, 60_000).ok) throw new ApiError("Too many refreshes; try again in a minute", 429);
  return ok(await syncFromProvider(id));
});
