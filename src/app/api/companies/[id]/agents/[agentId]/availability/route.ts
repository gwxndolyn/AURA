import { z } from "zod";
import { ok, err, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { setAgentAvailability, reassignFromUnavailable } from "@/lib/workflows/reassign";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; agentId: string }> };

const Schema = z.object({ available: z.boolean(), reassign: z.boolean().default(true) });

/** Toggle an agent's availability; optionally reassign its open work. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, agentId } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, Schema);
  const agent = await prisma.agent.findFirst({ where: { id: agentId, companyId: id } });
  if (!agent) return err("Agent not found", 404);

  await setAgentAvailability(id, agent.key, body.available);
  let reassigned = null;
  if (!body.available && body.reassign) {
    reassigned = await reassignFromUnavailable(id, agent.key);
  }
  return ok({ agentKey: agent.key, available: body.available, reassigned });
});
