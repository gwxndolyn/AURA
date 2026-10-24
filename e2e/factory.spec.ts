import { test, expect } from "@playwright/test";
import { loginAs } from "./users";

/**
 * Product factory lifecycle in a real browser (1440×900), deterministic
 * (no API key → labelled template PM/designer; Docker runs the tests).
 * idea → brief → backlog → scope approval → design review → real code task
 * verified with sandbox evidence → commit on an isolated branch → release
 * candidate → approval → refresh/persistence → other workspace denied.
 */
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

test("idea → plan → approve → build/verify → release candidate → approval → isolation", async ({ page, browser }) => {
  test.setTimeout(420_000);
  const api = page.request;
  await loginAs(api, "factory");
  const docker = (await (await api.get("/api/ai/status")).json()).data.sandbox === "docker";
  test.skip(!docker, "Needs the Docker sandbox for real test execution");
  await api.post("/api/onboarding", { data: { action: "skip" } });
  const companyId = (await (await api.post("/api/companies", { data: { name: "Factory E2E", mission: "product factory", industry: "Education" } })).json()).data.id as string;

  // 1–4: idea → brief + backlog (labelled template), nothing runs yet.
  await page.goto(`/app/${companyId}/products`);
  await expect(page.getByText("No products yet")).toBeVisible();
  await page.getByRole("button", { name: "Use the example idea" }).click();
  await page.getByTestId("create-product").click();
  await page.waitForURL(/\/products\/[a-z0-9]+/, { timeout: 60_000 });
  const productId = page.url().split("/products/")[1].split("?")[0];
  await expect(page.getByText(/decision.* needs? you: Approve the MVP scope/)).toBeVisible();
  await expect(page.getByTestId("run-team")).toBeDisabled();
  await page.getByRole("tab", { name: "brief" }).click();
  await expect(page.getByTestId("brief")).toContainText("deterministic template — no model");
  await expect(page.getByTestId("brief")).toContainText("share at least one availability slot");
  await page.getByRole("tab", { name: "backlog" }).click();
  await expect(page.locator('[data-item="E1.S1.T3"]')).toHaveAttribute("data-status", "TODO");
  await page.locator('[data-item="E1.S1.T3"]').click();
  await expect(page.getByTestId("item-detail")).toContainText("sandbox tests");
  await page.screenshot({ path: "e2e/screenshots/factory-1-backlog.png" });

  // 5: scope approval gate.
  await page.getByRole("tab", { name: /approvals/ }).click();
  await page.getByTestId("approve-scope").click();
  await expect(page.locator('[data-approval="scope"]')).toHaveAttribute("data-status", "APPROVED");

  // 6: designer + architect artifacts; review the design visually and approve.
  await page.getByTestId("run-team").click();
  await page.getByRole("tab", { name: "design" }).click();
  await expect(page.getByTestId("wireframe")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("design")).toContainText("Your matches");
  await page.getByRole("button", { name: "mobile" }).first().click();
  await page.screenshot({ path: "e2e/screenshots/factory-2-design.png" });
  await page.getByTestId("approve-design").click();
  await expect(page.locator('[data-artifact="HANDOFF"]')).toBeVisible();
  await page.getByTestId("approve-architecture").click();
  await expect(page.locator('[data-artifact="ARCHITECTURE"][data-status="APPROVED"]')).toBeVisible();

  // 7–11: dependent code task runs as a real mission; probes catch the first fix; bounded repair; verified.
  for (let i = 0; i < 6; i++) {
    await page.getByTestId("run-team").click();
    await expect(page.getByTestId("run-team")).toBeEnabled({ timeout: 240_000 });
    const st = (await (await api.get(`/api/companies/${companyId}/products/${productId}`)).json()).data.items.find((x: { key: string }) => x.key === "E1.S1.T3").status;
    if (st === "VERIFIED") break;
  }
  await page.getByRole("tab", { name: "backlog" }).click();
  await expect(page.locator('[data-item="E1.S1.T3"]')).toHaveAttribute("data-status", "VERIFIED");
  await page.locator('[data-item="E1.S1.T3"]').click();
  const detail = page.getByTestId("item-detail");
  await expect(detail).toContainText("Docker sandbox");
  await expect(detail).toContainText("aura/e1.s1.t3");
  await expect(detail).toContainText(/[1-9] repair round/);
  // The frontend task has no executable codebase: honestly blocked, never "done".
  await expect(page.locator('[data-item="E1.S2.T1"]')).toHaveAttribute("data-status", "BLOCKED");
  await page.screenshot({ path: "e2e/screenshots/factory-3-verified.png" });

  // Repository: the verified change is a real commit on an isolated branch.
  await page.getByRole("tab", { name: "repository" }).click();
  await page.getByRole("button", { name: "aura/e1.s1.t3" }).click();
  await expect(page.getByTestId("branch-diff")).toContainText("Array.isArray");

  // 12–13: accept the non-executable task explicitly unverified, build the RC (re-tested), approve it.
  await page.getByRole("tab", { name: "backlog" }).click();
  await page.locator('[data-item="E1.S2.T1"]').click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Accept unverified" }).click();
  await expect(page.locator('[data-item="E1.S2.T1"]')).toHaveAttribute("data-status", "DONE_UNVERIFIED");
  await page.getByRole("tab", { name: "release" }).click();
  await expect(page.locator('[data-check="monitoring"]')).toHaveAttribute("data-status", "not_run");
  await page.getByRole("button", { name: "Build release candidate" }).click();
  await expect(page.getByTestId("release-candidate")).toContainText("Docker sandbox", { timeout: 120_000 });
  await page.getByRole("tab", { name: /approvals/ }).click();
  await page.getByTestId("approve-release_candidate").click();
  await expect(page.locator('[data-approval="release_candidate"]')).toHaveAttribute("data-status", "APPROVED");
  await page.getByRole("tab", { name: "release" }).click();
  await page.getByRole("button", { name: "Request production deploy" }).click();
  await page.getByRole("tab", { name: /approvals/ }).click();
  await expect(page.locator('[data-approval="deploy_production"]')).toContainText("Cannot execute");
  await page.screenshot({ path: "e2e/screenshots/factory-4-release.png", fullPage: true });

  // Persistence after refresh; lifecycle history recorded.
  await page.reload();
  await expect(page.locator('[data-approval="release_candidate"]')).toHaveAttribute("data-status", "APPROVED");
  await page.getByRole("tab", { name: "overview" }).click();
  await expect(page.getByTestId("transitions")).toContainText("RELEASE_READINESS");
  await expect(page.getByTestId("progress")).toHaveText("1/1");

  // Mobile layout is usable.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("overview")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/factory-5-mobile.png" });

  // 16: another workspace user cannot reach the product.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await loginAs(ctx.request, "other");
  expect((await ctx.request.get(`/api/companies/${companyId}/products/${productId}`)).status()).toBe(404);
  expect((await ctx.request.post(`/api/companies/${companyId}/products/${productId}/tick`, { data: {} })).status()).toBe(404);
  await ctx.close();
});
