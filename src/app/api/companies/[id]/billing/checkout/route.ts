import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { subscriptionOf } from "@/lib/billing/entitlements";
import { createCustomer, createCheckoutSession, billingConfigured } from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Start a Stripe Checkout session for a paid plan (ADMIN+). Access changes only when the signed webhook arrives. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const { plan } = await parseBody(req, z.object({ plan: z.enum(["pro", "team"]) }));
  if (!billingConfigured().configured) throw new ApiError("Billing is not configured on this server yet", 503);
  const sub = await subscriptionOf(id);
  let customer = sub.stripeCustomerId;
  if (!customer) {
    customer = (await createCustomer({ email: user.email, companyId: id })).id;
    await prisma.subscription.update({ where: { companyId: id }, data: { stripeCustomerId: customer } });
  }
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  const s = await createCheckoutSession({ customer, plan, companyId: id, successUrl: `${origin}/app/${id}/settings?tab=billing&checkout=success`, cancelUrl: `${origin}/app/${id}/settings?tab=billing&checkout=cancelled` });
  return ok({ url: s.url });
});
