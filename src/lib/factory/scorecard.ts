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

type B = { status: string; attempt: number; findings: string; criteria: string; browser?: string; orchestration?: string; itemKey: string };

/**
 * Product-quality metrics (V10 §13), all from recorded runs:
 *   journeysPassed         browser journeys passed / attempted (not_run excluded, reported separately)
 *   browserCleanRate       browser-verified runs with no blocking browser finding / browser-verified runs
 *   accessibilityIssues    unlabeled-control findings across browser runs (count)
 *   repairSuccess          runs that failed an attempt and then VERIFIED / runs that failed an attempt
 *   criteriaMet            acceptance criteria 'met' / criteria assessed on verified runs
 *   unsupportedClaims      'met' criteria whose evidence names no test/command/browser check (count)
 *   securityFindings       security findings across runs (count)
 */
function productQuality(builds: B[], _items: unknown[]) {
  const browser = builds.map((b) => parseJSON<{ status?: string; journeys?: { status: string }[]; findings?: { kind: string; blocking: boolean }[] }>(b.browser ?? "{}", {})).filter((r) => r.status && r.status !== "unavailable");
  const journeys = browser.flatMap((r) => r.journeys ?? []);
  const attempted = journeys.filter((j) => j.status !== "not_run");
  const a11y = browser.flatMap((r) => r.findings ?? []).filter((f) => f.kind === "unlabeled_control").length;
  const repaired = builds.filter((b) => b.attempt > 0 || parseJSON<{ attempts?: { passed: boolean }[] }>(b.orchestration ?? "{}", {}).attempts?.some((x) => !x.passed));
  const crit = builds.filter((b) => b.status === "VERIFIED").flatMap((b) => parseJSON<{ status: string; evidence: string }[]>(b.criteria, []));
  const met = crit.filter((c) => c.status === "met");
  const unsupported = met.filter((c) => !/test|\.js|command|run|passes|passing|browser|journey|exit 0|assert/i.test(c.evidence)).length;
  const sec = builds.flatMap((b) => parseJSON<{ source: string }[]>(b.findings, [])).filter((f) => f.source === "security").length;
  return {
    journeysPassed: m(attempted.filter((j) => j.status === "passed").length, attempted.length, "ratio", `browser journeys passed / attempted (${journeys.length - attempted.length} could not be attempted)`, "no browser journey was attempted (no UI change browser-verified, or browser automation unavailable)"),
    browserCleanRate: m(browser.filter((r) => !(r.findings ?? []).some((f) => f.blocking)).length, browser.length, "ratio", "browser-verified runs without blocking findings / browser-verified runs", "no run was browser-verified"),
    accessibilityIssues: { value: browser.length ? a11y : null, numerator: a11y, denominator: browser.length, unit: "count", formula: "unlabeled controls/fields found by browser verification", ...(browser.length ? {} : { unavailable: "no run was browser-verified" }) } as ScoreMetric,
    repairSuccess: m(repaired.filter((b) => b.status === "VERIFIED").length, repaired.length, "ratio", "runs that failed at least one attempt and then verified / runs that failed at least one attempt", "no run needed a repair"),
    criteriaMet: m(met.length, crit.length, "ratio", "acceptance criteria 'met' / criteria assessed on verified runs", "no verified run"),
    unsupportedClaims: { value: crit.length ? unsupported : null, numerator: unsupported, denominator: met.length, unit: "count", formula: "'met' criteria whose evidence names no test, command or browser check", ...(crit.length ? {} : { unavailable: "no verified run" }) } as ScoreMetric,
    securityFindings: { value: builds.length ? sec : null, numerator: sec, denominator: builds.length, unit: "count", formula: "security-review findings across runs", ...(builds.length ? {} : { unavailable: "no run" }) } as ScoreMetric,
  };
}

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
      ...productQuality(builds, items),
    },
    gate: { implemented: gate.implemented, approvedForRelease: gate.approvedForRelease, deployed: gate.deployed },
  };
}
