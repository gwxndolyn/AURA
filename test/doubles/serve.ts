/**
 * Starts the provider test doubles as a standalone process for Playwright
 * e2e runs (AUTOMATED TESTS ONLY):
 *   model double  on :4010  → ANTHROPIC_BASE_URL=http://127.0.0.1:4010
 *   stripe double on :4011  → STRIPE_API_BASE=http://127.0.0.1:4011
 * Control endpoint: POST :4010/__scenario {"name":"scamscout"|"outage"}.
 */
import http from "node:http";
import { startAnthropicDouble } from "./anthropic";
import { startStripeDouble } from "./stripe";
import { scripted } from "./scamscout";
import { changeScripted } from "./scamscout-change";

(async () => {
  let current = changeScripted(scripted({ fixOnRepair: true })) as ReturnType<typeof scripted>;
  const model = await startAnthropicDouble((req) => current(req));
  const stripe = await startStripeDouble();
  const proxy = (target: string, port: number, control?: (body: string) => void) =>
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        if (control && req.url === "/__scenario") {
          control(body);
          res.writeHead(200).end("ok");
          return;
        }
        const r = await fetch(`${target}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "content-length", "connection"].includes(k)) as [string, string][]), body: ["GET", "HEAD"].includes(req.method!) ? undefined : body });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await r.arrayBuffer()));
      });
    }).listen(port, "127.0.0.1");
  proxy(model.url, 4010, (b) => {
    const name = JSON.parse(b || "{}").name;
    current = name === "outage" ? (() => ({ error: 529 })) as never : (changeScripted(scripted({ fixOnRepair: name !== "unfixable" })) as ReturnType<typeof scripted>);
  });
  proxy(stripe.url, 4011);
  console.log("doubles ready: model :4010, stripe :4011");
})();
