import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { emitEvent } from "@/lib/events/emit";
import { runAttackDefense } from "@/lib/workflows/security";
import { seededRandom } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ kind: z.string().optional() });

const INCIDENTS = ["traffic-spike", "db-slowdown", "api-failure", "bad-deploy", "security-finding"] as const;

/** Chaos mode: generate a safe simulated incident; agents respond. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema).catch(() => ({ kind: undefined }));
  const rnd = seededRandom(Date.now());
  const kind = (body.kind as (typeof INCIDENTS)[number]) ?? INCIDENTS[Math.floor(rnd() * INCIDENTS.length)];

  if (kind === "security-finding") {
    const result = await runAttackDefense(id);
    return ok({ kind, incident: result });
  }

  // Infra-affecting chaos: degrade a random node, emit events, auto-recover a bit.
  const nodes = await prisma.infrastructureNode.findMany({ where: { companyId: id } });
  if (nodes.length) {
    const node = nodes[Math.floor(rnd() * nodes.length)];
    await prisma.infrastructureNode.update({
      where: { id: node.id },
      data: {
        status: "DEGRADED",
        cpu: Math.min(99, node.cpu + 40),
        latencyMs: node.latencyMs + 200,
        errorRate: node.errorRate + 5,
      },
    });
    await emitEvent({
      companyId: id,
      type: "INCIDENT_CREATED",
      actor: "devops",
      level: "warning",
      message: `Chaos: ${kind.replace(/-/g, " ")} on ${node.label}`,
      meta: { kind, nodeKey: node.key },
    });
    // Forge responds.
    await emitEvent({
      companyId: id,
      type: "AGENT_COMPLETED",
      actor: "devops",
      level: "success",
      message: `Forge mitigated ${kind.replace(/-/g, " ")} on ${node.label}`,
    });
    await prisma.infrastructureNode.update({
      where: { id: node.id },
      data: { status: "HEALTHY" },
    });
  }

  return ok({ kind });
});
