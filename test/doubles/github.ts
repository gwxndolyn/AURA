/**
 * TEST DOUBLE — GitHub REST API for automated tests ONLY (GITHUB_API_BASE).
 * Verifies the App JWT signature with the test key pair, issues installation
 * tokens, and keeps PR state in memory. Git transport itself is real: the
 * repository "clone_url" points at a local bare repo the test creates.
 */
import http from "node:http";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { AddressInfo } from "node:net";

export function testKeyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
}

export async function startGithubDouble(opts: { publicKey: string; installationId: number; account: string; repos: { full_name: string; default_branch: string; clone_url: string }[] }) {
  const prs: { number: number; head: string; base: string; title: string; state: string }[] = [];
  const tokens = new Set<string>();
  const calls: string[] = [];
  let revoked = false;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const url = new URL(req.url!, "http://x");
      calls.push(`${req.method} ${url.pathname}`);
      const jwtOk = () => {
        const [h, p, s] = auth.split(".");
        if (!s) return false;
        return createVerify("RSA-SHA256").update(`${h}.${p}`).verify(opts.publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
      };
      if (url.pathname.startsWith("/app/")) {
        if (!jwtOk()) return send(401, { message: "bad jwt" });
        if (url.pathname === `/app/installations/${opts.installationId}`) return send(200, { account: { login: opts.account } });
        if (url.pathname === `/app/installations/${opts.installationId}/access_tokens` && req.method === "POST") {
          if (revoked) return send(404, { message: "not found" });
          const t = `ghs_test_${Math.random().toString(36).slice(2)}`;
          tokens.add(t);
          return send(201, { token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() });
        }
        return send(404, { message: "not found" });
      }
      if (!tokens.has(auth)) return send(401, { message: "bad token" });
      if (url.pathname === "/installation/repositories") return send(200, { repositories: opts.repos.map((r) => ({ ...r, private: true })) });
      const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+))?$/);
      if (m) {
        if (!opts.repos.some((r) => r.full_name === m[1])) return send(404, { message: "Not Found" });
        if (req.method === "GET" && !m[2]) {
          const head = (url.searchParams.get("head") ?? "").split(":")[1];
          return send(200, prs.filter((p) => p.state === "open" && p.head === head).map((p) => ({ number: p.number, html_url: `https://github.test/${m[1]}/pull/${p.number}`, state: p.state })));
        }
        if (req.method === "POST") {
          const b = JSON.parse(body);
          const pr = { number: prs.length + 1, head: b.head, base: b.base, title: b.title, state: "open" };
          prs.push(pr);
          return send(201, { number: pr.number, html_url: `https://github.test/${m[1]}/pull/${pr.number}` });
        }
        const pr = prs.find((p) => p.number === Number(m[2]));
        if (!pr) return send(404, { message: "Not Found" });
        return send(200, { state: pr.state, merged: false, mergeable_state: "clean", html_url: `https://github.test/${m[1]}/pull/${pr.number}`, head: { sha: "abc123" } });
      }
      if (/\/commits\/[^/]+\/check-runs$/.test(url.pathname)) return send(200, { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] });
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, prs, calls, revoke: () => { revoked = true; tokens.clear(); }, close: () => new Promise<void>((r) => server.close(() => r())) };
}
