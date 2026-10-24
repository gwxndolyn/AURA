import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { loginAs } from "./users";

/**
 * Landing walkthrough + living office (part of the main suite):
 *   1. Landing: the team office (3D or 2D), keyboard selection, WebGL
 *      fallback and the small-screen office.
 *   3. Live office reflects a REAL mission: after plan approval and real
 *      engine steps, characters move to where their persisted tasks are, and
 *      the inspector links to the mission. Another workspace gets 404.
 */
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

async function login(api: APIRequestContext, who: "owner" | "outsider") {
  // Uses the main suite's registered pool (registration is rate-limited per IP); each spec creates its own workspace.
  await loginAs(api, who === "owner" ? "ops" : "other");
}

const next = (page: Page) => page.getByTestId("demo-next").click();

test("landing: the team office renders, characters are selectable, WebGL fallback and small screens get the 2D office", async ({ page, browser }) => {
  await page.goto("/");
  const office = page.getByTestId("office").first();
  await office.scrollIntoViewIfNeeded();
  await expect(office).toHaveAttribute("data-renderer", /3d|2d/);
  await page.goto("/?office=2d");
  await page.getByTestId("office").first().scrollIntoViewIfNeeded();
  await expect(page.getByTestId("office").first()).toHaveAttribute("data-renderer", "2d");
  const grid = page.getByTestId("office-2d");
  await grid.locator('button[data-agent="qa-engineer"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "QA engineer" })).toContainText("acceptance criterion");

  // No WebGL at all → 2D with an explanation.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    const proto = HTMLCanvasElement.prototype as unknown as { getContext: (type: string, ...rest: unknown[]) => unknown };
    const orig = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/.test(type)) return null;
      return orig.call(this, type, ...rest);
    };
  });
  const p2 = await ctx.newPage();
  await p2.goto("/");
  await p2.getByTestId("office").first().scrollIntoViewIfNeeded();
  await expect(p2.getByTestId("office").first()).toHaveAttribute("data-renderer", "2d");
  await expect(p2.getByTestId("office").first()).toContainText("WebGL is unavailable");
  await ctx.close();

  // Mobile: compact office, no horizontal overflow.
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  await mp.goto("/");
  expect(await mp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await mp.screenshot({ path: "e2e/screenshots/office-4-mobile.png", fullPage: true });
  await m.close();
});

test("live office reflects a real mission and is workspace-isolated", async ({ page, browser }) => {
  const api = page.request;
  await login(api, "owner");
  await api.post("/api/onboarding", { data: { action: "skip" } });
  const companyId = (await (await api.post("/api/companies", { data: { name: "Office E2E", mission: "office", industry: "SaaS" } })).json()).data.id as string;

  // Empty workspace: honest idle office.
  await page.goto(`/app/${companyId}/office`);
  await expect(page.getByTestId("live-office")).toBeVisible();
  await expect(page.getByTestId("office")).toHaveAttribute("data-renderer", "3d");
  await expect(page.getByTestId("team-list")).toContainText("No assigned work");
  await expect(page.locator('[data-testid=office] button[data-agent][data-activity="coding"]')).toHaveCount(0);

  // A real mission: create + plan + approve, then real engine steps.
  const created = await (await api.post(`/api/companies/${companyId}/missions`, { data: { objective: "Find and fix a validation bug in a sample checkout module: fix the failing validation test, run the tests.", plan: true } })).json();
  const missionId = created.data.id as string;
  expect((await api.post(`/api/companies/${companyId}/missions/${missionId}/plan`, { data: { action: "approve" } })).ok()).toBe(true);
  await api.post(`/api/companies/${companyId}/missions/${missionId}/advance`, { data: { steps: 1 } }); // requirements (PM)

  // The office state comes from the persisted rows; compare against the API.
  await page.reload();
  const snap = (await (await api.get(`/api/companies/${companyId}/office`)).json()).data;
  const tasks = snap.tasks as { key: string; status: string; agentKey: string }[];
  expect(tasks.find((t) => t.key === "requirements")?.status).toBe("SUCCEEDED");
  // Nobody is "coding" until a CODE_CHANGE task is actually RUNNING.
  const fixRunning = tasks.some((t) => t.key === "fix" && t.status === "RUNNING");
  expect(fixRunning).toBe(false);
  await expect(page.locator('[data-testid=office] button[data-agent="backend-engineer"]')).not.toHaveAttribute("data-activity", "coding");
  // The backend engineer has queued work from the real plan.
  await page.locator('[data-agent-row="backend-engineer"]').click();
  await expect(page.getByTestId("agent-inspector")).toContainText(/queued|waiting on dependencies/);
  await page.getByRole("button", { name: "Close details" }).click();
  // The PM shows the real recent completion and links to the mission.
  await page.locator('[data-agent-row="product-manager"]').click();
  const insp = page.getByTestId("agent-inspector");
  await expect(insp).toContainText("Clarify requirements");
  await expect(insp.getByRole("link", { name: /Open mission/ })).toHaveAttribute("href", `/app/${companyId}/missions/${missionId}`);
  await page.screenshot({ path: "e2e/screenshots/office-5-live.png" });

  // Area inspector + engineering-view links are always available.
  await page.getByRole("button", { name: "Close details" }).click();
  await page.locator('[data-testid=office] button[data-location="qa"]').click();
  await expect(page.getByTestId("location-inspector")).toContainText("Docker sandbox");
  await expect(page.getByRole("link", { name: /Code & reviews/ })).toHaveAttribute("href", `/app/${companyId}/code`);

  // Another workspace cannot read this office.
  const other = await browser.newContext();
  await login(other.request, "outsider");
  expect((await other.request.get(`/api/companies/${companyId}/office`)).status()).toBe(404);
  await other.close();
});
