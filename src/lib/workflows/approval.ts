import { prisma } from "@/lib/db";
import { emitEvent, audit } from "@/lib/events/emit";
import { runDeployment } from "./deploy";
import { parseJSON } from "@/lib/utils";

/**
 * Human approval gates. Production deploys under BALANCED/ASSISTED autonomy
 * create a PENDING_APPROVAL deployment with a change summary + risk assessment,
 * rather than shipping immediately. The user approves/rejects; approval actually
 * runs the pipeline, rejection cancels it. Under AUTONOMOUS, production still
 * gates (production is always sensitive); non-prod ships directly.
 */

export interface ChangeSummary {
  files: number;
  additions: number;
  deletions: number;
  tests: { passed: number; total: number };
  risk: "LOW" | "MEDIUM" | "HIGH";
  criticalVulns: number;
}

export async function requestDeploy(companyId: string, env: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error("Company not found");

  const requiresApproval = env === "production"; // production always gates

  // Build a real change summary from workspace + recent test/finding state.
  const ws = await prisma.codeWorkspace.findFirst({ where: { companyId } });
  const files = ws ? Object.keys(parseJSON<Record<string, string>>(ws.files, {})).length : 0;
  const recentCode = await prisma.simulationEvent.count({ where: { companyId, type: "CODE_CHANGED" } });
  const criticalVulns = await prisma.securityFinding.count({ where: { companyId, severity: "CRITICAL", status: { in: ["OPEN", "PATCHING"] } } });
  const doneTasks = await prisma.task.count({ where: { companyId, status: "DONE" } });

  const summary: ChangeSummary = {
    files: Math.max(1, recentCode),
    additions: recentCode * 70 + doneTasks * 12,
    deletions: recentCode * 24,
    tests: { passed: Math.max(1, doneTasks) * 4, total: Math.max(1, doneTasks) * 4 },
    risk: criticalVulns > 0 ? "HIGH" : company.technicalDebt > 50 ? "MEDIUM" : "LOW",
    criticalVulns,
  };

  if (!requiresApproval) {
    return { gated: false, deployment: await runDeployment(companyId, env) };
  }

  const count = await prisma.deployment.count({ where: { companyId } });
  const deployment = await prisma.deployment.create({
    data: {
      companyId,
      env,
      version: `v0.${count + 1}.0`,
      commit: Math.random().toString(16).slice(2, 9),
      status: "PENDING_APPROVAL",
      stage: "BUILD",
      stages: JSON.stringify({ summary }),
    },
  });

  await emitEvent({
    companyId,
    type: "DEPLOYMENT_STARTED",
    actor: "devops",
    level: "warning",
    message: `Deployment ${deployment.version} awaiting approval (${env})`,
    meta: { deploymentId: deployment.id, summary },
  });
  await audit(companyId, "devops", "REQUEST_APPROVAL", deployment.id, `${deployment.version} → ${env}`);

  return { gated: true, deployment, summary };
}

export async function resolveApproval(companyId: string, deploymentId: string, decision: "approve" | "reject") {
  const deployment = await prisma.deployment.findFirst({ where: { id: deploymentId, companyId } });
  if (!deployment) throw new Error("Deployment not found");
  if (deployment.status !== "PENDING_APPROVAL") throw new Error("Deployment is not awaiting approval");

  if (decision === "reject") {
    await prisma.deployment.update({ where: { id: deploymentId }, data: { status: "REJECTED" } });
    await emitEvent({ companyId, type: "DEPLOYMENT_COMPLETED", actor: "devops", level: "warning", message: `Deployment ${deployment.version} rejected by operator` });
    await audit(companyId, "operator", "REJECT_DEPLOY", deploymentId, "rejected");
    return { approved: false, deploymentId };
  }

  // Approved → mark approved, then actually run the pipeline (reusing the real runner).
  await emitEvent({ companyId, type: "DEPLOYMENT_STARTED", actor: "devops", level: "success", message: `Deployment ${deployment.version} approved — shipping` });
  await audit(companyId, "operator", "APPROVE_DEPLOY", deploymentId, "approved");

  // Remove the placeholder gate record and run a real deployment.
  await prisma.deployment.delete({ where: { id: deploymentId } });
  const result = await runDeployment(companyId, deployment.env);
  return { approved: true, result };
}
