import { test, expect } from "@playwright/test";
import { loginAs } from "./users";

/**
 * Acceptance scenario in a real browser (1440×900): create the checkout
 * validation mission from the UI, approve the plan, let the real engine run,
 * then inspect the collaboration timeline, a handoff, a task run's context,
 * the evidence-backed reviewer finding and its repair, and the report.
 */
// Own user (not the shared storageState) so tour/onboarding state doesn't leak into other specs.
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

const OBJECTIVE = "Inspect the checkout module, identify the cause of a failing validation test, implement a minimal fix, run the relevant tests, and explain the result.";

test("multi-agent mission: plan → QA → review finding → repair → report", async ({ page }) => {
  test.setTimeout(300_000);
  const request = page.request;
  await loginAs(request, "collab");
  const status = await (await request.get("/api/ai/status")).json();
  const docker = status.data.sandbox === "docker";

  const created = await request.post("/api/companies", { data: { name: "Collab E2E", mission: "verify collaboration", industry: "Fintech" } });
  const companyId = (await created.json()).data.id as string;
  await request.post("/api/onboarding", { data: { action: "skip" } });

  await page.goto(`/app/${companyId}/missions`);
  await page.getByRole("button", { name: "New mission" }).click();
  await page.getByLabel("Objective").fill(OBJECTIVE);
  await page.getByRole("button", { name: "Create and plan" }).click();
  await page.waitForURL(/\/missions\/[^/?]+$/);
  await expect(page.getByTestId("plan-approval")).toBeVisible();

  // Capability-based assignment is visible before approval.
  await page.locator('[data-task="review"]').click();
  await expect(page.getByTestId("task-detail")).toContainText("reviewer handles REVIEW");
  await page.locator('[data-task="fix"]').click();
  await expect(page.getByTestId("task-detail")).toContainText("src/checkout/validation.js");

  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(page.getByTestId("mission-status")).toContainText(docker ? "completed" : "failed", { timeout: 180_000 });

  await page.getByRole("tab", { name: "Collaboration" }).click();
  const tl = page.getByTestId("collab-timeline");
  await expect(tl).toBeVisible();
  await expect(tl).toContainText("approved plan");
  if (!docker) {
    await expect(tl).toContainText("sandbox_failure");
    return;
  }
  await expect(tl).toContainText("requested changes");
  await expect(tl).toContainText("raised finding F-1");
  await expect(tl).toContainText("verified F-1 resolved");
  await expect(page.getByTestId("findings")).toContainText("resolved");
  await expect(page.getByTestId("findings")).toContainText("none — not acted on");
  await page.screenshot({ path: "e2e/screenshots/collaboration.png" });

  // Inspect a run: context provenance + validated output.
  await page.getByRole("button", { name: "inspect run" }).nth(4).click();
  const insp = page.getByTestId("inspector");
  await expect(insp).toContainText("Context received");
  await expect(insp).toContainText("output valid");
  await page.screenshot({ path: "e2e/screenshots/collaboration-run.png" });

  // Inspect a handoff.
  await page.getByRole("button", { name: /handoff →/ }).first().click();
  await expect(insp).toContainText("validated");

  await page.getByRole("tab", { name: "Report" }).click();
  await expect(page.getByTestId("mission-report")).toBeVisible();
  await expect(page.locator('[data-criterion="met"]')).toHaveCount(3);
  await expect(page.locator('[data-criterion="not met"]')).toHaveCount(0);

  // Survives refresh: the timeline is persisted state.
  await page.reload();
  await page.getByRole("tab", { name: "Collaboration" }).click();
  await expect(page.getByTestId("collab-timeline")).toContainText("raised finding F-1");

  await page.goto(`/app/${companyId}/missions`);
  await expect(page.getByTestId("mission-scorecards")).toContainText("reviewer");
});
