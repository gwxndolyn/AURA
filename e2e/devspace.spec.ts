import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAs } from "./users";

/**
 * Development workspace acceptance scenario (real browser, 1440×900):
 * "Find and fix a validation bug in a sample checkout module."
 * Real services: project file store, mission engine + agents, Docker sandbox,
 * change review/acceptance, tenant isolation.
 */
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

async function advanceUntilDone(api: APIRequestContext, companyId: string, missionId: string) {
  let status = "";
  for (let i = 0; i < 30; i++) {
    const r = await (await api.post(`/api/companies/${companyId}/missions/${missionId}/advance`, { data: { steps: 5 } })).json();
    status = r.data.status;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status) || !r.data.progressed) break;
  }
  return status;
}

test("inspect → mission patch → diff → sandbox tests → accept → state matches → isolation → refresh", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const api = page.request;
  await loginAs(api, "collab");
  const docker = (await (await api.get("/api/ai/status")).json()).data.sandbox === "docker";
  test.skip(!docker, "Needs the Docker sandbox for real test execution");
  await api.post("/api/onboarding", { data: { action: "skip" } });
  const companyId = (await (await api.post("/api/companies", { data: { name: "Dev E2E", mission: "devspace scenario", industry: "Fintech" } })).json()).data.id as string;

  // 1. Open the project; import the deterministic sample.
  await page.goto(`/app/${companyId}/code`);
  const imported = page.waitForResponse((r) => r.url().endsWith("/devspace/import") && r.request().method() === "POST", { timeout: 120_000 });
  await page.getByTestId("import-sample").click();
  expect((await imported).status()).toBe(200);
  const tree = page.getByRole("tree", { name: "Project files" });
  await expect(tree).toContainText("validation.js");

  // 2. Inspect source and tests in the real editor (read the actual content).
  await page.locator('[data-path="src/checkout/validation.js"]').click();
  await expect(page.getByTestId("code-editor")).toContainText("item.quantity < 0");
  await page.locator('[data-path="src/checkout/validation.test.js"]').click();
  await expect(page.getByTestId("code-editor")).toContainText("rejects a zero quantity");

  // Run the real suite in the sandbox on the current revision: it fails.
  const firstRun = page.waitForResponse((r) => r.url().endsWith("/devspace/checks") && r.request().method() === "POST", { timeout: 120_000 });
  await page.locator('[data-check="unit-tests"]').click();
  expect((await (await firstRun).json()).data.status).toBe("FAILED");
  await expect(page.getByTestId("run-status")).toHaveText("FAILED", { timeout: 120_000 });
  await expect(page.getByTestId("run-output")).toContainText("not ok");
  await expect(page.getByText(/Failed: .*rejects a zero quantity/)).toBeVisible();
  await expect(page.getByTestId("checks-panel")).toContainText("exit 1");

  // Unsupported check is labelled, not faked.
  const lintResp = page.waitForResponse((r) => r.url().endsWith("/devspace/checks") && r.request().method() === "POST");
  await page.locator('[data-check="lint"]').click();
  expect((await (await lintResp).json()).data.status).toBe("UNSUPPORTED");
  await expect(page.getByTestId("run-status")).toHaveText("UNSUPPORTED", { timeout: 15_000 });

  // 3–4. Mission with acceptance criteria; agents propose + apply a scoped patch in the mission working copy.
  const created = await api.post(`/api/companies/${companyId}/devspace/missions`, { data: { objective: "Find and fix a validation bug in a sample checkout module: inspect the checkout validation code, fix the failing validation test, run the tests." } });
  const missionId = (await created.json()).data.missionId as string;
  const plan = await (await api.get(`/api/companies/${companyId}/missions/${missionId}`)).json();
  expect(plan.data.acceptance.join()).toMatch(/failing validation test passes/);
  await api.post(`/api/companies/${companyId}/missions/${missionId}/plan`, { data: { action: "approve" } });
  expect(await advanceUntilDone(api, companyId, missionId)).toBe("COMPLETED");

  // 5. The agent's change appears for review with the actual diff; the project itself is untouched.
  await page.reload();
  const row = page.getByTestId("changes-list").locator('[data-change="VERIFIED"]').first();
  await expect(row).toContainText("src/checkout/validation.js", { timeout: 20_000 });
  await row.click();
  const diff = page.getByTestId("diff-editor");
  await expect(diff).toContainText("Number.isInteger(item.quantity)");
  await expect(diff).toContainText("item.quantity < 0"); // the removed line is shown
  const review = page.getByTestId("review-panel");
  await expect(review).toContainText("backend-engineer");
  await expect(review).toContainText("fix");
  await expect(review).toContainText("verified · not applied");
  await expect(review).toContainText("= base (not applied)");
  // Bounded repair happened inside the mission: reviewer findings were raised and resolved.
  await expect(review).toContainText(/reviewer finding\(s\) raised and resolved/);

  // 6–7. Verify the proposed change in the sandbox from the review panel.
  await page.getByTestId("verify-change").click();
  await expect(page.getByTestId("run-status")).toHaveText("PASSED", { timeout: 120_000 });
  await expect(page.getByTestId("checks-panel")).toContainText("exit 0");
  await page.getByRole("button", { name: "side by side" }).click();
  await page.screenshot({ path: "e2e/screenshots/devspace-review.png" });

  // 9–10. Accept (higher-risk path needs explicit confirmation).
  const accept = page.getByTestId("accept-change");
  await expect(accept).toBeDisabled();
  await page.getByTestId("confirm-risk").check();
  await accept.click();
  await expect(review).toContainText("accepted · applied", { timeout: 20_000 });
  // The diff stays visible after the decision (regression: merge view collapsed to zero height).
  await expect(diff).toContainText("Number.isInteger(item.quantity)");
  expect((await diff.boundingBox())!.height).toBeGreaterThan(200);

  // 11. Recorded state matches the actual file.
  const file = await (await api.get(`/api/companies/${companyId}/devspace/file?path=src/checkout/validation.js`)).json();
  expect(file.data.content).toContain("Number.isInteger(item.quantity) || item.quantity < 1");
  const changes = await (await api.get(`/api/companies/${companyId}/devspace/changes`)).json();
  // Exactly one review record for the mission's file (no duplicates from concurrent syncs).
  expect(changes.data.filter((c: { path: string }) => c.path === "src/checkout/validation.js")).toHaveLength(1);
  const accepted = changes.data.find((c: { status: string }) => c.status === "ACCEPTED");
  const detail = await (await api.get(`/api/companies/${companyId}/devspace/changes/${accepted.id}`)).json();
  expect(detail.data.current.matchesProposed).toBe(true);
  expect(detail.data.current.sha256).toBe(file.data.sha256);
  // The project's own suite now passes on the new revision.
  await page.locator('[data-check="unit-tests"]').click();
  await expect(page.getByTestId("run-status")).toHaveText("PASSED", { timeout: 120_000 });

  // Concurrent-edit detection from the editor: a stale save is refused.
  await page.locator('[data-path="src/checkout/validation.js"]').click();
  await expect(page.getByTestId("code-editor")).toContainText("Number.isInteger");
  const stale = await api.put(`/api/companies/${companyId}/devspace/file`, { data: { path: "src/checkout/validation.js", content: "// stale\n", expectedRev: 1 } });
  expect(stale.status()).toBe(409);

  // 13. Refresh: history persists.
  await page.reload();
  await page.getByRole("tab", { name: "changes" }).click();
  await page.getByTestId("changes-list").locator('[data-change="ACCEPTED"]').first().click();
  const hist = page.getByTestId("change-history");
  await expect(hist).toContainText("proposed");
  await expect(hist).toContainText(/accepted and applied as r\d+/);
  await page.screenshot({ path: "e2e/screenshots/devspace-accepted.png" });

  // 12. Another workspace cannot access the project, diff or logs.
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const o = other.request;
  await loginAs(o, "other");
  const otherWs = (await (await o.post("/api/companies", { data: { name: "Other", mission: "m", industry: "SaaS" } })).json()).data.id as string;
  const runId = (await (await api.get(`/api/companies/${companyId}/devspace/checks`)).json()).data[0].id;
  expect((await o.get(`/api/companies/${companyId}/devspace/file?path=src/checkout/validation.js`)).status()).toBe(404);
  expect((await o.get(`/api/companies/${otherWs}/devspace/changes/${accepted.id}`)).status()).toBe(404);
  expect((await o.get(`/api/companies/${otherWs}/devspace/checks/${runId}`)).status()).toBe(404);
  await other.close();
});
