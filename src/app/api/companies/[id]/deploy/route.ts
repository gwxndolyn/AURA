import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { runDeployment } from "@/lib/workflows/deploy";
import { requestDeploy } from "@/lib/workflows/approval";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({
  env: z.enum(["production", "staging", "development"]).default("production"),
  // Set false to bypass the human approval gate (e.g. internal automation/tests).
  gate: z.boolean().default(true),
});

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const deployments = await prisma.deployment.findMany({
    where: { companyId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return ok(deployments);
});

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const { env, gate } = await parseBody(req, Schema);
  // Production ships through the human approval gate by default; other envs ship directly.
  if (gate && env === "production") {
    const result = await requestDeploy(id, env);
    return ok(result);
  }
  const result = await runDeployment(id, env);
  return ok(result);
});
