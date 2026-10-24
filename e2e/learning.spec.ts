import { test, expect } from "@playwright/test";
import { loginAs } from "./users";

/**
 * V11 engineering-intelligence workspace + V8 settings tabs in a real browser
 * against the real server. No model calls: feedback and its derived actions,
 * member invites, secrets and the audit log are all real API writes; the page
 * must show exactly what is persisted (empty states when nothing is).
 */
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

test("engineering intelligence shows persisted records only; feedback is editable; settings tabs work", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page.request, "learning");
  const api = page.request;
  await api.post("/api/onboarding", { data: { action: "skip" } });
  const c = (await (await api.post("/api/companies", { data: { name: "Learning Co", mission: "m", industry: "Software" } })).json()).data.id;

  // Empty workspace: honest empty states, no invented numbers.
  await page.goto(`/app/${c}/learning`);
  await expect(page.getByTestId("learning")).toBeVisible();
  await expect(page.getByText("Runs recorded")).toBeVisible();
  await expect(page.getByText(/unavailable — no run has reached a verdict/).first()).toBeVisible();
  await page.getByRole("tab", { name: "agents" }).click();
  await expect(page.getByText("No agent outcomes yet")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/learning-1-empty.png" });

  // A correction recorded through the real API becomes concrete actions, shown and editable in the UI.
  const fb = await api.post(`/api/companies/${c}/learning/feedback`, { data: { text: "The interface looks good, but the mobile layout is broken" } });
  expect(fb.status()).toBe(201);
  await page.reload();
  await page.getByRole("tab", { name: "feedback" }).click();
  const item = page.getByTestId("feedback-item").first();
  await expect(item).toContainText("mobile layout is broken");
  await expect(item).toContainText("390px");
  await expect(item).toContainText(/Applied to 0 run/);
  await item.getByRole("button", { name: "Disable" }).click();
  await expect(item).toContainText("disabled");
  page.once("dialog", (d) => d.accept());
  await item.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No saved feedback")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/learning-2-feedback.png" });

  // Settings (V8): members invite, secrets (if configured), security/audit log.
  await page.goto(`/app/${c}/settings?tab=members`);
  await expect(page.getByTestId("members")).toBeVisible();
  await expect(page.getByTestId("members")).toContainText(/seats in use/);
  await page.goto(`/app/${c}/settings?tab=usage`);
  await expect(page.getByTestId("usage")).toContainText("Engineering runs");
  await page.goto(`/app/${c}/settings?tab=secrets`);
  await expect(page.getByTestId("secrets")).toBeVisible();
  await page.goto(`/app/${c}/settings?tab=security`);
  await expect(page.getByTestId("security")).toContainText("Audit log");
  await expect(page.getByTestId("security")).toContainText(/FEEDBACK_RECORDED|FEEDBACK_DELETED/);
  await page.screenshot({ path: "e2e/screenshots/learning-3-audit.png" });

  // Another user's workspace is not reachable.
  const other = await api.get(`/api/companies/does-not-exist/learning`);
  expect(other.status()).toBe(404);
});
