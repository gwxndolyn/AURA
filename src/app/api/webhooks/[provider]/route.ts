import { NextResponse } from "next/server";
import { handleWebhook } from "@/lib/factory/webhooks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ provider: string }> };

/**
 * Public webhook receiver (no session). Authenticity is proven by the
 * provider signature against the connected repository's secret; duplicate
 * deliveries are acknowledged without side effects.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { provider } = await ctx.params;
  if (provider !== "github" && provider !== "gitlab") return NextResponse.json({ ok: false, error: "Unknown provider" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ ok: false, error: "Payload too large" }, { status: 413 });
  const h = req.headers;
  const r = await handleWebhook({
    provider,
    rawBody: raw,
    deliveryId: (provider === "github" ? h.get("x-github-delivery") : h.get("x-gitlab-event-uuid") ?? h.get("x-gitlab-webhook-uuid")) ?? "",
    eventHeader: (provider === "github" ? h.get("x-github-event") : h.get("x-gitlab-event")) ?? "",
    signature: provider === "github" ? h.get("x-hub-signature-256") : h.get("x-gitlab-token"),
  });
  return NextResponse.json({ ok: r.status < 400, data: { action: r.action }, error: r.status >= 400 ? r.detail : undefined }, { status: r.status });
}
