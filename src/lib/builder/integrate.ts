/**
 * Release integration: merge verified task branches onto the default branch in
 * a fresh working tree (real `git merge`, conflicts detected and refused), run
 * the full verification plan on the merged tree in the sandbox, and push the
 * result to `aura/release-<n>`. The default branch itself is never written.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { openTree, closeTree, git, listTree, readTreeFile } from "./workspace";
import { verificationPlan, parseTestSummary } from "./detect";
import { runInTree } from "./sandbox";
import { ApiError } from "@/lib/api";

export async function integrate(args: { companyId: string; productId: string; repoId: string; base: string; branch: string; branches: string[]; actor: string }) {
  // Commands of the integration run are recorded under a dedicated Build row (purpose: release).
  const b = await prisma.build.create({ data: { companyId: args.companyId, productId: args.productId, itemKey: "RELEASE", branch: args.branch, status: "RUNNING", phase: "verify", correlationId: randomUUID(), createdBy: args.actor, startedAt: new Date() } });
  const tree = await openTree(args.companyId, args.repoId, b.id, args.base, args.branch);
  try {
    for (const br of args.branches) {
      try {
        await git(tree.dir, ["merge", "--no-ff", "--quiet", "-m", `Merge ${br}`, `origin/${br}`]);
      } catch {
        await git(tree.dir, ["merge", "--abort"]).catch(() => null);
        await prisma.build.update({ where: { id: b.id }, data: { status: "FAILED", phase: "done", failure: `merge conflict: ${br}`, finishedAt: new Date() } });
        return { conflict: br, sha: null, test: null, buildId: b.id };
      }
    }
    const files: Record<string, string> = {};
    for (const f of await listTree(tree)) if (/(^|\/)(package(-lock)?\.json|tsconfig\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f)) files[f] = (await readTreeFile(tree, f)) ?? "";
    const plan = verificationPlan(files);
    let test: { mode: string; passed: number; failed: number; total: number; output: string } | null = null;
    let allOk = plan.checks.length > 0;
    for (const c of plan.checks) {
      const r = await runInTree({ buildId: b.id, companyId: args.companyId, tree, command: c.command, purpose: c.id, actor: "engine", network: c.network });
      if (!r.ok) allOk = false;
      if (c.id === "test") {
        const t = parseTestSummary(r.output);
        test = { mode: "docker", passed: t.pass ?? (r.ok ? 1 : 0), failed: t.fail ?? (r.ok ? 0 : 1), total: t.tests ?? 1, output: r.output.slice(-4000) };
        if (!r.ok && test.failed === 0) test.failed = 1;
      }
      if (c.id === "install" && !r.ok) break;
    }
    await git(tree.dir, ["push", "--quiet", "--force-with-lease", "origin", `HEAD:refs/heads/${args.branch}`]).catch(async () => git(tree.dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${args.branch}`]));
    const sha = await git(tree.dir, ["rev-parse", "HEAD"]);
    await prisma.build.update({ where: { id: b.id }, data: { status: allOk ? "VERIFIED" : "FAILED", phase: "done", headSha: sha, finishedAt: new Date(), summary: plan.checks.map((c) => c.command).join("; ") } });
    return { conflict: null, sha, test, buildId: b.id };
  } catch (e) {
    await prisma.build.update({ where: { id: b.id }, data: { status: "BLOCKED", phase: "done", failure: (e as Error).message.slice(0, 1000), finishedAt: new Date() } });
    if (e instanceof ApiError) throw e;
    throw new ApiError(`Integration failed: ${(e as Error).message}`, 502);
  } finally {
    await closeTree(tree).catch(() => null);
  }
}
