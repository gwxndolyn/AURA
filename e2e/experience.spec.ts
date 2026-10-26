import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loginAs } from "./users";

/**
 * V17 slice 5 — AURA audits its OWN workspace with the same checks it applies
 * to products: axe-core (WCAG 2.x A/AA rules) on the key screens, keyboard
 * reachability of the primary actions, and the product Experience tab's honest
 * empty state. Real server, real browser; no model calls.
 *
 * The axe gate fails on serious/critical violations; moderate/minor ones are
 * printed (and stored as an artifact) so they are visible, not hidden.
 */
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

const AXE = readFileSync(createRequire(join(process.cwd(), "package.json")).resolve("axe-core/axe.min.js"), "utf8");

async function axe(page: Page, name: string) {
  await page.addScriptTag({ content: AXE });
  const v = await page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return r.violations.map((x) => ({ id: x.id, impact: x.impact, help: x.help, targets: x.nodes.slice(0, 4).map((n) => n.target.join(" ")) }));
  });
  if (v.length) console.log(`[axe ${name}]`, JSON.stringify(v));
  return v;
}

test("AURA's own key screens: no serious/critical automated accessibility violations; primary actions reachable by keyboard; honest experience empty state", async ({ page }) => {
  test.setTimeout(240_000);
  await loginAs(page.request, "experience");
  const api = page.request;
  await api.post("/api/onboarding", { data: { action: "skip" } });
  const c = (await (await api.post("/api/companies", { data: { name: "Experience Co", mission: "m", industry: "Software" } })).json()).data.id;
  const serious = (vs: { impact: string }[]) => vs.filter((x) => x.impact === "serious" || x.impact === "critical");
  const report: Record<string, unknown> = {};

  // 1. Project creation.
  await page.goto(`/app/${c}/products`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  report.products = await axe(page, "products");
  // The idea field is the primary action's input: it must have an accessible name and be reachable by keyboard.
  const idea = page.getByRole("textbox").first();
  await expect(idea).toBeVisible();
  await expect(idea).toHaveAccessibleName(/.+/);
  await page.keyboard.press("Tab");
  let reached = false;
  for (let i = 0; i < 25 && !reached; i++) {
    reached = await idea.evaluate((el) => el === document.activeElement);
    if (!reached) await page.keyboard.press("Tab");
  }
  expect(reached, "the product idea field is reachable with the keyboard").toBe(true);

  // 2. A product workspace + its Experience tab (no audit yet → honest empty state).
  const pr = await api.post(`/api/companies/${c}/products`, { data: { idea: "A small notes app used to check AURA's own workspace experience." } });
  expect(pr.status()).toBe(201);
  const pid = (await pr.json()).data.id;
  await page.goto(`/app/${c}/products/${pid}`);
  await expect(page.getByRole("tab", { name: "experience" })).toBeVisible();
  report.product = await axe(page, "product");
  await page.getByRole("tab", { name: "experience" }).click();
  await expect(page.getByTestId("experience")).toBeVisible();
  await expect(page.getByText(/No completed audit yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Run experience audit" })).toBeVisible();
  report.experience = await axe(page, "experience");
  await page.screenshot({ path: "e2e/screenshots/experience-1-empty.png" });

  // 3. Runs + execution tabs (agent activity and decisions).
  await page.getByRole("tab", { name: "runs" }).click();
  report.runs = await axe(page, "runs");
  await page.getByRole("tab", { name: "execution" }).click();
  await expect(page.getByTestId("execution")).toBeVisible();
  report.execution = await axe(page, "execution");

  console.log("[aura self-audit]", JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, (v as { id: string; impact: string }[]).map((x) => `${x.id}:${x.impact}`)]))));
  for (const [k, v] of Object.entries(report)) expect(serious(v as { impact: string }[]), `${k}: serious/critical axe violations`).toEqual([]);
});
