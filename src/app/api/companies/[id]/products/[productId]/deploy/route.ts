import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { upsertTarget, listTargets, preflight, requestProductDeploy, requestRollback, deploymentHistory, ENVS } from "@/lib/deploy/service";
import { PROVIDERS } from "@/lib/deploy/providers";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; productId: string }> };

/** Targets (with connection status), available providers, preflight per env, deployment history. */
export const GET = handler(async (_req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const targets = await listTargets(id, productId);
  const pre = Object.fromEntries(await Promise.all(ENVS.map(async (e) => [e, targets.some((t) => t.env === e) ? (await preflight(id, productId, e)).checks : null])));
  return ok({ providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, supportsRollback: p.supportsRollback })), targets, preflight: pre, history: await deploymentHistory(id, productId) });
});

const Target = z.object({
  action: z.literal("target"), env: z.enum(ENVS), provider: z.string().max(40),
  config: z.object({ port: z.number().int().optional(), bindAddress: z.enum(["127.0.0.1", "0.0.0.0"]).optional(), publicHost: z.string().regex(/^[a-z0-9.-]{1,120}$/i).optional(), healthPath: z.string().regex(/^\/[\w./-]{0,100}$/).optional(), journeys: z.array(z.object({ path: z.string().regex(/^\/[\w./?=&-]{0,200}$/), expectStatus: z.number().int().optional(), expectText: z.string().max(200).optional() })).max(10).optional(), env: z.record(z.string().max(500)).optional(), memory: z.string().regex(/^\d+[mg]$/).optional(), cpus: z.string().regex(/^\d+(\.\d+)?$/).optional() }).strict(),
  secretEnvNames: z.array(z.string().max(64)).max(20).default([]), autoDeploy: z.boolean().default(false),
});
const Action = z.union([Target, z.object({ action: z.literal("deploy"), env: z.enum(ENVS) }), z.object({ action: z.literal("rollback"), env: z.enum(ENVS) })]);

/**
 * target (ADMIN: infrastructure configuration) · deploy / rollback (MEMBER may REQUEST; the deployment itself
 * runs only after an ADMIN approves it — or, for preview with autoDeploy under BOUNDED autonomy, by policy).
 */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id, productId } = await ctx.params;
  const b = await parseBody(req, Action);
  const { user } = await requireWorkspaceAccess(id, b.action === "target" ? "ADMIN" : "MEMBER");
  if (b.action === "target") return ok(await upsertTarget({ companyId: id, productId, env: b.env, provider: b.provider, config: b.config, secretEnvNames: b.secretEnvNames, autoDeploy: b.autoDeploy, actor: user.email }));
  if (b.action === "deploy") return ok(await requestProductDeploy(id, productId, b.env, user.email), { status: 202 });
  return ok(await requestRollback(id, productId, b.env, user.email), { status: 202 });
});
