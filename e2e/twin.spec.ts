import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAs } from "./users";

/**
 * Company twin acceptance scenario (real browser, 1440×900): Delivery Crunch.
 * Baseline → change QA capacity → isolated what-if → compare → timeline →
 * save → refresh → no live mutation → other workspace denied.
 */
test.skip(process.env.AURA_SIMULATION_LAB !== "1", "Simulation lab surface (set AURA_SIMULATION_LAB=1)");
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

async function liveSnapshot(api: APIRequestContext, companyId: string) {
  const missions = (await (await api.get(`/api/companies/${companyId}/missions`)).json()).data;
  const deployments = (await (await api.get(`/api/companies/${companyId}/deploy`)).json()).data;
  const agents = (await (await api.get(`/api/companies/${companyId}/agents`)).json()).data;
  return JSON.stringify({
    missions: (missions.missions ?? missions).map((m: { id: string; status: string; updatedAt?: string }) => [m.id, m.status, m.updatedAt]),
    deployments: (Array.isArray(deployments) ? deployments : deployments?.deployments ?? []).map((d: { id: string; status: string }) => [d.id, d.status]),
    agents: (Array.isArray(agents) ? agents : agents?.agents ?? []).map((a: { key: string; status: string; available: boolean }) => [a.key, a.status, a.available]),
  });
}

test("Delivery Crunch: baseline → what-if → compare → timeline → save → refresh → isolation", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const api = page.request;
  await loginAs(api, "ops");
  await api.post("/api/onboarding", { data: { action: "skip" } });
  const companyId = (await (await api.post("/api/companies", { data: { name: "Twin E2E", mission: "twin scenario", industry: "SaaS" } })).json()).data.id as string;
  // A real mission exists so we can prove the simulation never mutates it.
  await api.post(`/api/companies/${companyId}/missions`, { data: { objective: "Review the notification service design for scaling risks." } });
  const before = await liveSnapshot(api, companyId);

  // 1. Open the company simulation; the ops map shows real departments.
  await page.goto(`/app/${companyId}/twin`);
  await expect(page.getByTestId("ops-map")).toBeVisible();
  await page.locator('[data-dept="engineering"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("dept-panel")).toContainText("backend-engineer");
  await page.screenshot({ path: "e2e/screenshots/twin-1-map.png", fullPage: false });

  // 2–3. Documented initial state: synthetic items, dependencies, capacity, budget.
  const def = page.getByTestId("scenario-def");
  await expect(def).toContainText("Delivery Crunch");
  await expect(def).toContainText("seed 4242");
  const items = page.getByTestId("scenario-items");
  await expect(items).toContainText("SIM-CHECKOUT-V2");
  await expect(items).toContainText("SIM-PAYMENTS-API");
  await expect(items).toContainText("external until day 3");
  await expect(def).toContainText("budget $60,000");

  // 4–5. Baseline run with documented defaults; outcome persisted.
  const baseResp = page.waitForResponse((r) => r.url().endsWith("/twin/runs") && r.request().method() === "POST");
  await page.getByTestId("run-baseline").click();
  const baseline = (await (await baseResp).json()).data;
  expect(baseline.kind).toBe("baseline");
  await expect(page.locator('[data-run="baseline"]')).toHaveCount(1);
  await expect(page.locator('[data-run="baseline"]')).toContainText(/[0-2]\/3/);

  // 6–7. Change QA capacity, run an isolated what-if against the baseline.
  await page.getByTestId("cap-qa").fill("2");
  const wResp = page.waitForResponse((r) => r.url().endsWith("/twin/runs") && r.request().method() === "POST");
  await page.getByTestId("run-whatif").click();
  const whatIf = (await (await wResp).json()).data;
  expect(whatIf.baselineId).toBe(baseline.id);
  expect(whatIf.seed).toBe(baseline.seed);

  // 8. Comparison opens automatically, with decision diffs and rule-based explanations.
  const cmp = page.getByTestId("compare");
  await expect(cmp).toContainText("qa capacity 1 → 2 slots");
  await expect(cmp).toContainText("not a forecast");
  await expect(page.getByTestId("compare-explanation")).toContainText("SIM-CHECKOUT-V2");
  await cmp.getByRole("button", { name: "Explain" }).click();
  await expect(page.getByTestId("advice")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/twin-2-compare.png", fullPage: true });

  // 9. Timeline: simulation events labelled, filterable by run.
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.getByLabel("Simulation run").selectOption(whatIf.id);
  const tl = page.getByTestId("timeline");
  await expect(tl.locator('[data-type="verify_pass"]').first()).toBeVisible();
  await expect(tl.locator('[data-provenance="operational"]')).toHaveCount(0);
  await page.getByRole("group", { name: "Provenance" }).getByRole("button", { name: "operational" }).click();
  await page.getByLabel("Simulation run").selectOption("");
  await expect(tl.locator('[data-provenance="simulation"]')).toHaveCount(0);
  await page.screenshot({ path: "e2e/screenshots/twin-3-timeline.png", fullPage: false });

  // 10. Save the preferred scenario.
  await page.getByRole("tab", { name: "Scenarios" }).click();
  page.once("dialog", (d) => d.accept("Preferred: QA +1"));
  await page.getByRole("button", { name: `Save ${whatIf.label}` }).click();
  await expect(page.locator('[data-saved="true"]')).toContainText("Preferred: QA +1");

  // 11. Refresh: persisted.
  await page.reload();
  await expect(page.locator('[data-saved="true"]')).toContainText("Preferred: QA +1");
  const verify = await (await api.post(`/api/companies/${companyId}/twin/runs/${whatIf.id}`, { data: { action: "verify" } })).json();
  expect(verify.data.reproducible).toBe(true);

  // Metrics panel: definitions + explicit insufficient data on a new workspace.
  await page.getByRole("tab", { name: "Performance" }).click();
  await expect(page.locator('[data-metric="mission_failure_rate"]')).toContainText("insufficient data");

  // Small screens: the map scales and areas stay operable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Scenarios" }).click();
  await expect(page.locator('[data-dept="qa"]')).toBeVisible();
  await page.locator('[data-dept="qa"]').click();
  await expect(page.getByTestId("dept-panel")).toContainText("qa-engineer");
  await page.screenshot({ path: "e2e/screenshots/twin-4-mobile.png", fullPage: false });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 12. Nothing real was mutated.
  expect(await liveSnapshot(api, companyId)).toBe(before);

  // 13. A different workspace user cannot read the saved scenario.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await loginAs(ctx.request, "other");
  expect((await ctx.request.get(`/api/companies/${companyId}/twin/runs/${whatIf.id}`)).status()).toBe(404);
  expect((await ctx.request.get(`/api/companies/${companyId}/twin/compare?ids=${baseline.id},${whatIf.id}`)).status()).toBe(404);
  const otherCo = (await (await ctx.request.post("/api/companies", { data: { name: "Other twin", mission: "x", industry: "SaaS" } })).json()).data.id as string;
  expect((await ctx.request.get(`/api/companies/${otherCo}/twin/runs/${whatIf.id}`)).status()).toBe(404);
  await ctx.close();
});
