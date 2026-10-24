import { ok, handler, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { subscriptionOf } from "@/lib/billing/entitlements";
import { createPortalSession } from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Stripe Billing Portal (payment method, invoices, plan changes, cancellation). ADMIN+. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "ADMIN");
  const sub = await subscriptionOf(id);
  if (!sub.stripeCustomerId) throw new ApiError("No billing account yet — choose a plan first", 409);
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  return ok(await createPortalSession({ customer: sub.stripeCustomerId, returnUrl: `${origin}/app/${id}/settings?tab=billing` }));
});
