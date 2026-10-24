/**
 * The branch new work starts from. AURA never writes the default branch
 * (people merge pull requests there), so after a release candidate is
 * APPROVED, follow-up work must build on that release — otherwise a change
 * request would start from code that lacks the already-verified features.
 *
 *   integration base = latest APPROVED release candidate branch, if it still
 *                      exists in the repository; else the default branch
 */
import { prisma } from "@/lib/db";
import { parseJSON } from "@/lib/utils";
import { headSha } from "./git";

export async function integrationBase(companyId: string, productId: string, repo: { id: string; defaultBranch: string }) {
  const rc = await prisma.productArtifact.findFirst({ where: { productId, companyId, kind: "RELEASE_CANDIDATE", status: "APPROVED" }, orderBy: { version: "desc" } });
  const branch = rc ? parseJSON<{ branch?: string }>(rc.content, {}).branch : undefined;
  if (branch && (await headSha(companyId, repo.id, branch))) return { branch, source: `release candidate ${rc!.version}` };
  return { branch: repo.defaultBranch, source: "default branch" };
}
