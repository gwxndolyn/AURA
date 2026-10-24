import { test, expect } from "@playwright/test";
import { loginAs } from "./users";

/**
 * Acceptance 19 in a real browser: the UI reflects persisted backend state.
 * The plan comes from the model provider test double (HTTP boundary); the
 * gate, memory and code map are read from the real API. No Docker needed:
 * nothing here claims an engineering run happened.
 */
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
const scenario = (name: string) => fetch("http://127.0.0.1:4010/__scenario", { method: "POST", body: JSON.stringify({ name }) });

test("quality gate, memory and code map show what the backend recorded; a requirement change shows up live", async ({ page }) => {
  test.setTimeout(240_000);
  await scenario("scamscout");
  await loginAs(page.request, "v3");
  const api = page.request;
  await api.post("/api/onboarding", { data: { action: "skip" } });
  const c = (await (await api.post("/api/companies", { data: { name: "V3 Co", mission: "m", industry: "Software" } })).json()).data.id;
  const p = (await (await api.post(`/api/companies/${c}/products`, { data: { idea: "A job scam checker: paste a listing, get a risk score with reasons." } })).json()).data.id;
  await page.goto(`/app/${c}/products/${p}`);
  await expect(page.getByRole("heading", { name: "ScamScout" })).toBeVisible({ timeout: 90_000 });

  // Quality gate: the UI's verdict equals the API's.
  const gate = (await (await api.get(`/api/companies/${c}/products/${p}/gate`)).json()).data;
  expect(gate.implemented).toBe(false);
  await page.getByRole("tab", { name: "quality" }).click();
  await expect(page.getByTestId("gate")).toHaveAttribute("data-implemented", "false");
  for (const crit of gate.criteria) await expect(page.locator(`[data-criterion="${crit.id}"]`)).toHaveAttribute("data-status", crit.status);
  await expect(page.locator('[data-criterion="journeys"]')).toContainText(/not deployed yet.*no browser automation/);
  await page.screenshot({ path: "e2e/screenshots/v3-1-quality-gate.png", fullPage: true });

  // Memory: brief assumptions are shown as assumptions, never as verified facts.
  await page.getByRole("tab", { name: "memory" }).click();
  await expect(page.getByTestId("memory")).toBeVisible();
  await expect(page.locator('[data-memory="assumption:A-1"]')).toHaveAttribute("data-status", "ASSUMPTION");
  await expect(page.locator('[data-status="VERIFIED"]')).toHaveCount(0);

  // Code map of the real repository.
  await page.getByRole("tab", { name: "code" }).click();
  await expect(page.getByTestId("code-map")).toContainText("GET /api/health");
  await expect(page.getByTestId("code-map")).toContainText("src/server.test.js");
  await page.screenshot({ path: "e2e/screenshots/v3-2-code-map.png", fullPage: true });

  // A requirement change (API) appears in the UI without a manual reload (SSE / polling).
  await page.getByRole("tab", { name: "quality" }).click();
  const d = (await (await api.get(`/api/companies/${c}/products/${p}`)).json()).data;
  const content = { ...d.brief.content, functional: [...d.brief.content.functional, { id: "FR-7", text: "Users can report a listing as a confirmed scam" }] };
  expect((await api.put(`/api/companies/${c}/products/${p}/brief`, { data: { content, expectedVersion: d.brief.version } })).status()).toBe(200);
  await expect(page.locator('[data-criterion="requirements"]')).toContainText("FR-7", { timeout: 30_000 });

  // Defects tab: honest empty state (no run has executed).
  await page.getByRole("tab", { name: "defects" }).click();
  await expect(page.getByText(/No defects recorded/)).toBeVisible();
});
