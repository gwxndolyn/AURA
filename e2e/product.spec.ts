import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { loginAs } from "./users";

/**
 * Customer journeys in a real browser against the real app (dev server):
 *   9  landing → Start building → register → onboarding → first product
 *   1  the project persists after refresh
 *   2  the plan comes from the model provider (test double at the HTTP
 *      boundary), validated and saved
 *   3–5 a real engineering run: files written, a real failing npm test in the
 *      Docker sandbox, repair, re-verification, commit; the UI shows the
 *      persisted run and the real command output
 *   8  billing: checkout (Stripe test double) + signed webhook → Pro; an
 *      invalid signature is rejected
 *   7  another user gets 404 on the product
 *  10  provider outage → planning fails honestly with a retry path
 * Requires the doubles process (npm run test:doubles) and env:
 *   ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010
 *   STRIPE_* with STRIPE_API_BASE=http://127.0.0.1:4011, STRIPE_WEBHOOK_SECRET=whsec_e2e
 */
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
const scenario = (name: string) => fetch("http://127.0.0.1:4010/__scenario", { method: "POST", body: JSON.stringify({ name }) });

test("visitor → signup → plan → real engineering run → verified → billing → isolation", async ({ page, browser }) => {
  test.setTimeout(600_000);
  await scenario("scamscout");
  const docker = (await (await page.request.get("/api/ai/status")).json()).data.sandbox === "docker";

  // 9: landing sells the product; primary CTA leads to real signup.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /your ai team/i })).toBeVisible();
  await expect(page.getByText(/scripted|simulated|prototype/i)).toHaveCount(0);
  await page.screenshot({ path: "e2e/screenshots/product-1-landing.png" });
  await page.getByRole("link", { name: "See how it works" }).click();
  await expect(page.locator("#how")).toBeInViewport();
  await page.getByTestId("hero-start").click();
  await page.waitForURL(/\/register/);
  const email = `e2e_customer_${Date.now()}@aura.local`;
  await page.getByLabel("Name").fill("Casey");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Create account" }).click();

  // Onboarding → workspace + first product (real API calls).
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel("Workspace name").fill("Casey Labs");
  await page.getByRole("button", { name: "Example 1" }).click();
  await page.getByTestId("onboarding-submit").click();
  await page.waitForURL(/\/products\/[a-z0-9]+/, { timeout: 60_000 });
  const [, companyId, productId] = page.url().match(/\/app\/([^/]+)\/products\/([^/?]+)/)!;

  // 2: the plan appears when the planning job finishes (persisted, from the provider).
  await expect(page.getByText(/decision needs you: Approve the MVP scope for ScamScout/)).toBeVisible({ timeout: 60_000 });
  await page.reload(); // 1: persists across refresh
  await expect(page.getByRole("heading", { name: "ScamScout" })).toBeVisible();
  await page.getByRole("tab", { name: "brief" }).click();
  await expect(page.getByTestId("brief")).toContainText("drafted by the PM model");
  await page.getByRole("tab", { name: "backlog" }).click();
  await expect(page.locator('[data-item="E1.S1.T1"]')).toHaveAttribute("data-status", "TODO");

  // Billing (8): upgrade through Stripe test checkout; access changes only after the signed webhook.
  const api = page.request;
  const checkout = await (await api.post(`/api/companies/${companyId}/billing/checkout`, { data: { plan: "pro" } })).json();
  expect(checkout.data.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  expect((await (await api.get(`/api/companies/${companyId}/billing`)).json()).data.plan.id).toBe("free");
  const customer = (await (await api.get(`/api/companies/${companyId}/billing`)).json()).data.hasCustomer;
  expect(customer).toBe(true);
  const ev = (type: string, object: unknown) => JSON.stringify({ id: `evt_e2e_${type}_${Date.now()}`, type, data: { object } });
  const sign = (raw: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", "whsec_e2e").update(`${t}.${raw}`).digest("hex")}`; };
  const bad = ev("customer.subscription.updated", { id: "sub_e2e", status: "active", items: { data: [{ price: { id: "price_pro_e2e" } }] }, metadata: { companyId } });
  expect((await api.post("/api/billing/webhook", { data: bad, headers: { "stripe-signature": "t=1,v1=00", "content-type": "application/json" } })).status()).toBe(400);
  const good = ev("customer.subscription.updated", { id: "sub_e2e", customer: null, status: "active", current_period_end: Math.floor(Date.now() / 1000) + 2592000, items: { data: [{ price: { id: "price_pro_e2e" } }] }, metadata: { companyId } });
  expect((await api.post("/api/billing/webhook", { data: good, headers: { "stripe-signature": sign(good), "content-type": "application/json" } })).status()).toBe(200);
  await page.goto(`/app/${companyId}/settings?tab=billing`);
  await expect(page.getByTestId("billing")).toContainText("Pro");
  await page.screenshot({ path: "e2e/screenshots/product-2-billing.png" });

  // 3–5: approve scope, run the team; a real run in the sandbox.
  await page.goto(`/app/${companyId}/products/${productId}?tab=approvals`);
  await page.getByTestId("approve-scope").click();
  await expect(page.locator('[data-approval="scope"]')).toHaveAttribute("data-status", "APPROVED");
  test.skip(!docker, "Engineering runs need the Docker sandbox");
  await page.getByTestId("run-team").click();
  await expect(page.getByTestId("run-team")).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("tab", { name: "runs" }).click();
  await expect(page.getByTestId("run-detail")).toHaveAttribute("data-status", "VERIFIED", { timeout: 300_000 });
  const cmds = page.getByTestId("commands");
  await expect(cmds.locator('[data-command="test"][data-exit="1"]').first()).toBeVisible(); // the real failing run
  await expect(cmds.locator('[data-command="test"][data-exit="0"]').last()).toBeVisible();
  await cmds.locator('[data-command="test"][data-exit="1"]').first().click();
  await expect(cmds).toContainText("upfront payment is high risk");
  await page.screenshot({ path: "e2e/screenshots/product-3-run.png", fullPage: true });
  await page.getByTestId("run-team").click(); // settle from evidence
  await expect(page.getByTestId("run-team")).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("tab", { name: "backlog" }).click();
  await expect(page.locator('[data-item="E1.S1.T1"]')).toHaveAttribute("data-status", "VERIFIED", { timeout: 30_000 });

  // V7: release → configure a real Docker deployment target → deploy (admin approval) → verified live app.
  await page.getByRole("tab", { name: "release" }).click();
  await page.getByRole("button", { name: "Build release candidate" }).click();
  await expect(page.getByTestId("release-candidate")).toContainText("Docker sandbox", { timeout: 180_000 });
  await page.getByRole("tab", { name: /^approvals/ }).click();
  await page.getByTestId("approve-release_candidate").click();
  await page.getByRole("tab", { name: "deploy" }).click();
  const port = 22000 + Math.floor(Math.random() * 900);
  await page.getByLabel("Port").fill(String(port));
  await page.getByLabel(/Journey checks/).fill("/ | <html\n/api/assessments");
  await page.getByTestId("save-target").click();
  await expect(page.getByTestId("target")).toHaveAttribute("data-status", "CONNECTED", { timeout: 30_000 });
  await expect(page.locator('[data-check="tests"]')).toHaveAttribute("data-status", "passed");
  await page.getByTestId("request-deploy").click();
  await page.getByRole("tab", { name: /^approvals/ }).click();
  await page.getByTestId("approve-deploy_production").click();
  await page.getByRole("tab", { name: "deploy" }).click();
  await expect(page.getByTestId("live")).toHaveAttribute("data-live", "true", { timeout: 240_000 });
  await expect(page.getByTestId("live")).toContainText(`127.0.0.1:${port}`);
  const deployed = await fetch(`http://127.0.0.1:${port}/api/assessments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing: "Upfront Payment please" }) });
  expect((await deployed.json()).level).toBe("high");
  await page.screenshot({ path: "e2e/screenshots/product-5-deployed.png", fullPage: true });
  // Follow-up change request is accepted and planned against the existing code.
  await page.getByRole("tab", { name: "changes" }).click();
  await page.getByLabel("Describe a change").fill("Customers need to open a single past assessment: add GET /api/assessments/:id that returns one assessment, or 404 if it does not exist.");
  await page.getByTestId("submit-change").click();
  await expect(page.locator('[data-change="C1"]')).toHaveAttribute("data-status", "PLANNED", { timeout: 60_000 });
  await expect(page.locator('[data-change="C1"]')).toContainText("src/routes/assessments.js");

  // Code is tangible: download the source of the verified branch.
  const dl = await api.get(`/api/companies/${companyId}/products/${productId}/download?branch=aura/e1.s1.t1`);
  expect(dl.status()).toBe(200);
  expect(dl.headers()["content-type"]).toBe("application/gzip");

  // 7: another user cannot reach it.
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await loginAs(other.request, "other");
  expect((await other.request.get(`/api/companies/${companyId}/products/${productId}`)).status()).toBe(404);
  expect((await other.request.get(`/api/companies/${companyId}/builds`)).status()).toBe(404);
  await other.close();

  // Mobile layout of the run view.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/${companyId}`);
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/product-4-mobile.png" });
});

test("provider outage: planning fails honestly and can be retried", async ({ page }) => {
  test.setTimeout(240_000);
  await loginAs(page.request, "ops");
  const api = page.request;
  await api.post("/api/onboarding", { data: { action: "skip" } });
  await scenario("outage");
  const c = (await (await api.post("/api/companies", { data: { name: "Outage Co", mission: "m", industry: "Software" } })).json()).data.id;
  const p = (await (await api.post(`/api/companies/${c}/products`, { data: { idea: "A simple tool to track team lunch orders by person and day." } })).json()).data.id;
  await page.goto(`/app/${c}/products/${p}`);
  await expect(page.getByTestId("planning-status")).toContainText(/Planning failed: .*overloaded/i, { timeout: 200_000 });
  await scenario("scamscout");
  await page.getByRole("button", { name: "Retry planning" }).click();
  await expect(page.getByTestId("planning-status")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "ScamScout" })).toBeVisible();
});
