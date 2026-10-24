import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { loginAs } from "./users";

/**
 * Autopilot control plane in a real browser against the real server. The web
 * server runs with AURA_WORKER=external, so there is NO worker until this test
 * starts one as a separate process: the page must show "offline" first, then
 * the real worker's heartbeat; a ping job proves it consumes the queue; the
 * kill switch is enforced on the server.
 */
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

test("worker offline → started → online and consuming jobs; kill switch holds work", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page.request, "autopilot");
  const api = page.request;
  await api.post("/api/onboarding", { data: { action: "skip" } });
  const c = (await (await api.post("/api/companies", { data: { name: "Autopilot Co", mission: "m", industry: "Software" } })).json()).data.id;
  await page.goto(`/app/${c}/autopilot`);
  await expect(page.getByTestId("autopilot")).toBeVisible();
  const first = (await (await api.get(`/api/companies/${c}/runtime`)).json()).data;
  const onlineBefore = first.workers.filter((w: { online: boolean }) => w.online).length;
  await expect(page.getByTestId("workers-summary")).toHaveAttribute("data-online", String(onlineBefore));
  if (onlineBefore === 0) await expect(page.getByTestId("workers-summary")).toContainText(/No worker is heart-beating/);

  // A ping queued while no worker runs stays QUEUED (nothing fakes progress).
  const ping1 = (await (await api.post(`/api/companies/${c}/runtime`, { data: { action: "ping" } })).json()).data.jobId;
  if (onlineBefore === 0) {
    await page.waitForTimeout(2500);
    expect((await (await api.get(`/api/companies/${c}/runtime/jobs/${ping1}`)).json()).data.status).toBe("QUEUED");
  }

  const worker = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/worker.ts"], { env: { ...process.env }, stdio: "ignore", detached: true });
  try {
    await expect.poll(async () => (await (await api.get(`/api/companies/${c}/runtime/jobs/${ping1}`)).json()).data.status, { timeout: 60_000 }).toBe("SUCCEEDED");
    await page.reload();
    await expect(page.getByTestId("workers-summary")).not.toHaveAttribute("data-online", "0", { timeout: 20_000 });
    await expect(page.locator('[data-testid="workers"] [data-online="true"]').first()).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/autopilot-1-online.png", fullPage: true });

    // Kill switch (admin): jobs of this workspace are no longer claimed.
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("kill-switch").click();
    await expect(page.getByTestId("autonomy")).toHaveAttribute("data-enabled", "false");
    const ping2 = (await (await api.post(`/api/companies/${c}/runtime`, { data: { action: "ping" } })).json()).data.jobId;
    await page.waitForTimeout(5000);
    expect((await (await api.get(`/api/companies/${c}/runtime/jobs/${ping2}`)).json()).data.status).toBe("QUEUED");
    await page.getByTestId("kill-switch").click();
    await expect.poll(async () => (await (await api.get(`/api/companies/${c}/runtime/jobs/${ping2}`)).json()).data.status, { timeout: 60_000 }).toBe("SUCCEEDED");
    const hist = (await (await api.get(`/api/companies/${c}/runtime/jobs/${ping2}`)).json()).data.events.map((e: { type: string }) => e.type);
    expect(hist).toEqual(["enqueued", "claimed", "succeeded"]);
  } finally {
    process.kill(-worker.pid!, "SIGTERM");
  }
});
