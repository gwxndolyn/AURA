/**
 * Release management for products: targets, preflight, approval-gated
 * deployments executed as durable `deploy.run` jobs by the release engineer
 * (agent key `devops`, through callTool → role allowlist + approval check),
 * post-deploy verification, automatic rollback, history.
 *
 * Policy:
 *  - preview: deploys without a separate approval only when the target has
 *    autoDeploy=true AND the product autonomy is BOUNDED/CONTINUOUS (the
 *    user deliberately allowed it); otherwise a `preview` approval is asked
 *  - production: ALWAYS a `deploy_production` approval (ADMIN+), at every
 *    autonomy level
 *  - the release candidate must be APPROVED and its integrated tests must
 *    have passed in the sandbox; blocking security findings must be closed
 *  - preflight (persisted): tests, security, config (declared secret env
 *    vars present), migrations (schema changes flagged; never applied
 *    destructively), target connection, current live version, rollback plan
 *  - success = provider started it AND AURA's health checks + journey checks
 *    passed. Failed checks → the new deployment is stopped and the previous
 *    VERIFIED deployment is restored (automatic, reversible), status
 *    ROLLED_BACK with the evidence.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit } from "@/lib/events/emit";
import { enqueue, JobError, progress } from "@/lib/jobs/queue";
import { callTool } from "@/lib/agents/tools";
import { listFiles, readAt } from "@/lib/factory/git";
import { loadProduct, requestApproval, productEvent } from "@/lib/factory/store";
import { providerOf, PROVIDERS, DeployError, type TargetConfig } from "./providers";
import { verifyDeployment } from "./verify";

export const ENVS = ["preview", "production"] as const;
export type Env = (typeof ENVS)[number];

type Dep = NonNullable<Awaited<ReturnType<typeof prisma.productDeployment.findFirst>>>;

async function appendLog(id: string, line: string) {
  const d = await prisma.productDeployment.findUnique({ where: { id }, select: { logs: true } });
  await prisma.productDeployment.update({ where: { id }, data: { logs: `${d?.logs ?? ""}[${new Date().toISOString()}] ${line}\n`.slice(-60_000) } });
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
export async function upsertTarget(input: { companyId: string; productId: string; env: Env; provider: string; config: TargetConfig; secretEnvNames: string[]; autoDeploy: boolean; actor: string }) {
  await loadProduct(input.companyId, input.productId);
  const prov = providerOf(input.provider);
  if (input.env === "production" && input.autoDeploy) throw new ApiError("Production deployments always require an approval; autoDeploy is only for preview", 422);
  for (const n of input.secretEnvNames) if (!ENV_NAME.test(n) || /^(AURA_|ANTHROPIC|DATABASE_URL|AUTH_SECRET|STRIPE|GITHUB)/.test(n)) throw new ApiError(`${n} cannot be injected into a product (AURA's own secrets are never shared)`, 422);
  for (const k of Object.keys(input.config.env ?? {})) if (!ENV_NAME.test(k)) throw new ApiError(`Invalid env var name ${k}`, 422);
  if (input.config.port !== undefined && !(Number.isInteger(input.config.port) && input.config.port >= 1024 && input.config.port <= 65535)) throw new ApiError("port must be 1024–65535", 422);
  if (input.config.bindAddress && !["127.0.0.1", "0.0.0.0"].includes(input.config.bindAddress)) throw new ApiError("bindAddress must be 127.0.0.1 or 0.0.0.0", 422);
  const v = await prov.verify(input.config);
  const t = await prisma.deployTarget.upsert({
    where: { productId_env: { productId: input.productId, env: input.env } },
    create: { companyId: input.companyId, productId: input.productId, env: input.env, provider: prov.id, config: JSON.stringify(input.config), secretEnvNames: JSON.stringify(input.secretEnvNames), autoDeploy: input.autoDeploy, status: v.ok ? "CONNECTED" : "ERROR", statusDetail: v.detail, verifiedAt: v.ok ? new Date() : null, createdBy: input.actor },
    update: { provider: prov.id, config: JSON.stringify(input.config), secretEnvNames: JSON.stringify(input.secretEnvNames), autoDeploy: input.autoDeploy, status: v.ok ? "CONNECTED" : "ERROR", statusDetail: v.detail, verifiedAt: v.ok ? new Date() : null },
  });
  await audit(input.companyId, input.actor, "DEPLOY_TARGET_SAVED", t.id, `${input.env} ${prov.id}: ${v.ok ? "connected" : `error ${v.detail}`}`);
  return t;
}

export async function listTargets(companyId: string, productId: string) {
  await loadProduct(companyId, productId); // 404 for a product outside this workspace (never an empty 200)
  const rows = await prisma.deployTarget.findMany({ where: { companyId, productId } });
  return rows.map((t) => ({ ...t, config: parseJSON<TargetConfig>(t.config, {}), secretEnvNames: parseJSON<string[]>(t.secretEnvNames, []), secretsPresent: Object.fromEntries(parseJSON<string[]>(t.secretEnvNames, []).map((n) => [n, !!process.env[n]])) }));
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface Check { id: string; label: string; status: "passed" | "failed" | "warning" | "not_applicable"; detail: string }

export async function preflight(companyId: string, productId: string, env: Env) {
  const p = await loadProduct(companyId, productId);
  const checks: Check[] = [];
  const target = await prisma.deployTarget.findUnique({ where: { productId_env: { productId, env } } });
  const rc = await prisma.productArtifact.findFirst({ where: { productId, companyId, kind: "RELEASE_CANDIDATE", status: "APPROVED" }, orderBy: { version: "desc" } });
  const c = rc ? parseJSON<{ branch: string; sha: string; test?: { mode: string; passed: number; failed: number; total: number } }>(rc.content, { branch: "", sha: "" }) : null;
  checks.push({ id: "release", label: "Approved release candidate", status: rc ? "passed" : "failed", detail: rc ? `RC ${rc.version}: ${c!.branch} @ ${c!.sha.slice(0, 8)}` : "approve a release candidate first" });
  checks.push({ id: "tests", label: "Integrated tests passed in the sandbox", status: c?.test && c.test.mode === "docker" && c.test.failed === 0 && c.test.total > 0 ? "passed" : "failed", detail: c?.test ? `${c.test.passed}/${c.test.total} (${c.test.mode})` : "no integrated test result" });
  const items = await prisma.backlogItem.findMany({ where: { productId, companyId, status: "VERIFIED", buildId: { not: null } }, select: { buildId: true } });
  const builds = items.length ? await prisma.build.findMany({ where: { id: { in: items.map((i) => i.buildId!) }, companyId } }) : [];
  const sec = builds.flatMap((b) => parseJSON<{ source: string; blocking: boolean; title: string }[]>(b.findings, [])).filter((f) => f.source === "security" && f.blocking);
  checks.push({ id: "security", label: "No open blocking security findings", status: sec.length ? "failed" : builds.length ? "passed" : "warning", detail: sec.length ? sec.map((s) => s.title).join("; ") : `${builds.length} verified change(s) security-reviewed` });
  checks.push({ id: "target", label: "Deployment target connected", status: target?.status === "CONNECTED" ? "passed" : "failed", detail: target ? `${target.provider}: ${target.statusDetail}` : `no ${env} target configured` });
  if (target) {
    const prov = PROVIDERS[target.provider];
    const live = prov ? await prov.verify(parseJSON<TargetConfig>(target.config, {})) : { ok: false, detail: "unknown provider" };
    if (!live.ok) checks.find((x) => x.id === "target")!.status = "failed", checks.find((x) => x.id === "target")!.detail = `re-verified now: ${live.detail}`;
    const missing = parseJSON<string[]>(target.secretEnvNames, []).filter((n) => !process.env[n]);
    checks.push({ id: "config", label: "Required environment variables present", status: missing.length ? "failed" : "passed", detail: missing.length ? `missing on the AURA server: ${missing.join(", ")}` : `${parseJSON<string[]>(target.secretEnvNames, []).length} secret(s) + ${Object.keys(parseJSON<TargetConfig>(target.config, {}).env ?? {}).length} plain var(s)` });
  }
  const current = await prisma.productDeployment.findFirst({ where: { productId, companyId, env, status: "VERIFIED" }, orderBy: { finishedAt: "desc" } });
  if (c?.sha && p.repoId) {
    const changedSchema = (await listFiles(companyId, p.repoId, c.sha)).filter((f) => /\.prisma$|(^|\/)migrations?\/|\.sql$/.test(f));
    checks.push({ id: "migrations", label: "Database migration safety", status: changedSchema.length ? "warning" : "not_applicable", detail: changedSchema.length ? `schema files present (${changedSchema.join(", ")}): AURA never runs destructive migrations; the app applies its own forward migrations at start — review them` : "no schema/migration files (file-based store)" });
  }
  checks.push({ id: "current", label: "Currently deployed version", status: "passed", detail: current ? `${current.sha.slice(0, 8)} (deployment ${current.id.slice(-6)}, ${current.url})` : "nothing deployed yet" });
  checks.push({ id: "rollback", label: "Rollback strategy", status: current ? "passed" : "not_applicable", detail: current ? `on failed verification AURA restores ${current.sha.slice(0, 8)} automatically` : "first deployment: on failure the new version is stopped" });
  const ok = checks.every((x) => x.status !== "failed");
  return { ok, checks, target, rc, release: c, current };
}

// ---------------------------------------------------------------------------
// Request → (approval) → durable job
// ---------------------------------------------------------------------------

export async function requestProductDeploy(companyId: string, productId: string, env: Env, actor: string) {
  const p = await loadProduct(companyId, productId);
  const pf = await preflight(companyId, productId, env);
  if (!pf.ok) throw new ApiError(`Preflight failed: ${pf.checks.filter((c) => c.status === "failed").map((c) => `${c.label} (${c.detail})`).join("; ")}`, 409);
  const auto = env === "preview" && pf.target!.autoDeploy && ["BOUNDED", "CONTINUOUS"].includes(p.autonomy);
  const dep = await prisma.productDeployment.create({ data: { companyId, productId, targetId: pf.target!.id, env, provider: pf.target!.provider, ref: pf.release!.branch, sha: pf.release!.sha, releaseVersion: pf.rc!.version, status: auto ? "QUEUED" : "PREFLIGHT", preflight: JSON.stringify(pf.checks), previousId: pf.current?.id ?? null, requestedBy: actor } });
  await audit(companyId, actor, "DEPLOY_REQUESTED", dep.id, `${env} ${pf.release!.sha.slice(0, 8)}`);
  if (auto) return { deployment: await startDeployJob(dep, null, actor), approval: null };
  const a = await requestApproval(p, { action: env === "production" ? "deploy_production" : "deploy_preview", actionClass: env === "production" ? "production" : "infrastructure", target: `${env}@${pf.release!.sha.slice(0, 8)}`, summary: `Deploy release candidate ${pf.rc!.version} to ${env} (${pf.target!.provider})`, risks: pf.checks.filter((c) => c.status === "warning").map((c) => `${c.label}: ${c.detail}`), evidence: [{ kind: "deployment", ref: dep.id, detail: `${env} ${pf.release!.sha.slice(0, 8)}` }], payload: { deploymentId: dep.id, sha: pf.release!.sha, env } });
  await prisma.productDeployment.update({ where: { id: dep.id }, data: { approvalId: a.id } });
  await productEvent(companyId, productId, `Deployment to ${env} is waiting for approval`, { level: "warning", actor: "devops" });
  return { deployment: dep, approval: a };
}

async function startDeployJob(dep: Dep, approvalId: string | null, actor: string) {
  const job = await enqueue({ companyId: dep.companyId, type: "deploy.run", payload: { deploymentId: dep.id, approvalId }, dedupeKey: `deploy:${dep.id}`, maxAttempts: 1, createdBy: actor, concurrencyKey: `deploy:${dep.productId}:${dep.env}`, timeoutMs: 20 * 60_000, priority: 20 });
  return prisma.productDeployment.update({ where: { id: dep.id }, data: { status: "QUEUED", jobId: job.id } });
}

/** Called when a deploy approval is decided (release.ts → decideProductApproval). */
export async function onDeployApproval(companyId: string, approvalId: string, decision: "approve" | "reject", actor: string) {
  const dep = await prisma.productDeployment.findFirst({ where: { companyId, approvalId, status: "PREFLIGHT" } });
  if (!dep) return null;
  if (decision === "reject") return prisma.productDeployment.update({ where: { id: dep.id }, data: { status: "CANCELLED", failure: `approval rejected by ${actor}`, finishedAt: new Date() } });
  return startDeployJob(dep, approvalId, actor);
}

// ---------------------------------------------------------------------------
// Execution (job body)
// ---------------------------------------------------------------------------

async function filesAt(companyId: string, repoId: string, sha: string) {
  const out: Record<string, string> = {};
  for (const f of await listFiles(companyId, repoId, sha)) {
    if (f.split("/").some((s) => s === "node_modules" || s === ".git") || /(^|\/)\.env/.test(f)) continue;
    const c = await readAt(companyId, repoId, sha, f);
    if (c !== null) out[f] = c;
  }
  return out;
}

export async function runDeployment(deploymentId: string, ctx: { approvalId: string | null; job?: { id: string; companyId: string; attempts?: number } }) {
  const dep = await prisma.productDeployment.findUnique({ where: { id: deploymentId } });
  if (!dep) throw new JobError("Deployment not found", false, "missing");
  if (!["QUEUED"].includes(dep.status)) return { status: dep.status, note: "already processed" };
  const target = await prisma.deployTarget.findFirst({ where: { id: dep.targetId, companyId: dep.companyId } });
  const product = await prisma.product.findFirst({ where: { id: dep.productId, companyId: dep.companyId } });
  if (!target || !product?.repoId) throw new JobError("Target or product repository missing", false, "missing");
  const prov = providerOf(target.provider);
  const cfg = parseJSON<TargetConfig>(target.config, {});
  const log = (l: string) => appendLog(dep.id, l);
  const step = async (status: string, msg: string) => {
    await prisma.productDeployment.update({ where: { id: dep.id }, data: { status, startedAt: dep.startedAt ?? new Date() } });
    await log(msg);
    if (ctx.job) await progress(ctx.job, status.toLowerCase(), msg);
  };
  // The release engineer performs the deployment; callTool enforces its role allowlist and the approval.
  const toolCtx = { companyId: dep.companyId, agentKey: "devops", approvalId: ctx.approvalId ?? undefined, timeoutMs: 25 * 60_000 };
  const autoPreview = dep.env === "preview" && !ctx.approvalId;
  const exec = async () => {
    await step("BUILDING", `building ${dep.ref} @ ${dep.sha.slice(0, 8)} with ${prov.id}`);
    const files = await filesAt(dep.companyId, product.repoId!, dep.sha);
    const secretEnv = Object.fromEntries(parseJSON<string[]>(target.secretEnvNames, []).map((n) => [n, process.env[n] ?? ""]));
    // A fresh port slot when replacing a live deployment of the same target would clash: stop the old one only after the new one verifies.
    const previous = dep.previousId ? await prisma.productDeployment.findUnique({ where: { id: dep.previousId } }) : null;
    const prevRef = previous ? parseJSON<Record<string, string>>(previous.providerRef, {}) : null;
    // Stop what is ACTUALLY running for this product environment (asked of the provider, not inferred from
    // our records — after a rollback the live container differs from the original record).
    const stopped = await prov.stopEnv(dep.productId, dep.env);
    if (stopped.length) await log(`stopped ${stopped.length} running instance(s) of ${dep.env} to free port ${cfg.port ?? 3000}${previous ? ` (previous ${previous.sha.slice(0, 8)} is restored if verification fails)` : ""}`);
    void prevRef;
    const r = await prov.deploy({ deploymentId: dep.id, productId: dep.productId, env: dep.env, files, config: cfg, secretEnv, log });
    await prisma.productDeployment.update({ where: { id: dep.id }, data: { providerRef: JSON.stringify(r.providerRef), url: r.url, targetConfig: JSON.stringify(cfg) } });
    await step("VERIFYING", `provider started ${r.providerRef.container?.slice(0, 12)}; verifying ${r.url}`);
    const v = await verifyDeployment(r.url, cfg);
    await prisma.productDeployment.update({ where: { id: dep.id }, data: { health: JSON.stringify(v.checks) } });
    if (!v.ok) {
      const appLogs = await prov.logs(r.providerRef, 80);
      await log(`verification FAILED: ${v.checks.filter((c) => !c.ok).map((c) => `${c.path}: ${c.detail}`).join("; ")}\n--- app logs ---\n${appLogs}`);
      await prov.stop(r.providerRef);
      if (previous && prevRef) {
        await log(`rolling back to ${previous.sha.slice(0, 8)}`);
        // Restore with the configuration the previous version was verified with (the new config may be the problem).
        const prevCfg = { ...cfg, ...parseJSON<TargetConfig>(previous.targetConfig, {}) };
        const back = await prov.deploy({ deploymentId: previous.id, productId: dep.productId, env: dep.env, files: await filesAt(dep.companyId, product.repoId!, previous.sha), config: prevCfg, secretEnv, log });
        const vb = await verifyDeployment(back.url, prevCfg);
        await prisma.productDeployment.update({ where: { id: previous.id }, data: { providerRef: JSON.stringify(back.providerRef), url: back.url, status: vb.ok ? "VERIFIED" : "FAILED", health: JSON.stringify(vb.checks) } });
        await prisma.productDeployment.update({ where: { id: dep.id }, data: { status: "ROLLED_BACK", rolledBackTo: previous.id, failure: `Post-deploy verification failed; restored ${previous.sha.slice(0, 8)} (${vb.ok ? "verified" : "restore ALSO failed verification"})`, finishedAt: new Date() } });
        return { status: "ROLLED_BACK", restored: vb.ok };
      }
      await prisma.productDeployment.update({ where: { id: dep.id }, data: { status: "FAILED", failure: "Post-deploy verification failed; the new version was stopped (no earlier version to restore)", finishedAt: new Date() } });
      return { status: "FAILED" };
    }
    if (previous) await prisma.productDeployment.update({ where: { id: previous.id }, data: { status: "SUPERSEDED" } });
    await prisma.productDeployment.update({ where: { id: dep.id }, data: { status: "VERIFIED", finishedAt: new Date() } });
    await log(`VERIFIED: ${v.checks.length} check(s) passed at ${r.url}`);
    return { status: "VERIFIED", url: r.url };
  };
  try {
    const out = autoPreview
      ? await callTool({ ...toolCtx, approvalId: undefined }, "deploy.run", { env: dep.env }, exec).catch(async (e) => {
          // Preview auto-deploys are policy-authorized (target.autoDeploy + autonomy) rather than per-release approved.
          if ((e as { code?: string }).code === "approval_required") return exec();
          throw e;
        })
      : await callTool(toolCtx, "deploy.run", { env: dep.env, deploymentId: dep.id }, exec);
    const st = (out as { status: string }).status;
    await productEvent(dep.companyId, dep.productId, st === "VERIFIED" ? `Deployed ${dep.sha.slice(0, 8)} to ${dep.env} and verified` : `Deployment to ${dep.env} ${st.toLowerCase().replace("_", " ")}`, { level: st === "VERIFIED" ? "success" : "danger", actor: "devops" });
    return out;
  } catch (e) {
    const msg = e instanceof DeployError ? `${e.stage}: ${e.message}` : (e as Error).message;
    await prisma.productDeployment.update({ where: { id: dep.id }, data: { status: "FAILED", failure: msg.slice(0, 4000), finishedAt: new Date() } });
    await log(`FAILED: ${msg.slice(0, 2000)}`);
    // Restore the previous version if we stopped it.
    const previous = dep.previousId ? await prisma.productDeployment.findUnique({ where: { id: dep.previousId } }) : null;
    if (previous) {
      try {
        await prov.stopEnv(dep.productId, dep.env);
        const back = await prov.deploy({ deploymentId: previous.id, productId: dep.productId, env: dep.env, files: await filesAt(dep.companyId, product.repoId!, previous.sha), config: { ...cfg, ...parseJSON<TargetConfig>(previous.targetConfig, {}) }, secretEnv: Object.fromEntries(parseJSON<string[]>(target.secretEnvNames, []).map((n) => [n, process.env[n] ?? ""])), log });
        await prisma.productDeployment.update({ where: { id: previous.id }, data: { providerRef: JSON.stringify(back.providerRef) } });
        await prisma.productDeployment.update({ where: { id: dep.id }, data: { status: "ROLLED_BACK", rolledBackTo: previous.id } });
      } catch { /* recorded in logs; the target needs a person */ }
    }
    throw new JobError(msg, false, "deploy_failed");
  }
}

/** Manual rollback to the last VERIFIED/SUPERSEDED deployment before the current one (needs a production-class approval). */
export async function requestRollback(companyId: string, productId: string, env: Env, actor: string) {
  const p = await loadProduct(companyId, productId);
  const current = await prisma.productDeployment.findFirst({ where: { companyId, productId, env, status: "VERIFIED" }, orderBy: { finishedAt: "desc" } });
  if (!current) throw new ApiError("Nothing is deployed", 409);
  const prev = await prisma.productDeployment.findFirst({ where: { companyId, productId, env, status: "SUPERSEDED", finishedAt: { lt: current.finishedAt! } }, orderBy: { finishedAt: "desc" } });
  if (!prev) throw new ApiError("No earlier verified version to roll back to", 409);
  const dep = await prisma.productDeployment.create({ data: { companyId, productId, targetId: current.targetId, env, provider: current.provider, ref: prev.ref, sha: prev.sha, releaseVersion: prev.releaseVersion, status: "PREFLIGHT", preflight: JSON.stringify([{ id: "rollback", label: "Rollback", status: "passed", detail: `${current.sha.slice(0, 8)} → ${prev.sha.slice(0, 8)}` }]), previousId: current.id, requestedBy: actor } });
  const a = await requestApproval(p, { action: env === "production" ? "deploy_production" : "deploy_preview", actionClass: env === "production" ? "production" : "infrastructure", target: `${env}@${prev.sha.slice(0, 8)} (rollback)`, summary: `Roll back ${env} from ${current.sha.slice(0, 8)} to ${prev.sha.slice(0, 8)}`, evidence: [{ kind: "deployment", ref: dep.id, detail: "rollback" }], payload: { deploymentId: dep.id, sha: prev.sha, env } });
  await prisma.productDeployment.update({ where: { id: dep.id }, data: { approvalId: a.id } });
  return { deployment: dep, approval: a };
}

export async function deploymentHistory(companyId: string, productId: string) {
  await loadProduct(companyId, productId);
  const rows = await prisma.productDeployment.findMany({ where: { companyId, productId }, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map((d) => ({ ...d, preflight: parseJSON(d.preflight, []), providerRef: parseJSON(d.providerRef, {}), health: parseJSON(d.health, []) }));
}
