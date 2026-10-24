import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { USERS_FILE, PASSWORD, type POOL } from "./global-setup";

/**
 * Sign a request context in as one of the pre-registered isolated users.
 * Each pool user gets a fresh workspace per test (companies are created per
 * test), so tenant isolation between specs still holds.
 */
export async function loginAs(api: APIRequestContext, name: (typeof POOL)[number]) {
  const users = JSON.parse(readFileSync(USERS_FILE, "utf8")) as Record<string, string>;
  const r = await api.post("/api/auth/login", { data: { email: users[name], password: PASSWORD } });
  if (!r.ok()) throw new Error(`login as ${name} failed: ${r.status()} ${await r.text()}`);
}
