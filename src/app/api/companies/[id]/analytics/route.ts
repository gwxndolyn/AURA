import { ok, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Time-series metrics + DORA-style aggregates. */
export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const url = new URL(req.url);
  const range = url.searchParams.get("range") ?? "30D";
  const days = { "24H": 1, "7D": 7, "30D": 30, "90D": 90 }[range] ?? 30;

  const metrics = await prisma.metric.findMany({
    where: { companyId: id },
    orderBy: { simDay: "asc" },
    take: days,
  });

  const [deployments, incidents, findings] = await Promise.all([
    prisma.deployment.findMany({ where: { companyId: id } }),
    prisma.incident.findMany({ where: { companyId: id } }),
    prisma.securityFinding.count({ where: { companyId: id } }),
  ]);

  const deploySuccess = deployments.filter((d) => d.status === "SUCCESS").length;
  const deployFail = deployments.filter((d) => d.status === "FAILED").length;
  // Only incidents with a valid resolution timestamp count toward MTTR; records
  // whose resolvedAt precedes detectedAt (e.g. imported history) are excluded.
  const resolvedIncidents = incidents.filter(
    (i) => i.status === "RESOLVED" && i.resolvedAt && i.resolvedAt.getTime() >= i.detectedAt.getTime(),
  );
  const mttrMs =
    resolvedIncidents.length > 0
      ? resolvedIncidents.reduce((s, i) => s + (i.resolvedAt!.getTime() - i.detectedAt.getTime()), 0) / resolvedIncidents.length
      : null;

  return ok({
    metrics,
    dora: {
      deploymentFrequency: deployments.length,
      changeFailureRate: deployments.length ? deployFail / deployments.length : 0,
      mttrMinutes: mttrMs === null ? null : Math.round(mttrMs / 60000),
      mttrSample: resolvedIncidents.length,
      deploySuccess,
      deployFail,
    },
    incidents: incidents.length,
    findings,
  });
});
