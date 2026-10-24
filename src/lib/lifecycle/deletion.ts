/**
 * Customer data deletion. What is removed, and what is NOT (documented in
 * docs/security/data-lifecycle.md — never claim more than this):
 *
 * Removed immediately: the workspace row and every tenant-scoped row (cascade:
 * products, backlog, artifacts, builds + command output, agent runs, memory,
 * usage ledger, audit log, secrets, invitations, integrations metadata,
 * deployments records), the product git repositories and build working trees
 * on disk, and running preview/production containers AURA started for the
 * workspace's products (best effort; failures are reported).
 *
 * Not removed by AURA: database/disk backups (expire on the operator's backup
 * rotation), copies held by third parties (GitHub repositories the customer
 * pushed to; Stripe's customer and invoice records, which Stripe retains for
 * legal/tax reasons; the email provider's delivery logs), stdout logs already
 * shipped to the operator's log store (they never contain secret values), and
 * BillingEvent rows (provider event ids + type, retained for payment
 * reconciliation; they reference the workspace id only).
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { gitRoot } from "@/lib/factory/git";
import { workRoot } from "@/lib/builder/workspace";
import { providerOf } from "@/lib/deploy/providers";
import { killSandbox } from "@/lib/sandbox/docker";
import { log } from "@/lib/observability/log";

const SAFE = /^[a-zA-Z0-9_-]{1,64}$/;

export const RETAINED_ELSEWHERE = [
  "Database and disk backups until they expire on the operator's backup rotation",
  "Repositories you pushed to GitHub (delete them in GitHub)",
  "Payment records held by Stripe (customer, invoices) as required for tax and accounting",
  "Delivery logs held by the email provider",
  "Payment webhook receipts (event id and type only) kept for billing reconciliation",
];

/** Refuse while money is still being charged: paid subscriptions must be cancelled first. */
export async function assertNoActivePaidPlan(companyIds: string[]) {
  if (!companyIds.length) return;
  const paid = await prisma.subscription.findFirst({ where: { companyId: { in: companyIds }, plan: { not: "free" }, status: { in: ["active", "trialing", "past_due"] }, cancelAtPeriodEnd: false } });
  if (paid) throw new ApiError("Cancel the paid subscription first (Settings → Billing). Deletion is available once it no longer renews.", 409);
}

/** Delete one workspace and everything AURA stores for it. Returns what was removed and what could not be. */
export async function deleteWorkspaceData(companyId: string) {
  if (!SAFE.test(companyId)) throw new ApiError("invalid id", 422);
  const problems: string[] = [];
  // 1. Stop execution: cancel queued/running jobs and kill sandbox containers so nothing writes after deletion.
  const builds = await prisma.build.findMany({ where: { companyId, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true, container: true } });
  for (const b of builds) if (b.container) await killSandbox(b.container).catch(() => problems.push(`could not stop sandbox ${b.container}`));
  await prisma.job.updateMany({ where: { companyId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", finishedAt: new Date(), lastError: "workspace deleted" } });
  // 2. Stop deployed apps (they would otherwise keep running with this tenant's code and secrets).
  const targets = await prisma.deployTarget.findMany({ where: { companyId }, select: { productId: true, env: true, provider: true } });
  for (const t of targets) {
    try {
      await providerOf(t.provider).stopEnv(t.productId, t.env);
    } catch (e) {
      problems.push(`could not stop ${t.env} deployment of product ${t.productId}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  // 3. Rows (cascade from Company), then files.
  await prisma.company.delete({ where: { id: companyId } });
  for (const dir of [join(gitRoot(), companyId), join(workRoot(), companyId)]) {
    await rm(dir, { recursive: true, force: true }).catch((e) => problems.push(`could not remove ${dir.includes("git") ? "repositories" : "working trees"}: ${(e as Error).message.slice(0, 120)}`));
  }
  log(problems.length ? "warn" : "info", "workspace.deleted", { companyId, problems });
  return { deleted: true, stoppedRuns: builds.length, stoppedDeployments: targets.length, problems, retainedElsewhere: RETAINED_ELSEWHERE };
}
