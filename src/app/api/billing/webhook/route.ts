import { NextResponse } from "next/server";
import { handleStripeWebhook } from "@/lib/billing/webhooks";

export const dynamic = "force-dynamic";

/** Stripe webhook endpoint. Signature-verified against STRIPE_WEBHOOK_SECRET; idempotent per event id. */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
  const r = await handleStripeWebhook(raw, req.headers.get("stripe-signature"));
  return NextResponse.json({ ok: r.status < 400, data: { result: r.message } }, { status: r.status });
}
