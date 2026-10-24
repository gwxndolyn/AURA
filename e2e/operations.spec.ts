import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAs } from "./users";

/**
 * Operations acceptance scenario in a real browser (1440×900), using the real
 * engine, sandbox, health evaluator and action layer:
 *  1. create a mission whose test.run timeout is set below what the real
 *     Docker suite needs → the reproduce step genuinely times out
 *  2. evaluate → a "mission failed" finding with the real run as evidence
 *  3. inspect it in the UI; Observe policy blocks the recovery action
 *  4. switch to Recommend; run "retry with default tool timeouts"
 *  5. the mission recovers; re-evaluate → finding resolves by rule
 *  6. refresh: history persists; another workspace cannot see it
 */
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

const OBJECTIVE = "Inspect the checkout module, identify the cause of a failing validation test, implement a minimal fix, run the relevant tests, and explain the result.";

async function advanceUntil(api: APIRequestContext, companyId: string, missionId: string, done: (s: string) => boolean) {
  let status = "";
  for (let i = 0; i < 30; i++) {
    const r = await (await api.post(`/api/companies/${companyId}/missions/${missionId}/advance`, { data: { steps: 5 } })).json();
    status = r.data.status;
    if (done(status) || !r.data.progressed) break;
  }
  return status;
}

test("operational finding → policy block → allowed recovery → resolution", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const api = page.request;
  await loginAs(api, "ops");
  const docker = (await (await api.get("/api/ai/status")).json()).data.sandbox === "docker";
  test.skip(!docker, "Scenario needs the Docker sandbox to produce a real test.run timeout");
  await api.post("/api/onboarding", { data: { action: "skip" } });

  const companyId = (await (await api.post("/api/companies", { data: { name: "Ops E2E", mission: "ops scenario", industry: "Fintech" } })).json()).data.id as string;
  // 1. Real mission; test.run limited to 50 ms (the Docker suite needs ~400 ms+).
  const created = await api.post(`/api/companies/${companyId}/missions`, { data: { objective: OBJECTIVE, toolTimeouts: { "test.run": 50 } } });
  const missionId = (await created.json()).data.id as string;
  await api.post(`/api/companies/${companyId}/missions/${missionId}/plan`, { data: { action: "approve" } });
  expect(await advanceUntil(api, companyId, missionId, (s) => s === "FAILED")).toBe("FAILED");

  // Policy starts at Observe.
  const owner = await api.put(`/api/companies/${companyId}/ops/monitor`, { data: { policyLevel: "OBSERVE" } });
  expect(owner.ok()).toBeTruthy();

  // 2–3. Evaluate from the UI and inspect.
  await page.goto(`/app/${companyId}/operations`);
  await page.getByTestId("evaluate-now").click();
  const row = page.locator('[data-finding="mission.failed"]');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("tool_timeout");
  await row.click();
  const insp = page.getByTestId("finding-inspector");
  await expect(insp).toContainText("Mission failed at");
  const evidence = page.getByTestId("finding-evidence");
  await expect(evidence).toContainText("run");
  await expect(evidence).toContainText("timeout"); // the real tool log of the timed-out test.run
  const rec = page.locator('[data-action="retry_task_default_timeouts"]');
  await expect(rec).toHaveAttribute("data-decision", "blocked");
  await expect(rec.getByTestId("policy-reason")).toContainText("Observe");
  await page.screenshot({ path: "e2e/screenshots/operations-observe.png" });

  // 4. Restricted action attempted via the API → blocked and recorded.
  const findingId = new URL(page.url()).searchParams.get("finding")!;
  const blocked = await api.post(`/api/companies/${companyId}/ops/findings/${findingId}/actions`, { data: { action: "retry_task_default_timeouts" } });
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).data.policyRule).toBe("level_observe");

  // Allowed under Recommend.
  await api.put(`/api/companies/${companyId}/ops/monitor`, { data: { policyLevel: "RECOMMEND" } });
  await page.reload();
  await expect(rec).toHaveAttribute("data-decision", "allowed");
  await rec.getByRole("button", { name: "Run" }).click();
  await expect(page.getByTestId("finding-history")).toContainText("retry_task_default_timeouts: succeeded", { timeout: 30_000 });

  // Retried but not yet recovered: a re-evaluation must NOT resolve it.
  await page.getByTestId("evaluate-now").click();
  await expect(page.locator('[data-finding="mission.failed"]')).toHaveAttribute("data-status", "OPEN");

  // 5. Mission now actually recovers through the engine; re-evaluate → resolves by rule.
  const final = await advanceUntil(api, companyId, missionId, (s) => ["COMPLETED", "FAILED"].includes(s));
  expect(final).toBe("COMPLETED");
  await page.getByTestId("evaluate-now").click();
  await expect(page.getByTestId("finding-history")).toContainText("resolved", { timeout: 30_000 });
  await expect(page.getByTestId("finding-history")).toContainText(/mission is completed|recovered: reproduce/);
  await expect(insp).toContainText("Resolved by the rule");
  await expect(page.getByTestId("briefing-summary")).toContainText("No qualifying issues were detected", { timeout: 20_000 });
  await page.screenshot({ path: "e2e/screenshots/operations-resolved.png" });

  // 6. Refresh: history persists (blocked attempt, allowed action, resolution).
  await page.reload();
  const hist = page.getByTestId("finding-history");
  await expect(hist).toContainText("level_observe");
  await expect(hist).toContainText("succeeded");
  await expect(hist).toContainText("resolved");

  // Another workspace cannot access the finding or its evidence.
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const oapi = other.request;
  await loginAs(oapi, "other");
  const otherWs = (await (await oapi.post("/api/companies", { data: { name: "Other", mission: "m", industry: "SaaS" } })).json()).data.id as string;
  expect((await oapi.get(`/api/companies/${companyId}/ops/findings/${findingId}`)).status()).toBe(404);
  expect((await oapi.get(`/api/companies/${otherWs}/ops/findings/${findingId}`)).status()).toBe(404);
  expect((await oapi.get(`/api/companies/${companyId}/missions/${missionId}`)).status()).toBe(404);
  await other.close();
});

test("empty workspace says 'no qualifying issues', not 'healthy'", async ({ page }) => {
  const api = page.request;
  await loginAs(api, "ops"); // a brand-new company below is an empty workspace
  await api.post("/api/onboarding", { data: { action: "skip" } });
  const companyId = (await (await api.post("/api/companies", { data: { name: "Empty Ops", mission: "m", industry: "SaaS" } })).json()).data.id as string;
  await page.goto(`/app/${companyId}/operations`);
  await page.getByTestId("evaluate-now").click();
  await expect(page.getByTestId("briefing-summary")).toContainText("No qualifying issues were detected from the available evidence", { timeout: 30_000 });
  await expect(page.getByText(/all systems (are )?healthy/i)).toHaveCount(0);
});
