/** TEST DOUBLE — Stripe REST endpoints used by AURA (STRIPE_API_BASE), automated tests ONLY. */
import http from "node:http";
import { AddressInfo } from "node:net";

export async function startStripeDouble() {
  const calls: { path: string; body: URLSearchParams; idempotency?: string }[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      calls.push({ path: req.url!, body: p, idempotency: req.headers["idempotency-key"] as string | undefined });
      const send = (s: number, d: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(d));
      if (!/^Bearer sk_test_/.test(req.headers.authorization ?? "")) return send(401, { error: { message: "Invalid API Key" } });
      if (req.url === "/v1/customers") return send(200, { id: `cus_test_${++n}` });
      if (req.url === "/v1/checkout/sessions") return send(200, { id: `cs_test_${++n}`, url: `https://checkout.stripe.test/c/${n}` });
      if (req.url === "/v1/billing_portal/sessions") return send(200, { url: `https://billing.stripe.test/p/${++n}` });
      send(404, { error: { message: "unknown" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}
