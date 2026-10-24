import { prisma } from "@/lib/db";
import { runAgent } from "@/lib/agents/orchestrator";
import { emitEvent, audit } from "@/lib/events/emit";
import { seededRandom, hashString } from "@/lib/utils";

const STAGES = ["BUILD", "TEST", "SECURITY_SCAN", "DEPLOY", "HEALTH_CHECK"] as const;

/**
 * Simulated deployment pipeline. Runs through build -> test -> security scan ->
 * deploy -> health check. Each stage has a simulated duration and may fail
 * (deterministically influenced by tech debt / security score).
 */
export async function runDeployment(
  companyId: string,
  env = "production",
  opts?: { forceFailStage?: string; version?: string; commit?: string; rolledBackFrom?: string },
) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error("Company not found");

  const count = await prisma.deployment.count({ where: { companyId } });
  const version = opts?.version ?? `v0.${count + 1}.0`;
  const commit = opts?.commit ?? Math.random().toString(16).slice(2, 9);

  const deployment = await prisma.deployment.create({
    data: { companyId, env, version, commit, status: "RUNNING", stage: "BUILD", rolledBackFrom: opts?.rolledBackFrom },
  });

  await emitEvent({
    companyId,
    type: "DEPLOYMENT_STARTED",
    actor: "devops",
    message: `Deploying ${version} to ${env}`,
    meta: { deploymentId: deployment.id },
  });

  await runAgent({
    companyId,
    agentKey: "devops",
    objective: `Deploy ${version} to ${env}`,
    kind: "summary",
  });

  const rnd = seededRandom(hashString(deployment.id));
  const stageResults: { name: string; status: string; durationMs: number }[] = [];
  let failedStage: string | null = null;

  for (const stage of STAGES) {
    const durationMs = 400 + Math.floor(rnd() * 1200);
    // Failure probability influenced by state.
    let failChance = 0.04;
    if (stage === "TEST") failChance += company.technicalDebt / 500;
    if (stage === "SECURITY_SCAN") failChance += (100 - company.securityScore) / 400;
    const failed = opts?.forceFailStage ? stage === opts.forceFailStage : rnd() < failChance;

    await prisma.deployment.update({ where: { id: deployment.id }, data: { stage } });

    if (failed) {
      failedStage = stage;
      stageResults.push({ name: stage, status: "FAILED", durationMs });
      break;
    }
    stageResults.push({ name: stage, status: "SUCCESS", durationMs });
  }

  const totalMs = stageResults.reduce((s, x) => s + x.durationMs, 0);
  const success = !failedStage;

  await prisma.deployment.update({
    where: { id: deployment.id },
    data: {
      status: success ? "SUCCESS" : "FAILED",
      stages: JSON.stringify(stageResults),
      durationMs: totalMs,
    },
  });

  await emitEvent({
    companyId,
    type: "DEPLOYMENT_COMPLETED",
    actor: "devops",
    level: success ? "success" : "danger",
    message: success
      ? `Deployed ${version} to ${env} (${(totalMs / 1000).toFixed(1)}s)`
      : `Deployment ${version} failed at ${failedStage}`,
    meta: { deploymentId: deployment.id, success, failedStage },
  });

  if (success) {
    await prisma.timelineEvent.create({
      data: { companyId, title: `Deployed ${version}`, kind: "deployment", simDay: company.simDay },
    });
    if (company.status === "BUILDING") {
      await prisma.company.update({ where: { id: companyId }, data: { status: "OPERATING" } });
    }
  }

  await audit(companyId, "devops", "DEPLOY", deployment.id, success ? "SUCCESS" : `FAILED@${failedStage}`);
  return { deploymentId: deployment.id, success, failedStage, stages: stageResults, version };
}

/**
 * Deploy with real self-healing retry. If the first attempt fails, DevOps
 * collects logs, identifies the root cause (the failed stage), applies a
 * config fix, and retries — actually re-running the pipeline (not a hardcoded
 * "retry succeeded"). The retry omits the forced failure, so it can succeed.
 */
export async function deployWithRetry(
  companyId: string,
  env = "production",
  opts?: { forceFailStage?: string; maxRetries?: number },
) {
  const maxRetries = opts?.maxRetries ?? 2;
  let attempt = 0;
  let last = await runDeployment(companyId, env, { forceFailStage: opts?.forceFailStage });

  while (!last.success && attempt < maxRetries) {
    attempt++;
    await emitEvent({
      companyId,
      type: "DEPLOYMENT_STARTED",
      actor: "devops",
      level: "warning",
      message: `Deploy failed at ${last.failedStage}. Collecting logs, identifying root cause…`,
    });
    await runAgent({
      companyId,
      agentKey: "devops",
      objective: `Diagnose deploy failure at ${last.failedStage} and fix configuration`,
      kind: "summary",
    });
    await emitEvent({
      companyId,
      type: "DEPLOYMENT_STARTED",
      actor: "devops",
      message: `Root cause: ${last.failedStage} configuration. Applied fix, retrying (attempt ${attempt + 1})…`,
    });
    await audit(companyId, "devops", "DEPLOY_FIX", `${last.failedStage}`, "config fix applied");
    // Retry WITHOUT the forced failure → genuine re-run of the pipeline.
    last = await runDeployment(companyId, env);
  }

  return { ...last, retries: attempt };
}

/**
 * Roll an environment back to its last successful version by re-running the
 * (simulated) pipeline for that version. The failed deployment is marked
 * ROLLED_BACK only if the rollback deployment actually succeeds. Callers
 * enforce approval rules.
 */
export async function rollbackDeployment(companyId: string, deploymentId: string, actor: string) {
  const failed = await prisma.deployment.findFirst({ where: { id: deploymentId, companyId } });
  if (!failed) throw new Error("Deployment not found");
  if (failed.status !== "FAILED") throw new Error(`Only a failed deployment can be rolled back (it is ${failed.status.toLowerCase()})`);
  const target = await prisma.deployment.findFirst({ where: { companyId, env: failed.env, status: "SUCCESS", createdAt: { lt: failed.createdAt } }, orderBy: { createdAt: "desc" } });
  if (!target) throw new Error(`No earlier successful ${failed.env} deployment to roll back to`);
  const r = await runDeployment(companyId, failed.env, { version: target.version, commit: target.commit, rolledBackFrom: failed.id });
  if (r.success) await prisma.deployment.update({ where: { id: failed.id }, data: { status: "ROLLED_BACK" } });
  await audit(companyId, actor, "DEPLOY_ROLLBACK", failed.id, `${failed.env} ${failed.version} → ${target.version}: ${r.success ? "succeeded" : `failed at ${r.failedStage}`}`);
  return { rollbackDeploymentId: r.deploymentId, env: failed.env, from: failed.version, to: target.version, success: r.success, failedStage: r.failedStage };
}
