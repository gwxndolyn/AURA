import { z } from "zod";
import { ok, handler, parseBody, ApiError } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { REPOS } from "@/lib/missions/repos";
import { loadProduct } from "@/lib/factory/store";
import { branchDiff, listBranches, detectProject, remoteStatus } from "@/lib/factory/git";
import { TRIGGER_EVENTS, TRIGGER_MODES } from "@/lib/factory/webhooks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Repository state: branches, AURA git operations, detected project metadata, diff of a branch vs base. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const p = await loadProduct(id, productId);
  if (!p.repoId) throw new ApiError("Product has no repository", 404);
  const repo = await prisma.repoConnection.findFirst({ where: { id: p.repoId, companyId: id } });
  if (!repo) throw new ApiError("Repository not found", 404);
  const branch = new URL(req.url).searchParams.get("branch");
  const branches = await listBranches(id, repo.id).catch(() => []);
  const diff = branch && branches.some((b) => b.name === branch) ? await branchDiff(id, repo.id, repo.defaultBranch, branch) : null;
  const detected = p.template ? detectProject(REPOS[p.template].files) : null;
  return ok({ provider: repo.provider, name: repo.name, defaultBranch: repo.defaultBranch, branches, diff, detected, status: remoteStatus({ provider: repo.provider as "local", name: repo.name, remoteUrl: repo.remoteUrl, credentialEnv: repo.credentialEnv }) });
});

const ENV = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, "must be an environment variable NAME (e.g. GITHUB_TOKEN), never the token itself");
const Connect = z.object({
  provider: z.enum(["github", "gitlab"]),
  name: z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/, "owner/repo or group/project"),
  remoteUrl: z.string().url().refine((u) => u.startsWith("https://"), "https URL required"),
  defaultBranch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/).default("main"),
  credentialEnv: ENV,
  webhookEnv: ENV.optional(),
  triggers: z.record(z.enum(TRIGGER_EVENTS), z.enum(TRIGGER_MODES)).optional(),
});

/**
 * Connect the product to GitHub/GitLab for publication. ADMIN+. The secret
 * values stay in server environment variables; only their NAMES are stored.
 * AURA's local repository remains the working repository.
 */
export const PUT = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  const p = await loadProduct(id, productId);
  if (!p.repoId) throw new ApiError("Product has no repository", 409);
  const b = await parseBody(req, Connect);
  const repo = await prisma.repoConnection.update({ where: { id: p.repoId }, data: { provider: b.provider, name: b.name, remoteUrl: b.remoteUrl, credentialEnv: b.credentialEnv, webhookEnv: b.webhookEnv ?? null, triggers: JSON.stringify(b.triggers ?? {}) } }).catch((e: { code?: string }) => {
    if (e.code === "P2002") throw new ApiError("That repository is already connected in this workspace", 409);
    throw e;
  });
  await audit(id, user.email, "REPO_CONNECTED", repo.id, `${b.provider}:${b.name}`);
  return ok({ provider: repo.provider, name: repo.name, status: remoteStatus({ provider: b.provider, name: b.name, remoteUrl: b.remoteUrl, credentialEnv: b.credentialEnv }) });
});
