/**
 * Retention: per workspace, run output older than Company.retentionDays is
 * purged — command output (CommandRun.output), deployment logs, agent-run
 * summaries and tool-call payloads. The records themselves (that a run
 * happened, its status, cost and usage) are kept for billing and audit.
 * Also: expired revoked-session rows, used/expired one-time tokens, and
 * orphaned build working trees on disk.
 *
 * Runs from the worker's maintenance tick (src/lib/jobs/worker.ts) and can be
 * triggered with `npm run maintenance`.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { workRoot } from "@/lib/builder/workspace";
import { purgeExpiredRevocations } from "@/lib/auth/session";
import { recoverReservations } from "@/lib/billing/entitlements";
import { log } from "@/lib/observability/log";
import { processPending } from "@/lib/learning/service";

export async function purgeWorkspaceOutput(companyId: string, retentionDays: number, now = new Date()) {
  const before = new Date(now.getTime() - retentionDays * 86400_000);
  const cmd = await prisma.commandRun.updateMany({ where: { companyId, createdAt: { lt: before }, NOT: { output: "" } }, data: { output: "", truncated: true } });
  const dep = await prisma.productDeployment.updateMany({ where: { companyId, createdAt: { lt: before }, NOT: { logs: "" } }, data: { logs: "" } });
  const runs = await prisma.agentRun.findMany({ where: { companyId, createdAt: { lt: before } }, select: { id: true }, take: 5000 });
  const tools = runs.length ? await prisma.toolCall.updateMany({ where: { runId: { in: runs.map((r) => r.id) }, NOT: { output: "{}" } }, data: { input: "{}", output: "{}" } }) : { count: 0 };
  return { commandOutputs: cmd.count, deploymentLogs: dep.count, toolPayloads: tools.count };
}

/** Remove build working trees that no running build owns (crash leftovers). */
export async function cleanOrphanTrees(maxAgeMs = 6 * 3600_000) {
  let removed = 0;
  const root = workRoot();
  const companies = await readdir(root).catch(() => [] as string[]);
  for (const c of companies) {
    const builds = await readdir(join(root, c)).catch(() => [] as string[]);
    for (const b of builds) {
      const dir = join(root, c, b);
      const st = await stat(dir).catch(() => null);
      if (!st || Date.now() - st.mtimeMs < maxAgeMs) continue;
      const live = await prisma.build.findFirst({ where: { id: b, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
      if (live) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => null);
      removed++;
    }
  }
  return removed;
}

export async function runMaintenance(now = new Date()) {
  const out: Record<string, unknown> = {};
  const companies = await prisma.company.findMany({ select: { id: true, retentionDays: true } });
  let purged = 0;
  for (const c of companies) {
    const r = await purgeWorkspaceOutput(c.id, c.retentionDays, now);
    purged += r.commandOutputs + r.deploymentLogs + r.toolPayloads;
  }
  out.purgedRecords = purged;
  out.revokedSessionsPurged = await purgeExpiredRevocations(now);
  out.tokensPurged = (await prisma.passwordResetToken.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: new Date(now.getTime() - 86400_000) } }] } })).count;
  out.reservationsReleased = await recoverReservations(now);
  out.orphanTreesRemoved = await cleanOrphanTrees();
  // Learning runs in the background: delivery never waits for it, and a failure here only delays insights.
  out.learningEventsProcessed = await processPending(500).catch(() => 0);
  log("info", "maintenance.done", out);
  return out;
}
