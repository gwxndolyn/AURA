import { test, expect, request } from "@playwright/test";

/**
 * Core user-journey E2E against the real running app + real DB. Drives the API
 * for the heavy workflows (deterministic, fast) and the browser for the UI, so
 * the whole path is exercised end to end.
 */

const BASE = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

test("landing page sells the product and links to signup", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /your ai team/i })).toBeVisible();
  await expect(page.getByTestId("hero-start")).toHaveAttribute("href", "/register");
  for (const href of ["/pricing", "/docs", "/terms", "/privacy", "/security"]) {
    const r = await page.request.get(href);
    expect(r.status(), href).toBe(200);
  }
});

// The remaining journeys exercise the legacy simulation lab (company simulator).
test.describe("simulation lab", () => {
  test.skip(process.env.AURA_SIMULATION_LAB !== "1", "Simulation lab disabled (set AURA_SIMULATION_LAB=1 for the server and this run)");

test("onboarding creates a company and opens its dashboard", async ({ page }) => {
  await page.goto("/onboarding");
  // Step 1: name
  await page.getByPlaceholder("e.g. NOVA").fill("E2E Corp");
  await page.getByRole("button", { name: /^next/i }).click(); // -> industry
  // Step 2: industry (default pre-selected) -> mission
  await page.getByRole("button", { name: /^next/i }).click();
  // Step 3: mission
  await page.locator("textarea").fill("End to end testing company mission");
  await page.getByRole("button", { name: /^next/i }).click(); // -> capital
  await page.getByRole("button", { name: /^next/i }).click(); // -> personality
  await page.getByRole("button", { name: /^next/i }).click(); // -> autonomy
  await page.getByRole("button", { name: /launch company/i }).click();

  await page.waitForURL(/\/app\/.+/, { timeout: 30000 });
  await expect(page.getByText("E2E Corp").first()).toBeVisible({ timeout: 20000 });
});

test("full workflow via API: create -> build -> attack/defend -> analytics", async () => {
  const api = await request.newContext({ baseURL: BASE, storageState: "e2e/.auth/state.json" });

  // Create
  const created = await api.post("/api/companies", {
    data: { name: "E2E Flow", mission: "verify full flow", industry: "Fintech" },
  });
  expect(created.ok()).toBeTruthy();
  const companyId = (await created.json()).data.id as string;

  // Plan a goal -> tasks exist
  const planned = await api.post(`/api/companies/${companyId}/plan`, { data: { goal: "Build the MVP" } });
  expect(planned.ok()).toBeTruthy();
  const plan = (await planned.json()).data;
  expect(plan.taskIds.length).toBeGreaterThan(0);

  // Execute one task through the quality gate
  const tasksRes = await api.get(`/api/companies/${companyId}/tasks`);
  const firstTask = (await tasksRes.json()).data[0];
  const exec = await api.post(`/api/companies/${companyId}/tasks/${firstTask.id}/execute`);
  expect(exec.ok()).toBeTruthy();
  const execData = (await exec.json()).data;
  expect(["DONE", "REVIEW"]).toContain(execData.status);

  // Deploy
  const deploy = await api.post(`/api/companies/${companyId}/deploy`, { data: { env: "staging" } });
  expect(deploy.ok()).toBeTruthy();

  // Attack / defend cycle produces an incident + finding
  const attack = await api.post(`/api/companies/${companyId}/attack`, { data: {} });
  expect(attack.ok()).toBeTruthy();
  const atk = (await attack.json()).data;
  expect(atk.scenario.attackType).toBeTruthy();
  expect(typeof atk.securityScore).toBe("number");

  const incidents = await api.get(`/api/companies/${companyId}/incidents`);
  expect((await incidents.json()).data.length).toBeGreaterThan(0);

  // Analytics reflects activity
  const analytics = await api.get(`/api/companies/${companyId}/analytics?range=30D`);
  expect(analytics.ok()).toBeTruthy();
  const an = (await analytics.json()).data;
  expect(an.dora.deploymentFrequency).toBeGreaterThan(0);

  await api.dispose();
});

test("autonomous stress test passes all invariants", async () => {
  const api = await request.newContext({ baseURL: BASE, storageState: "e2e/.auth/state.json" });
  const created = await api.post("/api/companies", {
    data: { name: "E2E Stress", mission: "stress", industry: "Fintech" },
  });
  const companyId = (await created.json()).data.id as string;

  const res = await api.post(`/api/companies/${companyId}/stress-test`, { timeout: 180000 });
  expect(res.ok()).toBeTruthy();
  const { report, invariants } = (await res.json()).data;

  // Every failure mode exercised + recovered.
  expect(report.permissionEnforced).toBe(true); // red-team blocked from deploy
  expect(report.selfHeal.status).toBe("DONE"); // dev bug self-healed
  expect(report.conflictChoice).toBeTruthy(); // conflict resolved
  expect(report.reassigned.reassigned).toBeGreaterThan(0); // agent reassignment
  expect(report.incident.verified).toBe(true); // security incident resolved
  expect(report.deploy.success).toBe(true); // deployment retried to success

  expect(invariants.allPassed).toBe(true);
  expect(invariants.tasksTerminal).toBe(true);
  expect(invariants.messagesStored).toBe(true);
  expect(invariants.noDuplicateExec).toBe(true);

  await api.dispose();
});

test("cyber range page renders topology and controls", async ({ page }) => {
  const api = await request.newContext({ baseURL: BASE, storageState: "e2e/.auth/state.json" });
  const created = await api.post("/api/companies", {
    data: { name: "E2E Range", mission: "range", industry: "SaaS" },
  });
  const companyId = (await created.json()).data.id as string;
  await api.dispose();

  // Heavy route (React Flow + dynamic import); allow generous first-compile time.
  await page.goto(`/app/${companyId}/cyber-range`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /cyber range/i })).toBeVisible({ timeout: 45000 });
  await expect(page.getByRole("button", { name: /run exercise/i })).toBeVisible({ timeout: 45000 });
});
});
