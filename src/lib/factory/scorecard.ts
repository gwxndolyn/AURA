/**
 * Delivery scorecard per product, computed ONLY from recorded rows. A metric
 * with no data is `null` with the reason ("unavailable"), never a guess.
 *
 *  requirementsSatisfied   requirements traced to VERIFIED work / all (gate)
 *  acceptancePassRate      engine test runs exit 0 / engine test runs
 *  buildSuccessRate        builds VERIFIED / builds finished
 *  regressionRate          verified builds whose impact analysis raised a confirmed flag / verified builds
 *  postDeployDefects       defects created after the first verified deployment
 *  recoveryMinutes         mean time from a FAILED/BLOCKED build to the next VERIFIED build of the same task
 *  deployVerification      deployments VERIFIED / deployments that reached verification
 *  costPerVerifiedTask     estimated model cost / VERIFIED tasks (estimate, labelled)
 *  timeToFirstUsableMin    product creation → first VERIFIED deployment
 *  evidenceCoverage        tasks VERIFIED (with evidence) / tasks settled
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { evaluateGate } from "./gate";
import { loadProduct } from "./store";

export interface ScoreMetric { value: number | null; numerator: number; denominator: number; unit: string; formula: string; unavailable?: string }
const m = (num: number, den: number, unit: string, formula: string, unavailable: string): ScoreMetric => ({ value: den ? num / den : null, numerator: num, denominator: den, unit, formula, ...(den ? {} : { unavailable }) });

export async function deliveryScorecard(companyId: string, productId: string) {
  const p = await loadProduct(companyId, productId);
  const [builds, items, deploys, defects, cost, gate] = await Promise.all([
    prisma.build.findMany({ where: { companyId, productId, itemKey: { not: "RELEASE" } }, include: { commands: { where: { actor: "engine", purpose: "test" }, select: { exitCode: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.backlogItem.findMany({ where: { companyId, productId, level: { in: ["TASK", "REPAIR"] } } }),
    prisma.productDeployment.findMany({ where: { companyId, productId }, orderBy: { createdAt: "asc" } }),
    prisma.defect.findMany({ where: { companyId, productId } }),
    prisma.usageEvent.aggregate({ where: { companyId, metric: "ai_cost_usd", OR: [{ source: { startsWith: `product:${productId}` } }, { source: { startsWith: "agent_run:" } }], createdAt: { gte: p.createdAt } }, _sum: { quantity: true } }),
    evaluateGate(companyId, productId),
  ]);
  const req = gate.criteria.find((c) => c.id === "requirements");
  const reqMatch = req?.detail.match(/^(\d+)\/(\d+)/);
  const tests = builds.flatMap((b) => b.commands);
  const finished = builds.filter((b) => ["VERIFIED", "FAILED", "BLOCKED"].includes(b.status));
  const verified = builds.filter((b) => b.status === "VERIFIED");
  const regressions = verified.filter((b) => parseJSON<{ flags?: { confidence: string }[] }>(b.impact, {}).flags?.some((f) => f.confidence === "confirmed"));
  const firstDeploy = deploys.find((d) => d.status === "VERIFIED" || d.status === "SUPERSEDED");
  const postDeployDefects = firstDeploy ? defects.filter((d) => d.createdAt > (firstDeploy.finishedAt ?? firstDeploy.createdAt)).length : null;
  const recoveries: number[] = [];
  for (const b of builds.filter((x) => ["FAILED", "BLOCKED"].includes(x.status) && x.finishedAt)) {
    const next = verified.find((v) => v.itemKey === b.itemKey && v.createdAt > b.createdAt) ?? verified.find((v) => v.itemKey.startsWith(`${b.itemKey}.R`) && v.createdAt > b.createdAt);
    if (next?.finishedAt) recoveries.push((next.finishedAt.getTime() - b.finishedAt!.getTime()) / 60_000);
  }
  const reachedVerify = deploys.filter((d) => ["VERIFIED", "SUPERSEDED", "ROLLED_BACK", "FAILED"].includes(d.status) && d.health !== "[]");
  const verifiedTasks = items.filter((i) => i.status === "VERIFIED").length;
  const settled = items.filter((i) => ["VERIFIED", "DONE_UNVERIFIED", "FAILED", "BLOCKED", "CANCELLED"].includes(i.status) && i.status !== "CANCELLED").length;
  // Planning/change usage is recorded per product; engineering-run cost is on the builds (not double counted).
  const planning = await prisma.usageEvent.aggregate({ where: { companyId, metric: "ai_cost_usd", source: { startsWith: `product:${productId}` } }, _sum: { quantity: true } });
  const est = (planning._sum.quantity ?? 0) + builds.reduce((s, b) => s + b.costUsd, 0);
  void cost;
  return {
    product: { id: p.id, title: p.title, createdAt: p.createdAt },
    metrics: {
      requirementsSatisfied: reqMatch ? m(Number(reqMatch[1]), Number(reqMatch[2]), "ratio", "requirements traced to VERIFIED work / requirements (brief + change requests)", "no requirements recorded") : m(0, 0, "ratio", "requirements traced to VERIFIED work / requirements", "no valid brief"),
      acceptancePassRate: m(tests.filter((t) => t.exitCode === 0).length, tests.length, "ratio", "engine sandbox test runs that exited 0 / engine test runs", "no test has run"),
      buildSuccessRate: m(verified.length, finished.length, "ratio", "engineering runs VERIFIED / runs finished", "no engineering run has finished"),
      regressionRate: m(regressions.length, verified.length, "ratio", "verified runs whose impact analysis raised a confirmed breakage / verified runs", "no verified run"),
      postDeployDefects: postDeployDefects === null ? m(0, 0, "count", "defects recorded after the first verified deployment", "never deployed") : { value: postDeployDefects, numerator: postDeployDefects, denominator: 1, unit: "count", formula: "defects recorded after the first verified deployment" },
      recoveryMinutes: m(recoveries.reduce((s, x) => s + x, 0), recoveries.length, "minutes", "mean minutes from a failed/blocked run to the next verified run of the same task (or its repair)", "no failed run was recovered yet"),
      deployVerification: m(reachedVerify.filter((d) => ["VERIFIED", "SUPERSEDED"].includes(d.status)).length, reachedVerify.length, "ratio", "deployments that passed post-deploy checks / deployments that reached verification", "no deployment reached verification"),
      costPerVerifiedTask: m(est, verifiedTasks, "usd (estimate)", "estimated model cost (provider-reported tokens × list price) / VERIFIED tasks", "no verified task"),
      timeToFirstUsableMin: firstDeploy ? { value: ((firstDeploy.finishedAt ?? firstDeploy.createdAt).getTime() - p.createdAt.getTime()) / 60_000, numerator: 1, denominator: 1, unit: "minutes", formula: "product created → first verified deployment" } : m(0, 0, "minutes", "product created → first verified deployment", "never deployed"),
      evidenceCoverage: m(verifiedTasks, settled, "ratio", "tasks VERIFIED with sandbox evidence / tasks settled", "no task settled"),
    },
    gate: { implemented: gate.implemented, approvedForRelease: gate.approvedForRelease, deployed: gate.deployed },
  };
}
