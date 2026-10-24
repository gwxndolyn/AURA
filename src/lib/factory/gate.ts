/**
 * Delivery quality gate and delivery report.
 *
 * The gate evaluates a product's ACTUAL acceptance state from persisted
 * evidence. Every criterion is passed / failed / blocked / not_verified with
 * the evidence it rests on. Profiles decide which criteria are REQUIRED for
 * "implemented" (a static site and a financial app differ); a criterion that
 * is not required is still reported.
 *
 * Two separate conclusions, never merged:
 *   implemented          every required criterion passed
 *   approvedForRelease   implemented AND the release candidate was approved by
 *                        a person (deployment is a further, separate approval)
 *
 * A passing build does not make a feature work and a passing unit suite does
 * not make an application work: "journeys" stays not_verified unless an
 * executed end-to-end check is recorded — AURA does not run browser tests of
 * generated apps yet, and says so.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit } from "@/lib/events/emit";
import { BriefSchema, requirementIds } from "./brief";
import { loadProduct, limitsOf, productEvent } from "./store";

export type GateStatus = "passed" | "failed" | "blocked" | "not_verified";
export interface GateCriterion { id: string; label: string; status: GateStatus; required: boolean; detail: string; evidence: { kind: string; ref: string; detail: string }[] }

export const GATE_CRITERIA = ["requirements", "tasks", "build", "tests", "integration", "journeys", "api_db", "security", "review", "regression", "approvals", "blockers", "delivery"] as const;
export type GateCriterionId = (typeof GATE_CRITERIA)[number];

export const QUALITY_PROFILES: Record<string, { label: string; description: string; required: GateCriterionId[] }> = {
  "static-site": { label: "Static / marketing site", description: "Content and pages; build and tests required, no security-critical data.", required: ["tasks", "build", "tests", "blockers"] },
  "web-app": { label: "Web application", description: "Default: every requirement traced to verified work, tests, integration, review and security review.", required: ["requirements", "tasks", "build", "tests", "integration", "security", "review", "blockers"] },
  "financial": { label: "Financial / regulated application", description: "Everything in web-app plus no open regression warnings, API/data consistency, recorded approvals and end-to-end journey evidence.", required: ["requirements", "tasks", "build", "tests", "integration", "journeys", "api_db", "security", "review", "regression", "approvals", "blockers"] },
};
export const profileOf = (id: string | null | undefined) => QUALITY_PROFILES[id ?? ""] ? (id as string) : "web-app";

type Ev = { kind: string; ref: string; detail: string };
const crit = (id: GateCriterionId, label: string, status: GateStatus, detail: string, evidence: Ev[], required: GateCriterionId[]): GateCriterion => ({ id, label, status, detail, evidence: evidence.slice(0, 20), required: required.includes(id) });

export async function evaluateGate(companyId: string, productId: string) {
  const p = await loadProduct(companyId, productId);
  const profile = profileOf(p.qualityProfile);
  const req = QUALITY_PROFILES[profile].required;
  const [items, briefRow, rcRow, approvals, builds, defects] = await Promise.all([
    prisma.backlogItem.findMany({ where: { productId, companyId } }),
    prisma.productBrief.findFirst({ where: { productId }, orderBy: { version: "desc" } }),
    prisma.productArtifact.findFirst({ where: { productId, companyId, kind: "RELEASE_CANDIDATE" }, orderBy: { version: "desc" } }),
    prisma.productApproval.findMany({ where: { productId, companyId } }),
    prisma.build.findMany({ where: { productId, companyId }, include: { commands: { where: { actor: "engine" }, orderBy: { createdAt: "asc" }, select: { id: true, purpose: true, command: true, exitCode: true, timedOut: true } } } }),
    prisma.defect.findMany({ where: { productId, companyId, status: { in: ["OPEN", "RECURRING"] } } }),
  ]);
  const tasks = items.filter((i) => (i.level === "TASK" || i.level === "REPAIR") && i.status !== "CANCELLED");
  const exec = tasks.filter((t) => t.executable);
  const current = new Map(builds.map((b) => [b.id, b]));
  const taskBuilds = exec.flatMap((t) => (t.buildId && current.has(t.buildId) ? [current.get(t.buildId)!] : []));
  const verifiedBuilds = taskBuilds.filter((b) => b.status === "VERIFIED");
  const checks: GateCriterion[] = [];

  // Requirements: every brief requirement traced to at least one task, and every such task verified.
  const brief = briefRow ? BriefSchema.safeParse(parseJSON(briefRow.content, {})) : null;
  if (!brief?.success) checks.push(crit("requirements", "Every requirement is implemented by verified work", "blocked", "no valid brief", [], req));
  else {
    // Brief requirements plus change-request requirements (CR-n) added by follow-up changes.
    const crIds = [...new Set(tasks.flatMap((t) => parseJSON<string[]>(t.requirements, [])).filter((r) => r.startsWith("CR-")))];
    const ids = [...requirementIds(brief.data).filter((r) => !r.startsWith("NFR-")), ...crIds];
    const per = ids.map((r) => ({ r, impl: tasks.filter((t) => parseJSON<string[]>(t.requirements, []).includes(r)) }));
    const untraced = per.filter((x) => !x.impl.length).map((x) => x.r);
    const unverified = per.filter((x) => x.impl.length && !x.impl.every((t) => t.status === "VERIFIED" || (!t.executable && t.status === "DONE_UNVERIFIED"))).map((x) => x.r);
    const anyFailed = per.some((x) => x.impl.some((t) => t.status === "FAILED"));
    checks.push(crit("requirements", "Every requirement is implemented by verified work", untraced.length || unverified.length ? (anyFailed ? "failed" : "not_verified") : "passed", `${ids.length - untraced.length - unverified.length}/${ids.length} requirement(s) verified${untraced.length ? `; not traced to any task: ${untraced.join(", ")}` : ""}${unverified.length ? `; not yet verified: ${unverified.join(", ")}` : ""}`, per.flatMap((x) => x.impl.map((t) => ({ kind: "item", ref: t.key, detail: `${x.r} → ${t.key} ${t.status}` }))), req));
  }

  const failedTasks = exec.filter((t) => t.status === "FAILED");
  const blockedTasks = tasks.filter((t) => t.status === "BLOCKED");
  checks.push(crit("tasks", "Executable tasks verified in the sandbox", !exec.length ? "not_verified" : failedTasks.length ? "failed" : exec.every((t) => t.status === "VERIFIED") ? "passed" : blockedTasks.some((b) => b.executable) ? "blocked" : "not_verified", `${exec.filter((t) => t.status === "VERIFIED").length}/${exec.length} verified${failedTasks.length ? `; failed: ${failedTasks.map((t) => t.key).join(", ")}` : ""}`, exec.map((t) => ({ kind: "item", ref: t.key, detail: t.status })), req));

  // Build / type-check / lint and tests: from the engine's own command runs on the verified builds.
  // The final attempt of each verified run is what was committed: judge its last engine command per check (earlier attempts failed by definition of a repair).
  const cmds = verifiedBuilds.flatMap((b) => [...new Map(b.commands.map((c) => [c.purpose, { ...c, buildId: b.id }])).values()]);
  const buildish = cmds.filter((c) => ["build", "typecheck", "lint", "syntax"].includes(c.purpose));
  checks.push(crit("build", "Build, type-check and lint", !verifiedBuilds.length ? "not_verified" : !buildish.length ? "not_verified" : buildish.every((c) => c.exitCode === 0 && !c.timedOut) ? "passed" : "failed", !verifiedBuilds.length ? "no verified run yet" : !buildish.length ? "no build/type-check/lint command is configured for this project (nothing to run)" : `${buildish.filter((c) => c.exitCode === 0).length}/${buildish.length} command(s) passed`, buildish.map((c) => ({ kind: "command_run", ref: c.id, detail: `${c.command} → exit ${c.exitCode}` })), req));
  const testRuns = cmds.filter((c) => c.purpose === "test");
  checks.push(crit("tests", "Automated tests pass", !testRuns.length ? "not_verified" : testRuns.every((c) => c.exitCode === 0 && !c.timedOut) ? "passed" : "failed", `final full-suite run of ${verifiedBuilds.length} verified task(s): ${testRuns.filter((c) => c.exitCode === 0).length}/${testRuns.length} passed`, testRuns.map((c) => ({ kind: "command_run", ref: c.id, detail: `${c.command} → exit ${c.exitCode}` })), req));

  const rc = rcRow ? parseJSON<{ branch?: string; sha?: string; test?: { mode: string; passed: number; failed: number; total: number } }>(rcRow.content, {}) : null;
  checks.push(crit("integration", "Integrated release candidate re-verified", !rc?.test ? "not_verified" : rc.test.mode === "docker" && rc.test.failed === 0 && rc.test.total > 0 ? "passed" : "failed", rc?.test ? `${rc.test.passed}/${rc.test.total} on ${rc.branch}` : "no release candidate built", rcRow ? [{ kind: "artifact", ref: rcRow.id, detail: `${rc?.branch} @ ${rc?.sha?.slice(0, 8)}` }] : [], req));

  // Journeys: the deployed application's journey checks (HTTP against the real deployment) for the current release.
  const deployed = await prisma.productDeployment.findFirst({ where: { productId, companyId, status: "VERIFIED" }, orderBy: { finishedAt: "desc" } });
  const deployedHealth = deployed ? parseJSON<{ path: string; ok: boolean; detail: string }[]>(deployed.health, []) : [];
  const rcSha = rcRow ? parseJSON<{ sha?: string }>(rcRow.content, {}).sha : undefined;
  checks.push(crit("journeys", "Critical user journeys verified on the deployed application", !deployed ? "not_verified" : deployed.sha !== rcSha ? "not_verified" : deployedHealth.length > 1 && deployedHealth.every((h) => h.ok) ? "passed" : "failed", !deployed ? "not deployed yet; journey checks run against the deployment (HTTP status/text; no browser automation of generated UIs)" : deployed.sha !== rcSha ? `deployed ${deployed.sha.slice(0, 8)} is not the current release candidate` : `${deployedHealth.filter((h) => h.ok).length}/${deployedHealth.length} checks at ${deployed.url}`, deployedHealth.map((h) => ({ kind: "health", ref: deployed!.id, detail: `${h.path}: ${h.detail}` })), req));

  const impacts = verifiedBuilds.map((b) => ({ b, imp: parseJSON<{ flags?: { kind: string; confidence: string; severity: string; detail: string }[] }>(b.impact, {}) }));
  const flags = impacts.flatMap((x) => (x.imp.flags ?? []).map((f) => ({ ...f, buildId: x.b.id, itemKey: x.b.itemKey })));
  const apiFlags = flags.filter((f) => ["api_breaking", "contract_mismatch", "migration"].includes(f.kind));
  checks.push(crit("api_db", "API and data model consistency", !verifiedBuilds.length ? "not_verified" : apiFlags.some((f) => f.confidence === "confirmed") ? "failed" : apiFlags.length ? "not_verified" : "passed", !verifiedBuilds.length ? "no verified change has been analysed yet" : apiFlags.length ? `${apiFlags.length} warning(s) need review: ${apiFlags.map((f) => f.detail).slice(0, 3).join("; ")}` : "static analysis found no route removals, frontend/backend contract mismatches or schema changes", apiFlags.map((f) => ({ kind: "impact", ref: f.buildId, detail: `${f.itemKey}: ${f.detail}` })), req));

  const findings = verifiedBuilds.flatMap((b) => parseJSON<{ source: string; blocking: boolean; severity: string; title: string }[]>(b.findings, []).map((f) => ({ ...f, buildId: b.id })));
  const secBlocking = findings.filter((f) => f.source === "security" && f.blocking);
  checks.push(crit("security", "Security review of every verified change", !verifiedBuilds.length ? "not_verified" : secBlocking.length ? "failed" : "passed", `${verifiedBuilds.length} change(s) reviewed by the security agent; ${findings.filter((f) => f.source === "security").length} finding(s), ${secBlocking.length} blocking`, findings.filter((f) => f.source === "security").map((f) => ({ kind: "finding", ref: f.buildId, detail: `${f.severity}: ${f.title}` })), req));
  const openBlocking = taskBuilds.filter((b) => b.status !== "VERIFIED").flatMap((b) => parseJSON<{ blocking: boolean; title: string }[]>(b.findings, []).filter((f) => f.blocking).map((f) => ({ kind: "finding", ref: b.id, detail: f.title })));
  checks.push(crit("review", "No open blocking review findings", !builds.length ? "not_verified" : openBlocking.length ? "failed" : "passed", `${openBlocking.length} open blocking finding(s)`, openBlocking, req));

  const regWarn = flags.filter((f) => ["coverage_gap", "authorization", "dependency", "test_weakened", "deleted_still_imported"].includes(f.kind));
  checks.push(crit("regression", "Regression analysis clean", !verifiedBuilds.length ? "not_verified" : regWarn.some((f) => f.confidence === "confirmed") ? "failed" : regWarn.length ? "not_verified" : "passed", !verifiedBuilds.length ? "no verified change has been analysed yet" : regWarn.length ? `${regWarn.length} warning(s) to review (e.g. ${regWarn[0].detail})` : "no coverage gaps, dependency, authorization or test-weakening warnings", regWarn.map((f) => ({ kind: "impact", ref: f.buildId, detail: `${f.itemKey} ${f.kind}: ${f.detail}` })), req));

  const pending = approvals.filter((a) => a.status === "PENDING");
  checks.push(crit("approvals", "Required approvals recorded", !p.scopeApproved ? "blocked" : pending.length ? "blocked" : "passed", `scope ${p.scopeApproved ? `approved by ${p.scopeApprovedBy}` : "not approved"}; ${pending.length} pending`, approvals.map((a) => ({ kind: "approval", ref: a.id, detail: `${a.action} ${a.status.toLowerCase()}${a.decidedBy ? ` by ${a.decidedBy}` : ""}` })), req));

  const blockers = [...blockedTasks.map((t) => ({ kind: "item", ref: t.key, detail: t.blockedReason.slice(0, 200) })), ...defects.map((d) => ({ kind: "defect", ref: d.id, detail: `${d.itemKey}: ${d.title}` }))];
  checks.push(crit("blockers", "No known blockers", blockers.length ? "blocked" : "passed", `${blockedTasks.length} blocked task(s), ${defects.length} open defect(s)`, blockers, req));

  const repo = p.repoId ? await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId } }) : null;
  const targets = await prisma.deployTarget.findMany({ where: { productId, companyId } });
  const connected = targets.filter((t) => t.status === "CONNECTED");
  checks.push(crit("delivery", "Delivery configuration (repository + deployment target)", !repo ? "blocked" : connected.length ? "passed" : targets.length ? "failed" : "not_verified", !repo ? "no repository" : `${repo.provider === "local" ? "AURA local repository" : `${repo.provider} ${repo.name}`}; ${connected.length ? `deploy targets: ${connected.map((t) => `${t.env} (${t.provider})`).join(", ")}` : targets.length ? `target(s) not connected: ${targets.map((t) => `${t.env}: ${t.statusDetail}`).join("; ")}` : "no deployment target configured"}`, [...(repo ? [{ kind: "repository", ref: repo.id, detail: `${repo.provider}:${repo.name}` }] : []), ...targets.map((t) => ({ kind: "deploy_target", ref: t.id, detail: `${t.env} ${t.provider} ${t.status}` }))], req));

  const required = checks.filter((c) => c.required);
  const implemented = required.every((c) => c.status === "passed");
  const rcApproved = rcRow?.status === "APPROVED";
  const deployedVerified = !!deployed && deployed.sha === rcSha;
  return {
    profile, profileLabel: QUALITY_PROFILES[profile].label, profileDescription: QUALITY_PROFILES[profile].description,
    criteria: checks,
    summary: { passed: checks.filter((c) => c.status === "passed").length, failed: checks.filter((c) => c.status === "failed").length, blocked: checks.filter((c) => c.status === "blocked").length, notVerified: checks.filter((c) => c.status === "not_verified").length, requiredOpen: required.filter((c) => c.status !== "passed").map((c) => c.id) },
    implemented,
    approvedForRelease: implemented && rcApproved,
    deployed: deployedVerified,
    deployment: deployed ? { id: deployed.id, env: deployed.env, url: deployed.url, sha: deployed.sha, verifiedAt: deployed.finishedAt } : null,
    note: implemented ? (rcApproved ? (deployedVerified ? `Implemented, approved and deployed: ${deployed!.env} at ${deployed!.url} passed AURA's post-deploy checks.` : "Implemented and approved for release. Deployment is a separate approval and needs a connected deployment target.") : "Implemented: every required criterion passed. Release still needs a person to approve the release candidate.") : `Not complete: ${required.filter((c) => c.status !== "passed").map((c) => c.label.toLowerCase()).join("; ")}.`,
  };
}

export async function setQualityProfile(companyId: string, productId: string, actor: string, profile: string) {
  if (!QUALITY_PROFILES[profile]) throw new ApiError("Unknown quality profile", 422);
  await loadProduct(companyId, productId);
  await prisma.product.update({ where: { id: productId }, data: { qualityProfile: profile } });
  await audit(companyId, actor, "PRODUCT_QUALITY_PROFILE", productId, profile);
  return { profile };
}

/**
 * Delivery report: generated from the same persisted records the gate reads
 * (gate result, verified commits, defects, usage) — never from agent text —
 * and stored as a versioned DELIVERY_REPORT artifact.
 */
export async function deliveryReport(companyId: string, productId: string, actor: string) {
  const p = await loadProduct(companyId, productId);
  const gate = await evaluateGate(companyId, productId);
  const [items, gitOps, defects, builds, rc] = await Promise.all([
    prisma.backlogItem.findMany({ where: { productId, companyId, level: { in: ["TASK", "REPAIR"] } }, orderBy: { key: "asc" } }),
    prisma.gitOperation.findMany({ where: { productId, companyId, status: "SUCCEEDED" }, orderBy: { createdAt: "asc" } }),
    prisma.defect.findMany({ where: { productId, companyId }, orderBy: { createdAt: "asc" } }),
    prisma.build.findMany({ where: { productId, companyId }, select: { id: true, itemKey: true, status: true, costUsd: true, tokensIn: true, tokensOut: true, sandboxMs: true, attempt: true, headSha: true, branch: true, stopReason: true } }),
    prisma.productArtifact.findFirst({ where: { productId, companyId, kind: "RELEASE_CANDIDATE" }, orderBy: { version: "desc" } }),
  ]);
  const content = {
    product: { id: p.id, title: p.title, phase: p.phase, profile: gate.profile },
    conclusion: { implemented: gate.implemented, approvedForRelease: gate.approvedForRelease, deployed: gate.deployed, deployment: gate.deployment, note: gate.note },
    gate: gate.criteria.map((c) => ({ id: c.id, label: c.label, status: c.status, required: c.required, detail: c.detail })),
    tasks: items.map((i) => ({ key: i.key, title: i.title, status: i.status, executable: i.executable, requirements: parseJSON<string[]>(i.requirements, []), build: i.buildId })),
    commits: gitOps.filter((g) => ["commit", "branch", "pull_request", "rollback"].includes(g.op)).map((g) => ({ op: g.op, branch: g.branch, sha: g.sha, url: g.url, detail: g.detail })),
    releaseCandidate: rc ? { version: rc.version, status: rc.status, ...parseJSON<Record<string, unknown>>(rc.content, {}) } : null,
    defects: { total: defects.length, fixed: defects.filter((d) => d.status === "FIXED").length, open: defects.filter((d) => ["OPEN", "RECURRING"].includes(d.status)).length, abandoned: defects.filter((d) => d.status === "ABANDONED").length, items: defects.map((d) => ({ id: d.id, itemKey: d.itemKey, title: d.title, category: d.category, status: d.status, failedRun: d.commandRunId, fixedBy: d.fixedByCommandRunId })) },
    usage: { runs: builds.length, estimatedCostUsd: Number(builds.reduce((s, b) => s + b.costUsd, 0).toFixed(4)), tokensIn: builds.reduce((s, b) => s + b.tokensIn, 0), tokensOut: builds.reduce((s, b) => s + b.tokensOut, 0), sandboxSeconds: Math.round(builds.reduce((s, b) => s + b.sandboxMs, 0) / 1000), budgetUsd: limitsOf(p).projectBudgetUsd, costNote: "Estimated from provider-reported tokens at list prices; not an invoice." },
    generatedAt: new Date().toISOString(),
  };
  const version = ((await prisma.productArtifact.findFirst({ where: { productId, kind: "DELIVERY_REPORT" }, orderBy: { version: "desc" } }))?.version ?? 0) + 1;
  const a = await prisma.productArtifact.create({ data: { productId, companyId, kind: "DELIVERY_REPORT", version, title: `Delivery report ${version}${gate.implemented ? "" : " (incomplete)"}`, content: JSON.stringify(content), status: gate.implemented ? "APPROVED" : "PROPOSED", source: "engine", producedBy: "engine" } });
  await productEvent(companyId, productId, `Delivery report ${version} generated by ${actor}: ${gate.implemented ? "implemented" : `not complete (${gate.summary.requiredOpen.join(", ")})`}`, { level: gate.implemented ? "success" : "warning" });
  return { id: a.id, version, ...content };
}
