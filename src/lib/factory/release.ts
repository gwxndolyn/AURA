/**
 * Integration and release.
 *
 *  commitVerified   — after a task is VERIFIED, the exact tested file content
 *                     (mission FILE artifacts) is committed to an isolated
 *                     branch `aura/<item-key>` in the product's real git repo.
 *                     Never to the default branch; idempotent per (item, sha).
 *  readiness        — evaluates the release from persisted state, reporting
 *                     passed / failed / not run / not applicable separately.
 *  releaseCandidate — integration branch `aura/release-<n>` combining verified
 *                     branches; re-runs the product's tests on the merged
 *                     tree in the sandbox before it can be approved.
 *  publish / deploy — always behind an explicit ProductApproval. Deployment
 *                     targets need a configured provider; none is bundled, so
 *                     the request records exactly what is missing.
 */
import { emit as emitLearning } from "@/lib/learning/service";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { audit } from "@/lib/events/emit";
import { integrate } from "@/lib/builder/integrate";
import { publishBranch } from "@/lib/integrations/github/service";
import { assertCanStart } from "@/lib/billing/entitlements";
import { commitFiles, headSha, branchDiff, pushBranch, openChangeRequest, remoteStatus, revertAuraCommits, GitError, type RemoteConfig } from "./git";
import { loadProduct, requestApproval, loadPendingApproval, closeApproval, productEvent, movePhase, appendItemHistory, hashPayload, setItemStatus, type ProductRow, type Evidence } from "./store";
import { markStale } from "./memory";
import { integrationBase } from "./base";

type Item = { id: string; key: string; title: string; missionId: string | null; productId: string; evidence: string };

async function repoOf(p: ProductRow) {
  if (!p.repoId) throw new ApiError("Product has no repository", 409);
  const r = await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId: p.companyId } });
  if (!r) throw new ApiError("Repository connection not found", 404);
  return r;
}

/** Tested content of every file the mission changed (latest FILE artifact per path). */
async function testedFiles(missionId: string) {
  const arts = await prisma.missionArtifact.findMany({ where: { missionId, kind: "FILE" }, orderBy: { version: "desc" } });
  const out: Record<string, string> = {};
  for (const a of arts) if (!(a.name in out)) out[a.name] = a.content;
  return out;
}

export async function commitVerified(p: ProductRow, item: Item, actor: string) {
  if (!item.missionId || !p.repoId) return null;
  const repo = await repoOf(p);
  const files = await testedFiles(item.missionId);
  if (!Object.keys(files).length) return null;
  const branch = `aura/${item.key.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
  const idem = `commit:${item.id}:${hashPayload(files).slice(0, 16)}`;
  const prior = await prisma.gitOperation.findFirst({ where: { companyId: p.companyId, idempotencyKey: idem } });
  if (prior) return prior;
  try {
    const r = await commitFiles({ companyId: p.companyId, repoId: repo.id, base: repo.defaultBranch, branch, files, message: `${item.key}: ${item.title}\n\nVerified by AURA mission ${item.missionId} (sandbox tests + review).` });
    const op = await prisma.gitOperation.create({ data: { repoId: repo.id, companyId: p.companyId, productId: p.id, itemKey: item.key, op: "commit", branch, sha: r.sha, status: r.status === "COMMITTED" || r.status === "UNCHANGED" ? "SUCCEEDED" : "BLOCKED", detail: `${r.status.toLowerCase()} ${r.changed.join(", ")}`.trim(), idempotencyKey: idem } });
    const latest = await prisma.backlogItem.findUnique({ where: { id: item.id }, select: { evidence: true } });
    await appendItemHistory(item.id, actor, `committed to ${branch} @ ${r.sha?.slice(0, 8)}`, { evidence: JSON.stringify([...parseJSON<Evidence[]>(latest?.evidence, []), { kind: "commit", ref: r.sha ?? "", detail: `${branch} (${r.changed.join(", ")})` }]) });
    await productEvent(p.companyId, p.id, `${item.key} committed to branch ${branch} (${r.sha?.slice(0, 8)})`, { actor: "devops" });
    return op;
  } catch (e) {
    const msg = (e as Error).message;
    return prisma.gitOperation.create({ data: { repoId: repo.id, companyId: p.companyId, productId: p.id, itemKey: item.key, op: "commit", branch, status: "FAILED", detail: msg.slice(0, 500), idempotencyKey: idem } });
  }
}

export type CheckStatus = "passed" | "failed" | "not_run" | "not_applicable";
export interface ReadinessCheck { id: string; label: string; status: CheckStatus; detail: string; evidence?: string }

/** Release readiness from persisted state only. Passing tests alone never make it "ready". */
export async function readiness(companyId: string, productId: string) {
  const p = await loadProduct(companyId, productId);
  const items = await prisma.backlogItem.findMany({ where: { productId } });
  const tasks = items.filter((i) => (i.level === "TASK" || i.level === "REPAIR") && i.status !== "CANCELLED");
  const brief = await prisma.productBrief.findFirst({ where: { productId }, orderBy: { version: "desc" } });
  const rc = await prisma.productArtifact.findFirst({ where: { productId, kind: "RELEASE_CANDIDATE" }, orderBy: { version: "desc" } });
  const rcContent = rc ? parseJSON<{ test?: { mode: string; passed: number; failed: number; total: number }; branch?: string }>(rc.content, {}) : null;
  const buildIds = tasks.map((t) => t.buildId).filter(Boolean) as string[];
  const builds = buildIds.length ? await prisma.build.findMany({ where: { id: { in: buildIds }, companyId } }) : [];
  const allFindings = builds.flatMap((b) => parseJSON<{ source: string; blocking: boolean; severity: string }[]>(b.findings, []));
  const openFindings = builds.filter((b) => b.status !== "VERIFIED").flatMap((b) => parseJSON<{ blocking: boolean }[]>(b.findings, [])).filter((f) => f.blocking).length;
  const secReviewed = builds.filter((b) => b.status === "VERIFIED").length;
  const secFailed = allFindings.filter((f) => f.source === "security" && f.blocking).length;
  const exec = tasks.filter((t) => t.executable);
  const nonExec = tasks.filter((t) => !t.executable);
  const repo = p.repoId ? await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId } }) : null;
  const checks: ReadinessCheck[] = [
    { id: "scope", label: "Scope approved", status: p.scopeApproved ? "passed" : "failed", detail: p.scopeApproved ? `by ${p.scopeApprovedBy}` : "scope not approved", evidence: brief ? `brief v${brief.version}` : undefined },
    { id: "executable_verified", label: "Executable tasks verified in the sandbox", status: !exec.length ? "not_run" : exec.every((t) => t.status === "VERIFIED") ? "passed" : "failed", detail: `${exec.filter((t) => t.status === "VERIFIED").length}/${exec.length} verified` },
    { id: "non_executable", label: "Non-executable tasks", status: !nonExec.length ? "not_applicable" : nonExec.every((t) => t.status === "DONE_UNVERIFIED" || t.status === "VERIFIED") ? "passed" : "failed", detail: `${nonExec.filter((t) => t.status === "DONE_UNVERIFIED").length} accepted by a person without machine verification, ${nonExec.filter((t) => !["DONE_UNVERIFIED", "VERIFIED"].includes(t.status)).length} open` },
    { id: "findings", label: "No open blocking review findings", status: builds.length ? (openFindings ? "failed" : "passed") : "not_run", detail: `${openFindings} open across ${builds.length} run(s)` },
    { id: "security", label: "Security review of every verified change", status: secReviewed ? (secFailed ? "failed" : "passed") : "not_run", detail: secReviewed ? `${secReviewed} change(s) reviewed by the security agent; ${secFailed} blocking issue(s) recorded` : "no verified change reviewed yet" },
    { id: "integration", label: "Release candidate tests pass on the integrated branch", status: !rcContent?.test ? "not_run" : rcContent.test.mode !== "docker" ? "not_run" : rcContent.test.failed === 0 && rcContent.test.total > 0 ? "passed" : "failed", detail: rcContent?.test ? `${rcContent.test.passed}/${rcContent.test.total} on ${rcContent.branch} (${rcContent.test.mode === "docker" ? "Docker sandbox" : "not executed"})` : "no release candidate built" },
    { id: "repository", label: "Remote repository for publication", status: !repo || repo.provider === "local" ? "not_run" : remoteStatus({ provider: repo.provider as "github", name: repo.name, remoteUrl: repo.remoteUrl, credentialEnv: repo.credentialEnv }).configured ? "passed" : "failed", detail: !repo || repo.provider === "local" ? "only AURA's local repository is connected; publication needs GitHub/GitLab" : "remote configured" },
    { id: "migrations", label: "Database migrations reviewed", status: "not_run", detail: "AURA does not inspect database migrations yet; review them in the pull request" },
    { id: "deploy_target", label: "Deployment target and health checks", status: "not_run", detail: "no deployment provider is configured for products (see docs/deployment-and-operations.md)" },
    { id: "monitoring", label: "Production monitoring connected", status: "not_run", detail: "no telemetry integration is connected; AURA does not invent production signals" },
    { id: "rollback", label: "Rollback plan", status: rcContent?.branch ? "passed" : "not_run", detail: rcContent?.branch ? `revert by redeploying ${repo?.defaultBranch ?? "main"}; release is an isolated branch` : "no release candidate" },
  ];
  const blocking = checks.filter((c) => c.status === "failed");
  const notRun = checks.filter((c) => c.status === "not_run");
  return {
    checks,
    summary: { passed: checks.filter((c) => c.status === "passed").length, failed: blocking.length, notRun: notRun.length, notApplicable: checks.filter((c) => c.status === "not_applicable").length },
    canCreateCandidate: checks.find((c) => c.id === "executable_verified")!.status === "passed" && !openFindings,
    productionReady: false as const,
    note: "AURA never declares production readiness by itself: checks that did not run are listed, and deployment requires a configured provider plus explicit approval.",
  };
}

/** Build the integration branch and re-run the product's test suite on it in the sandbox. */
export async function createReleaseCandidate(companyId: string, productId: string, actor: string) {
  const p = await loadProduct(companyId, productId);
  const r = await readiness(companyId, productId);
  if (!r.canCreateCandidate) throw new ApiError("Not every executable task is verified (or blocking findings are open); a release candidate would include unverified work", 409);
  const repo = await repoOf(p);
  const ops = await prisma.gitOperation.findMany({ where: { productId, op: "commit", status: "SUCCEEDED" }, orderBy: { createdAt: "asc" } });
  if (!ops.length) throw new ApiError("No verified commits to release", 409);
  const version = ((await prisma.productArtifact.findFirst({ where: { productId, kind: "RELEASE_CANDIDATE" }, orderBy: { version: "desc" } }))?.version ?? 0) + 1;
  const branch = `aura/release-${version}`;
  // Integrate: merge every verified task branch onto the default branch in a fresh tree, then re-verify for real.
  const items = await prisma.backlogItem.findMany({ where: { productId, status: "VERIFIED", buildId: { not: null } }, orderBy: { updatedAt: "asc" } });
  const verifiedBuilds = await prisma.build.findMany({ where: { id: { in: items.map((i) => i.buildId!) }, companyId, status: "VERIFIED" } });
  // Integrate onto the previous approved release (so nothing already released is lost), else the default branch.
  const baseRef = (await integrationBase(companyId, productId, repo)).branch;
  const base = await headSha(companyId, repo.id, baseRef);
  const integ = await integrate({ companyId, productId, repoId: repo.id, base: baseRef, branch, branches: [...new Set(verifiedBuilds.map((v) => v.branch))], actor });
  if (integ.conflict) throw new ApiError(`Merging ${integ.conflict} conflicts with other verified work. Resolve it in a follow-up task (nothing was released).`, 409);
  const c = { sha: integ.sha };
  const test = integ.test;
  const diff = await branchDiff(companyId, repo.id, repo.defaultBranch, branch);
  const content = { branch, sha: c.sha, base: repo.defaultBranch, integratedOnto: baseRef, baseSha: base, items: items.map((i) => i.key), test, diffStat: diff.stat, commits: diff.commits, notes: items.map((i) => `${i.key} ${i.title}`) };
  const a = await prisma.productArtifact.create({ data: { productId, companyId, kind: "RELEASE_CANDIDATE", version, title: `Release candidate ${version}`, content: JSON.stringify(content), status: "PROPOSED", source: "engine", producedBy: "devops" } });
  await prisma.gitOperation.create({ data: { repoId: repo.id, companyId, productId, op: "branch", branch, sha: c.sha, status: "SUCCEEDED", detail: `release candidate ${version}` } });
  await audit(companyId, actor, "RELEASE_CANDIDATE_CREATED", a.id, branch);
  const fresh = await loadProduct(companyId, productId);
  const moved = await movePhase(fresh, "RELEASE_READINESS", "devops", `Release candidate ${version} built on ${branch}`, [{ kind: "artifact", ref: a.id, detail: branch }]);
  const testOk = test?.mode === "docker" && test.failed === 0 && test.total > 0;
  const after = await readiness(companyId, productId); // re-evaluated now that the candidate exists
  await requestApproval(moved, {
    action: "release_candidate", actionClass: "local_commit", target: branch,
    summary: `Approve release candidate ${version} (${items.length} verified task(s))`,
    risks: [testOk ? `Integrated verification passed in the sandbox (${test!.passed}/${test!.total} tests)` : `Integrated verification did NOT pass (${test ? `${test.passed}/${test.total} tests, ${test.mode}` : "no test command"}) — approving would release failing code`, ...after.checks.filter((x) => x.status === "not_run").map((x) => `Not run: ${x.label}`)],
    evidence: [{ kind: "artifact", ref: a.id, detail: branch }, ...(c.sha ? [{ kind: "commit", ref: c.sha, detail: branch }] : [])],
    payload: { branch, sha: c.sha },
  });
  await productEvent(companyId, productId, `Release candidate ${version} ready for review on ${branch}${test ? ` — integrated tests ${test.passed}/${test.total} (${test.mode})` : ""}`, { actor: "devops", level: testOk ? "success" : "warning" });
  return { artifactId: a.id, branch, sha: c.sha, test };
}

/**
 * Decide a product approval. Approving re-checks the payload hash so a person
 * approves exactly what was proposed; side effects run only after approval.
 */
export async function decideProductApproval(companyId: string, productId: string, approvalId: string, actor: string, decision: "approve" | "reject", note = "", deps: { fetch?: typeof fetch } = {}) {
  const a = await loadPendingApproval(companyId, productId, approvalId);
  const p = await loadProduct(companyId, productId);
  if (decision === "reject") {
    await closeApproval(a, "REJECTED", actor, note);
    await audit(companyId, actor, "PRODUCT_APPROVAL_REJECTED", a.id, `${a.action} ${a.target}`);
    if (a.action === "release_candidate") await prisma.productArtifact.updateMany({ where: { productId, kind: "RELEASE_CANDIDATE", status: "PROPOSED" }, data: { status: "REVISION_REQUESTED" } });
    if (a.action === "deploy_production" || a.action === "deploy_preview") await (await import("@/lib/deploy/service")).onDeployApproval(companyId, a.id, "reject", actor);
    await productEvent(companyId, productId, `${a.action.replace(/_/g, " ")} rejected by ${actor}${note ? `: ${note}` : ""}`, { level: "warning" });
    return { status: "REJECTED" };
  }
  let result: Record<string, unknown> = {};
  if (a.action === "scope") {
    await prisma.product.update({ where: { id: p.id }, data: { scopeApproved: true, scopeApprovedBy: actor, scopeApprovedAt: new Date() } });
    await emitLearning({ companyId, type: "plan.approved", key: `plan.approved:${a.id}`, productId, payload: { approval: a.id, by: actor } });
  } else if (a.action === "release_candidate") {
    const rc = await prisma.productArtifact.findFirst({ where: { productId, kind: "RELEASE_CANDIDATE", status: "PROPOSED" }, orderBy: { version: "desc" } });
    if (!rc) throw new ApiError("Release candidate no longer available", 410);
    const c = parseJSON<{ branch: string; sha: string }>(rc.content, { branch: "", sha: "" });
    if (hashPayload({ branch: c.branch, sha: c.sha }) !== a.payloadHash) throw new ApiError("The release candidate changed after approval was requested; review it again", 409);
    await prisma.productArtifact.update({ where: { id: rc.id }, data: { status: "APPROVED" } });
    result = { branch: c.branch };
  } else if (a.action === "publish") {
    const repo = await repoOf(p);
    const cfg: RemoteConfig = { provider: repo.provider as RemoteConfig["provider"], name: repo.name, remoteUrl: repo.remoteUrl, credentialEnv: repo.credentialEnv };
    const rc = await prisma.productArtifact.findFirst({ where: { productId, kind: "RELEASE_CANDIDATE", status: "APPROVED" }, orderBy: { version: "desc" } });
    if (!rc) throw new ApiError("Approve a release candidate before publishing", 409);
    const c = parseJSON<{ branch: string; sha: string; notes: string[] }>(rc.content, { branch: "", sha: "", notes: [] });
    if (hashPayload({ publish: c.branch, sha: c.sha }) !== a.payloadHash) throw new ApiError("The branch changed after approval was requested; review it again", 409);
    try {
      const prBody = `Prepared by AURA.\n\n${c.notes.map((n) => `- ${n}`).join("\n")}\n\nEvery task above passed verification (tests, checks and review) in AURA's isolated sandbox before integration, and the integrated branch was verified again.`;
      if (repo.githubInstallationId) {
        const pr = await publishBranch(companyId, productId, c.branch, `${p.title}: release candidate ${rc.version}`, prBody);
        result = { url: pr.url, number: pr.number };
        await closeApproval(a, "APPROVED", actor, note);
        await audit(companyId, actor, "PRODUCT_APPROVAL_GRANTED", a.id, `${a.action} ${a.target}`);
        await productEvent(companyId, productId, `Pull request ${pr.created ? "opened" : "updated"}: ${pr.url}`, { level: "success" });
        return { status: "APPROVED", ...result };
      }
      await pushBranch(companyId, repo.id, c.branch, cfg);
      const pr = await openChangeRequest(cfg, { head: c.branch, base: repo.defaultBranch, title: `${p.title}: release candidate ${rc.version}`, body: `Prepared by AURA.\n\n${c.notes.map((n) => `- ${n}`).join("\n")}\n\nEvery task above was verified in AURA's sandbox before integration.` }, deps.fetch);
      await prisma.gitOperation.create({ data: { repoId: repo.id, companyId, productId, op: "pull_request", branch: c.branch, sha: c.sha, url: pr.url, status: "SUCCEEDED", detail: `${repo.provider} #${pr.number}${pr.created ? "" : " (already open)"}`, idempotencyKey: `pr:${repo.id}:${c.branch}` } }).catch(() => null);
      result = { url: pr.url, number: pr.number };
    } catch (e) {
      const status = e instanceof GitError ? e.status : 502;
      await prisma.gitOperation.create({ data: { repoId: repo.id, companyId, productId, op: "push", branch: c.branch, status: "FAILED", detail: (e as Error).message.slice(0, 500) } });
      await closeApproval(a, "CANCELLED", actor, `publication failed: ${(e as Error).message}`);
      throw new ApiError(`Publication failed: ${(e as Error).message}`, status);
    }
  } else if (a.action === "deploy_production" || a.action === "deploy_preview") {
    // Close the approval first so the release engineer's deploy.run tool call sees it APPROVED.
    await closeApproval(a, "APPROVED", actor, note);
    await audit(companyId, actor, "PRODUCT_APPROVAL_GRANTED", a.id, `${a.action} ${a.target}`);
    const { onDeployApproval } = await import("@/lib/deploy/service");
    const dep = await onDeployApproval(companyId, a.id, "approve", actor);
    await productEvent(companyId, productId, `${a.action.replace(/_/g, " ")} approved by ${actor}${dep ? "; deployment queued" : " (no pending deployment request — nothing deployed)"}`, { level: "success" });
    return { status: "APPROVED", deploymentId: dep?.id ?? null, queued: !!dep };
  }
  await closeApproval(a, "APPROVED", actor, note);
  await audit(companyId, actor, "PRODUCT_APPROVAL_GRANTED", a.id, `${a.action} ${a.target}`);
  await productEvent(companyId, productId, `${a.action.replace(/_/g, " ")} approved by ${actor}`, { level: "success" });
  return { status: "APPROVED", ...result };
}

/** Request publication of the approved release candidate to the connected remote. */
export async function requestPublish(companyId: string, productId: string) {
  const p = await loadProduct(companyId, productId);
  const repo = await repoOf(p);
  const rc = await prisma.productArtifact.findFirst({ where: { productId, kind: "RELEASE_CANDIDATE", status: "APPROVED" }, orderBy: { version: "desc" } });
  if (!rc) throw new ApiError("Approve a release candidate first", 409);
  await assertCanStart(companyId, "pull_request");
  const st = repo.githubInstallationId ? { configured: true, missing: [] as string[] } : remoteStatus({ provider: repo.provider as RemoteConfig["provider"], name: repo.name, remoteUrl: repo.remoteUrl, credentialEnv: repo.credentialEnv });
  if (repo.provider === "local" || !st.configured) throw new ApiError(`Publishing needs a connected GitHub or GitLab repository${st.missing.length ? ` (missing: ${st.missing.join(", ")})` : ""}`, 412);
  const c = parseJSON<{ branch: string; sha: string }>(rc.content, { branch: "", sha: "" });
  return requestApproval(p, { action: "publish", actionClass: "external_publication", target: `${repo.provider}:${repo.name}#${c.branch}`, summary: `Push ${c.branch} to ${repo.provider} ${repo.name} and open a ${repo.provider === "gitlab" ? "merge" : "pull"} request into ${repo.defaultBranch}`, risks: ["Publishes code outside AURA"], evidence: [{ kind: "artifact", ref: rc.id, detail: c.branch }], payload: { publish: c.branch, sha: c.sha } });
}

/** Production deployment request: always approval-gated; records what is missing to actually deploy. */
export async function requestDeployment(companyId: string, productId: string) {
  const p = await loadProduct(companyId, productId);
  await assertCanStart(companyId, "deploy_request");
  const rc = await prisma.productArtifact.findFirst({ where: { productId, kind: "RELEASE_CANDIDATE", status: "APPROVED" }, orderBy: { version: "desc" } });
  if (!rc) throw new ApiError("Approve a release candidate first", 409);
  const c = parseJSON<{ branch: string; sha: string }>(rc.content, { branch: "", sha: "" });
  const missing = ["deployment provider adapter for this product", "target environment credentials", "post-deployment health check URL"];
  const d = await prisma.productArtifact.create({ data: { productId, companyId, kind: "DEPLOYMENT", version: rc.version, title: `Production deployment request (RC ${rc.version})`, content: JSON.stringify({ environment: "production", commit: c.sha, branch: c.branch, status: "NOT_DEPLOYED", missing, logs: [], health: null, rollback: `keep previous production version; redeploy ${c.branch}'s base to roll back` }), status: "PROPOSED", source: "engine", producedBy: "devops" } });
  await requestApproval(p, { action: "deploy_production", actionClass: "production", target: `production@${c.sha?.slice(0, 8)}`, summary: `Deploy release candidate ${rc.version} to production`, risks: [`Cannot execute: ${missing.join(", ")} not configured`], evidence: [{ kind: "artifact", ref: d.id, detail: "deployment request" }], payload: { deploy: c.sha } });
  return { deploymentId: d.id, status: "NOT_DEPLOYED", missing };
}

/**
 * Roll back AURA's work on one task: revert AURA-authored commits on the
 * task branch as new commits (user commits on that branch are preserved; the
 * default branch is never touched), record the git operation, and reopen the
 * task — its earlier verification no longer describes the branch.
 * MEMBER+ for local branches (reversible); the route enforces the role.
 */
export async function rollbackItem(companyId: string, productId: string, key: string, actor: string, reason = "") {
  const p = await loadProduct(companyId, productId);
  const repo = await repoOf(p);
  const item = await prisma.backlogItem.findFirst({ where: { productId, companyId, key } });
  if (!item) throw new ApiError("Item not found", 404);
  if (item.status === "IN_PROGRESS") throw new ApiError("Cancel the running engineering run before rolling back", 409);
  const build = item.buildId ? await prisma.build.findFirst({ where: { id: item.buildId, companyId } }) : null;
  const branch = build?.branch ?? `aura/${key.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
  const rc = await prisma.productArtifact.findFirst({ where: { productId, companyId, kind: "RELEASE_CANDIDATE", status: { in: ["PROPOSED", "APPROVED"] } }, orderBy: { version: "desc" } });
  if (rc && parseJSON<{ items?: string[] }>(rc.content, {}).items?.includes(key)) throw new ApiError(`Release candidate ${rc.version} includes ${key}; reject it before rolling back`, 409);
  const r = await revertAuraCommits({ companyId, repoId: repo.id, base: repo.defaultBranch, branch, message: `Roll back AURA changes for ${key}${reason ? `: ${reason}` : ""} (requested by ${actor})` });
  if (r.status === "CONFLICT") {
    await prisma.gitOperation.create({ data: { repoId: repo.id, companyId, productId, itemKey: key, op: "rollback", branch, status: "FAILED", detail: `revert conflicts with later non-AURA changes; nothing was changed. ${r.detail ?? ""}`.slice(0, 500) } });
    throw new ApiError("Rolling back would conflict with later changes made by someone else on this branch; nothing was changed", 409);
  }
  await prisma.gitOperation.create({ data: { repoId: repo.id, companyId, productId, itemKey: key, op: "rollback", branch, sha: r.sha, status: "SUCCEEDED", detail: r.status === "REVERTED" ? `reverted ${r.reverted.length} AURA commit(s); kept ${r.kept.length} other commit(s)` : "no AURA commits to revert" } });
  if (r.status === "REVERTED") {
    if (["VERIFIED", "FAILED", "BLOCKED", "DONE_UNVERIFIED"].includes(item.status)) {
      await setItemStatus(item, "READY", { kind: "engine", id: "rollback" }, `rolled back by ${actor}; earlier verification no longer applies`, { verification: "NOT_RUN", buildId: null, attempts: 0, blockedReason: "" });
    }
    await markStale(companyId, productId, { files: r.files ?? [], reason: `${key} rolled back by ${actor}` });
  }
  await audit(companyId, actor, "PRODUCT_ITEM_ROLLBACK", `${productId}:${key}`, `${r.status} ${branch}`);
  await productEvent(companyId, productId, `${key} rolled back on ${branch} by ${actor}: ${r.status === "REVERTED" ? `${r.reverted.length} AURA commit(s) reverted, ${r.kept.length} other commit(s) kept` : "nothing to revert"}`, { level: "warning" });
  return { status: r.status, branch, sha: r.sha, reverted: r.reverted, kept: r.kept };
}
