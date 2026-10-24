/**
 * Operational-readiness checks (AURA V13) from actual evidence: the latest
 * system graph and source snapshot (static), deployment records + health
 * results (runtime), and what is genuinely not connected. Each check is
 * passed | failed | warning | not_run — never "passed" by inspection of
 * something AURA did not observe (e.g. monitoring, backups).
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import type { SystemGraph } from "@/lib/builder/graph";

export type OpStatus = "passed" | "failed" | "warning" | "not_run";
export interface OpCheck { id: string; label: string; status: OpStatus; detail: string; evidence: "static" | "runtime" | "none" }

export function operationalChecks(files: Record<string, string>, graph: SystemGraph | null, deploy: { health: { path: string; ok: boolean }[]; restartVerified?: boolean } | null, secrets: { required: string[]; provided: string[] | null }): OpCheck[] {
  const src = Object.entries(files).filter(([p]) => /\.(c|m)?(j|t)sx?$/.test(p) && !/\.test\./.test(p));
  const any = (re: RegExp) => src.filter(([, s]) => re.test(s)).map(([p]) => p);
  const routes = graph?.nodes.filter((n) => n.kind === "route").map((n) => n.label) ?? [];
  const external = graph?.nodes.filter((n) => n.kind === "external") ?? [];
  const out: OpCheck[] = [];
  const health = routes.find((r) => /health/.test(r));
  out.push({ id: "health", label: "Health endpoint", status: health ? (deploy ? (deploy.health.some((h) => /health/.test(h.path) && h.ok) ? "passed" : "failed") : "warning") : "failed", detail: health ? (deploy ? `${health} answered on the deployment` : `${health} exists (not yet observed on a deployment)`) : "no health route found", evidence: deploy ? "runtime" : "static" });
  out.push({ id: "readiness", label: "Readiness check (dependencies)", status: routes.some((r) => /ready/.test(r)) ? "passed" : "warning", detail: routes.some((r) => /ready/.test(r)) ? "readiness route present" : "no readiness route: load balancers cannot tell 'up' from 'ready'", evidence: "static" });
  const fetchers = any(/\bfetch\(\s*["'`]https?:/);
  const withTimeout = any(/AbortSignal\.timeout|signal:\s*\w+|timeout:\s*\d/);
  out.push({ id: "timeouts", label: "Timeouts on outbound calls", status: !external.length && !fetchers.length ? "passed" : fetchers.every((f) => withTimeout.includes(f)) ? "passed" : "failed", detail: !fetchers.length ? "no outbound HTTP calls" : `${fetchers.filter((f) => !withTimeout.includes(f)).join(", ") || "all"} ${fetchers.every((f) => withTimeout.includes(f)) ? "set a timeout" : "call external services without a timeout"}`, evidence: "static" });
  const leaky = any(/json\(\s*res\s*,\s*500\s*,\s*\{[^}]*\b(stack|e\.message|err\.message)\b/);
  out.push({ id: "errors", label: "Safe error responses", status: leaky.length ? "failed" : "passed", detail: leaky.length ? `internal details returned in ${leaky.join(", ")}` : "500 responses do not echo internals", evidence: "static" });
  const structured = any(/console\.(log|error|warn)\(\s*JSON\.stringify|\bpino\b|\bwinston\b|\blogger\.(info|warn|error)\(/);
  out.push({ id: "logging", label: "Structured logging", status: structured.length ? "passed" : "warning", detail: structured.length ? `structured log calls in ${structured.slice(0, 3).join(", ")}` : "no structured log calls found (logs, if any, are plain text — hard to search/alert on)", evidence: "static" });
  out.push({ id: "shutdown", label: "Graceful shutdown", status: any(/process\.on\(\s*["']SIGTERM["']/).length ? "passed" : "warning", detail: any(/SIGTERM/).length ? "SIGTERM handler present" : "no SIGTERM handler: in-flight requests are cut on deploys", evidence: "static" });
  const missing = secrets.provided ? secrets.required.filter((n) => !secrets.provided!.includes(n)) : [];
  out.push({ id: "config", label: "Required configuration provided", status: secrets.provided === null ? "not_run" : missing.length ? "failed" : "passed", detail: secrets.provided === null ? "no deployment target configured — cannot compare required env vars" : missing.length ? `missing: ${missing.join(", ")}` : `${secrets.required.length} required variable(s) provided`, evidence: secrets.provided === null ? "none" : "static" });
  out.push({ id: "restart", label: "Recovery after process restart", status: deploy?.restartVerified ? "passed" : "not_run", detail: deploy?.restartVerified ? "data persisted across a container restart" : "not exercised on a deployment", evidence: deploy?.restartVerified ? "runtime" : "none" });
  out.push({ id: "monitoring", label: "Monitoring / error reporting", status: "not_run", detail: "no telemetry integration is connected; AURA does not invent production signals", evidence: "none" });
  out.push({ id: "backups", label: "Backups and restore", status: "not_run", detail: "backup configuration is outside what AURA can observe", evidence: "none" });
  return out;
}

export async function operationalReadiness(companyId: string, productId: string, files: Record<string, string>) {
  const snap = await prisma.systemGraphSnapshot.findFirst({ where: { companyId, productId, NOT: { sha: { startsWith: "wip:" } } }, orderBy: { createdAt: "desc" } });
  const graph = snap ? parseJSON<SystemGraph>(snap.data, null as never) : null;
  const dep = await prisma.productDeployment.findFirst({ where: { companyId, productId, status: "VERIFIED" }, orderBy: { finishedAt: "desc" } });
  const targets = await prisma.deployTarget.findMany({ where: { companyId, productId }, select: { config: true, secretEnvNames: true } });
  const provided = targets.length ? [...new Set(targets.flatMap((t) => [...Object.keys(parseJSON<{ env?: Record<string, string> }>(t.config, {}).env ?? {}), ...parseJSON<string[]>(t.secretEnvNames, [])]))] : null;
  const required = [...new Set((graph?.edges ?? []).filter((e) => e.kind === "reads_env" && e.source.includes("required")).map((e) => e.to.replace(/^env:/, "")))].filter((n) => !["NODE_ENV", "PORT", "DATA_DIR"].includes(n));
  const checks = operationalChecks(files, graph, dep ? { health: parseJSON(dep.health, []) } : null, { required, provided });
  return { checks, summary: Object.fromEntries((["passed", "failed", "warning", "not_run"] as const).map((k) => [k, checks.filter((c) => c.status === k).length])), graphSha: snap?.sha ?? null };
}
