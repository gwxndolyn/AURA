import { test, expect } from "@playwright/test";

/**
 * Demo journey in a real browser at laptop resolution: open the private demo,
 * handle the intro, run the example mission through the real engine, survive a
 * refresh, decide the gate, read the report. Assertions branch on whether the
 * Docker sandbox is available — never expecting fabricated success.
 */
test.use({ viewport: { width: 1440, height: 900 } });

test("demo workspace → example mission → approval → report", async ({ page, request }) => {
  test.skip(process.env.AURA_SIMULATION_LAB !== "1", "Simulation lab surface (set AURA_SIMULATION_LAB=1)");
  test.setTimeout(300_000);
  const status = await (await request.get("/api/ai/status")).json();
  const docker = status.data.sandbox === "docker";

  await page.goto("/app?demo=1");
  await page.waitForURL(/\/app\/[^/]+\/missions/, { timeout: 240_000 });

  // First visit: intro dialog, skippable.
  const intro = page.getByRole("dialog");
  await expect(intro).toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(intro).toBeHidden();

  // Seeded missions are listed and labelled read-only.
  await expect(page.getByText("sample · read-only").first()).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/missions.png" });

  // Tour remains reachable from help.
  await page.getByRole("button", { name: "Help and product tour" }).click();
  await expect(page.getByTestId("tour-checklist")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Run example mission" }).first().click();
  await page.waitForURL(/\/missions\/[^/?]+$/);
  await expect(page.getByTestId("plan-approval")).toBeVisible();
  await expect(page.getByTestId("mission-status")).toContainText("awaiting approval");
  await page.getByRole("button", { name: "Approve plan" }).click();

  // Execution advances; refresh mid-run and it resumes from persisted state.
  await expect(page.getByTestId("mission-status")).toContainText(/running|paused|failed/, { timeout: 60_000 });
  await page.reload();
  await expect(page.getByTestId("mission-status")).toContainText(docker ? "paused" : "failed", { timeout: 120_000 });

  if (!docker) {
    await page.getByRole("tab", { name: "Report" }).click();
    await expect(page.getByTestId("mission-report")).toBeVisible();
    await expect(page.locator('[data-criterion="met"]')).toHaveCount(0);
    return;
  }

  await expect(page.getByTestId("approval-gate")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/mission-gate.png" });
  await page.getByRole("tab", { name: /Evidence/ }).click();
  await expect(page.locator('[data-artifact="TEST_REPORT"]').first()).toContainText("executed · docker sandbox");
  await page.getByTestId("approval-gate").getByRole("button", { name: "Approve change" }).click();
  await expect(page.getByTestId("mission-status")).toContainText("completed", { timeout: 60_000 });
  await page.getByRole("tab", { name: "Report" }).click();
  const report = page.getByTestId("mission-report");
  await expect(report).toBeVisible();
  await expect(page.locator('[data-ledger="Human-approved"]')).toHaveText("1");
  await expect(page.locator('[data-ledger="Deployed"]')).toHaveText("0");
  await expect(page.locator('[data-criterion="met"]')).toHaveCount(5);
  await expect(page.locator('[data-criterion="not met"], [data-criterion="unverified"]')).toHaveCount(0);
  await page.screenshot({ path: "e2e/screenshots/report.png", fullPage: true });
});

test("unauthenticated users cannot reach mission APIs", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const r = await ctx.request.get("/api/companies/anything/missions");
  expect(r.status()).toBe(401);
  const d = await ctx.request.post("/api/demo");
  expect(d.status()).toBe(401);
  await ctx.close();
});
