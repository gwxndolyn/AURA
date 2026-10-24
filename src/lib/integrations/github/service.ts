/**
 * GitHub workflow for a workspace, on top of the App client:
 *   connect (installation callback, state-checked) → list repos → link a
 *   product to a repo (import its default branch as the working repo, or
 *   publish AURA's repo to an empty one) → open a PR for a verified branch
 *   (approval-gated, ADMIN) → PR status → disconnect.
 * Plan entitlements are checked server-side.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/events/emit";
import { log } from "@/lib/observability/log";
import { assertCanStart } from "@/lib/billing/entitlements";
import { importRemote, pushWithToken } from "@/lib/factory/git";
import { loadProduct } from "@/lib/factory/store";
import { githubAppConfigured, installationAccount, installationToken, listInstallationRepos, openPullRequest, pullRequestStatus } from "./app";

const stateSecret = () => process.env.AUTH_SECRET || "aura-dev-insecure-secret-change-me";

/** Signed state binds the install callback to the workspace and user that started it. */
export function installState(companyId: string, userId: string, now = Date.now()) {
  const payload = `${companyId}.${userId}.${now}`;
  return `${Buffer.from(payload).toString("base64url")}.${createHmac("sha256", stateSecret()).update(payload).digest("base64url")}`;
}

export function verifyInstallState(state: string, maxAgeMs = 30 * 60_000) {
  const [p, sig] = state.split(".");
  if (!p || !sig) return null;
  const payload = Buffer.from(p, "base64url").toString();
  const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const [companyId, userId, ts] = payload.split(".");
  if (Date.now() - Number(ts) > maxAgeMs) return null;
  return { companyId, userId };
}

export async function connectInstallation(companyId: string, actor: string, installationId: number) {
  await assertCanStart(companyId, "github");
  const account = await installationAccount(installationId); // proves the installation exists and the App can see it
  const row = await prisma.githubInstallation.upsert({ where: { companyId_installationId: { companyId, installationId } }, create: { companyId, installationId, account, connectedBy: actor }, update: { status: "ACTIVE", account } });
  await audit(companyId, actor, "GITHUB_CONNECTED", String(installationId), account);
  return row;
}

async function activeInstallation(companyId: string) {
  const i = await prisma.githubInstallation.findFirst({ where: { companyId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  if (!i) throw new ApiError("GitHub is not connected for this workspace", 412);
  return i;
}

export async function githubStatus(companyId: string) {
  const cfg = githubAppConfigured();
  const installs = await prisma.githubInstallation.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
  return { ...cfg, installations: installs.map((i) => ({ id: i.id, installationId: i.installationId, account: i.account, status: i.status, connectedBy: i.connectedBy, createdAt: i.createdAt })) };
}

export async function repos(companyId: string) {
  const i = await activeInstallation(companyId);
  try {
    return await listInstallationRepos(i.installationId);
  } catch (e) {
    if ((e as { kind?: string }).kind === "auth") await prisma.githubInstallation.update({ where: { id: i.id }, data: { status: "REVOKED" } });
    throw e;
  }
}

/**
 * Link a product to a GitHub repository. mode=import: the repo's default branch
 * becomes the product's working repository (new products only). mode=publish:
 * AURA's existing repo stays the working copy; verified branches are pushed there.
 */
export async function linkRepo(companyId: string, productId: string, actor: string, args: { fullName: string; mode: "import" | "publish" }) {
  await assertCanStart(companyId, "github");
  const p = await loadProduct(companyId, productId);
  const i = await activeInstallation(companyId);
  const list = await listInstallationRepos(i.installationId);
  const r = list.find((x) => x.fullName === args.fullName);
  if (!r) throw new ApiError("That repository is not accessible to the connected GitHub installation", 404);
  if (!p.repoId) throw new ApiError("Product has no repository", 409);
  const conn = await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId } });
  if (!conn) throw new ApiError("Repository connection missing", 404);
  if (args.mode === "import") {
    if (await prisma.build.count({ where: { productId } })) throw new ApiError("Import is only possible before any engineering run; use publish instead", 409);
    // Replace the starter repo with the imported one.
    const fresh = await prisma.repoConnection.create({ data: { companyId, provider: "local", name: `product-${productId}-import-${Date.now()}`, defaultBranch: r.defaultBranch } });
    const token = await installationToken(i.installationId);
    const imp = await importRemote(companyId, fresh.id, r.cloneUrl, r.defaultBranch, token);
    await prisma.repoConnection.update({ where: { id: fresh.id }, data: { provider: "github", name: r.fullName, remoteUrl: r.cloneUrl, githubInstallationId: i.id } });
    await prisma.product.update({ where: { id: productId }, data: { repoId: fresh.id, stack: "imported" } });
    await prisma.gitOperation.create({ data: { repoId: fresh.id, companyId, productId, op: "import", branch: r.defaultBranch, sha: imp.sha, status: "SUCCEEDED", detail: `imported ${r.fullName}` } });
  } else {
    await prisma.repoConnection.update({ where: { id: conn.id }, data: { provider: "github", name: r.fullName, remoteUrl: r.cloneUrl, githubInstallationId: i.id } }).catch((e: { code?: string }) => {
      if (e.code === "P2002") throw new ApiError("That repository is already linked to another product in this workspace", 409);
      throw e;
    });
  }
  await audit(companyId, actor, "GITHUB_REPO_LINKED", productId, `${args.mode} ${r.fullName}`);
  return { fullName: r.fullName, mode: args.mode, defaultBranch: r.defaultBranch };
}

/** Push a verified branch and open (or reuse) a PR. Called only after an approved `publish` approval. */
export async function publishBranch(companyId: string, productId: string, branch: string, title: string, body: string) {
  await assertCanStart(companyId, "pull_request");
  const p = await loadProduct(companyId, productId);
  const conn = p.repoId ? await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId } }) : null;
  if (!conn || conn.provider !== "github" || !conn.remoteUrl || !conn.githubInstallationId) throw new ApiError("Link this product to a GitHub repository first", 412);
  const inst = await prisma.githubInstallation.findFirst({ where: { id: conn.githubInstallationId, companyId, status: "ACTIVE" } });
  if (!inst) throw new ApiError("The GitHub installation for this repository is disconnected or revoked", 412);
  const token = await installationToken(inst.installationId);
  await pushWithToken(companyId, conn.id, branch, conn.remoteUrl, token);
  const pr = await openPullRequest(inst.installationId, conn.name, { head: branch, base: conn.defaultBranch, title, body });
  const idem = `pr:${conn.id}:${branch}:${pr.number}`;
  if (!(await prisma.gitOperation.findFirst({ where: { companyId, idempotencyKey: idem } }))) await prisma.gitOperation.create({ data: { repoId: conn.id, companyId, productId, op: "pull_request", branch, url: pr.url, status: "SUCCEEDED", detail: `#${pr.number}${pr.created ? "" : " (already open)"}`, idempotencyKey: idem } });
  log("info", "github.pr", { companyId, productId, repo: conn.name, branch, number: pr.number, created: pr.created });
  return pr;
}

export async function prStatus(companyId: string, productId: string, number: number) {
  const p = await loadProduct(companyId, productId);
  const conn = p.repoId ? await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId } }) : null;
  if (!conn?.githubInstallationId) throw new ApiError("Not linked to GitHub", 412);
  const inst = await prisma.githubInstallation.findFirst({ where: { id: conn.githubInstallationId, companyId } });
  if (!inst) throw new ApiError("GitHub installation missing", 412);
  return pullRequestStatus(inst.installationId, conn.name, number);
}

export async function disconnect(companyId: string, actor: string, id: string) {
  const i = await prisma.githubInstallation.findFirst({ where: { id, companyId } });
  if (!i) throw new ApiError("Installation not found", 404);
  await prisma.githubInstallation.update({ where: { id: i.id }, data: { status: "REVOKED" } });
  await audit(companyId, actor, "GITHUB_DISCONNECTED", String(i.installationId), i.account);
  return { status: "REVOKED", note: "AURA will no longer use this installation. To remove AURA's access entirely, uninstall the App in your GitHub settings." };
}
