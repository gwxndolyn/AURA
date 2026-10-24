/** TEST DOUBLE — Stripe REST endpoints used by AURA (STRIPE_API_BASE), automated tests ONLY. */
import http from "node:http";
import { AddressInfo } from "node:net";

export async function startStripeDouble() {
  const calls: { method: string; path: string; body: URLSearchParams; idempotency?: string }[] = [];
  const subscriptions = new Map<string, { id: string; status: string; customer: string; cancel_at_period_end: boolean; current_period_end: number; items: { data: { id: string; price: { id: string; recurring: { interval: string } } }[] } }>();
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      calls.push({ method: req.method!, path: req.url!, body: p, idempotency: req.headers["idempotency-key"] as string | undefined });
      const send = (s: number, d: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(d));
      if (!/^Bearer sk_test_/.test(req.headers.authorization ?? "")) return send(401, { error: { message: "Invalid API Key" } });
      if (req.url === "/v1/customers") return send(200, { id: `cus_test_${++n}` });
      if (req.url === "/v1/checkout/sessions") return send(200, { id: `cs_test_${++n}`, url: `https://checkout.stripe.test/c/${n}` });
      if (req.url === "/v1/billing_portal/sessions") return send(200, { url: `https://billing.stripe.test/p/${++n}` });
      const m = req.url!.match(/^\/v1\/subscriptions\/([^/?]+)$/);
      if (m) {
        const sub = subscriptions.get(decodeURIComponent(m[1]));
        if (!sub) return send(404, { error: { message: "No such subscription" } });
        if (req.method === "POST") {
          const price = p.get("items[0][price]");
          if (price) sub.items.data[0].price = { id: price, recurring: { interval: /year/i.test(price) ? "year" : "month" } };
          if (p.get("cancel_at_period_end")) sub.cancel_at_period_end = p.get("cancel_at_period_end") === "true";
        }
        return send(200, sub);
      }
      send(404, { error: { message: "unknown" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    /** Seed a subscription the double will serve on GET/POST /v1/subscriptions/:id. */
    addSubscription: (id: string, customer: string, price: string, status = "active") => subscriptions.set(id, { id, status, customer, cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ id: `si_${id}`, price: { id: price, recurring: { interval: /year/i.test(price) ? "year" : "month" } } }] } }),
    subscriptions,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
