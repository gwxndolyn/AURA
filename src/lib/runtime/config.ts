/**
 * Runtime configuration validation (worker / web startup). Never prints
 * secret values — only whether they are present.
 */
export function validateRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!env.DATABASE_URL) errors.push("DATABASE_URL is not set");
  if (env.NODE_ENV === "production" && (env.AUTH_SECRET ?? "").length < 16) errors.push("AUTH_SECRET must be at least 16 characters in production");
  if (!env.ANTHROPIC_API_KEY) warnings.push("ANTHROPIC_API_KEY is not set: agent/model jobs fail with provider_not_configured (nothing is simulated)");
  if (env.DATABASE_URL?.startsWith("file:") && env.NODE_ENV === "production") warnings.push("SQLite in production: run exactly one worker process, or use PostgreSQL for several");
  const nums = ["AURA_WORKER_CONCURRENCY", "AURA_JOB_LEASE_MS", "AURA_SCHEDULER_TICK_MS", "AURA_SHUTDOWN_GRACE_MS", "AURA_WORKER_STALE_MS"];
  for (const k of nums) if (env[k] !== undefined && !(Number(env[k]) > 0)) errors.push(`${k} must be a positive number`);
  if (env.AURA_WORKER && !["inline", "external", "off"].includes(env.AURA_WORKER)) errors.push("AURA_WORKER must be inline | external | off");
  if (!env.AURA_GIT_ROOT && env.NODE_ENV === "production") warnings.push("AURA_GIT_ROOT not set: product repositories go to the OS temp dir (not durable)");
  if (env.NODE_ENV === "production") {
    if (env.AURA_SIMULATION_LAB === "1") warnings.push("AURA_SIMULATION_LAB=1 in production: the simulation lab (fictional data, simulator output) is exposed to customers");
    if (env.STRIPE_API_BASE || env.GITHUB_API_BASE || env.ANTHROPIC_BASE_URL?.includes("127.0.0.1") || env.RESEND_API_BASE) errors.push("A provider *_API_BASE test-double override is set in production (STRIPE_API_BASE / GITHUB_API_BASE / RESEND_API_BASE / local ANTHROPIC_BASE_URL)");
    if (!env.NEXT_PUBLIC_APP_URL?.startsWith("https://")) warnings.push("NEXT_PUBLIC_APP_URL should be the https:// public URL (used for email links, checkout return URLs and the CSRF origin allowlist)");
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) errors.push("STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET: subscriptions could never be confirmed");
    if (env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) warnings.push("Stripe is in TEST mode: no real payments are taken");
  }
  const sk = env.AURA_SECRETS_KEY;
  if (sk) {
    const len = /^[0-9a-f]{64}$/i.test(sk) ? 32 : Buffer.from(sk, "base64").length;
    if (len !== 32) errors.push("AURA_SECRETS_KEY must be 32 bytes (base64 or 64 hex chars)");
  } else warnings.push("AURA_SECRETS_KEY not set: customers cannot store deployment secrets");
  return { errors, warnings, ok: errors.length === 0 };
}
