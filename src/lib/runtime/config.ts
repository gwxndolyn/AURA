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
  return { errors, warnings, ok: errors.length === 0 };
}
