import { request, type FullConfig } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * The app requires authentication (middleware + requireWorkspaceAccess), so the
 * suite registers users through the real /api/auth/register route.
 *
 * Registration is rate-limited to 5/hour/IP (by design), so the suite
 * registers ONE shared user here plus a small pool of isolated users that
 * specs needing their own tenant log in as (via the real login route).
 */
export const STORAGE_STATE = "e2e/.auth/state.json";
export const USERS_FILE = "e2e/.auth/users.json";
export const POOL = ["collab", "ops", "other", "factory", "v3", "autopilot", "learning"] as const;
export const PASSWORD = "e2e-password-123";

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL ?? "http://localhost:3000";
  mkdirSync("e2e/.auth", { recursive: true });
  const stamp = Date.now();
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post("/api/auth/register", { data: { email: `e2e_${stamp}@aura.local`, name: "E2E", password: PASSWORD } });
  if (!res.ok()) throw new Error(`E2E registration failed: ${res.status()} ${await res.text()}`);
  await ctx.storageState({ path: STORAGE_STATE });
  await ctx.dispose();

  const users: Record<string, string> = {};
  for (const name of POOL) {
    const c = await request.newContext({ baseURL });
    const email = `e2e_${name}_${stamp}@aura.local`;
    const r = await c.post("/api/auth/register", { data: { email, name, password: PASSWORD } });
    if (!r.ok()) throw new Error(`E2E pool registration failed for ${name}: ${r.status()} ${await r.text()}`);
    users[name] = email;
    await c.dispose();
  }
  writeFileSync(USERS_FILE, JSON.stringify(users));
}
