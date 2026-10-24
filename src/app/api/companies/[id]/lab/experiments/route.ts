import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { assertFeature } from "@/lib/billing/entitlements";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { proposeExperiment } from "@/lib/lab/lab";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Rule = z.object({ metric: z.string().regex(/^[a-zA-Z]+\.[a-zA-Z]+$/), op: z.enum([">=", "<=", ">", "<", "delta>=", "delta<="]), value: z.number(), split: z.enum(["train", "heldout", "all"]) });
const Proposal = z.object({
  key: z.string().regex(/^[a-z0-9:-]{2,60}$/), title: z.string().min(3).max(200), problem: z.string().min(10).max(2000),
  evidence: z.array(z.object({ kind: z.string().max(40), ref: z.string().max(120), detail: z.string().max(500) })).min(1).max(20),
  hypothesis: z.string().min(10).max(2000), success: z.array(Rule).min(1).max(10), regression: z.array(Rule).max(10),
  procedure: z.string().max(2000), rejectIf: z.string().max(1000), baselineConfig: z.string().max(120), candidateConfig: z.string().max(120),
  codeChange: z.string().max(2000).optional(), force: z.string().max(500).optional(),
});

/** Propose an experiment on AURA's engineering methods (ADMIN). */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireWorkspaceAccess(id, "ADMIN");
  await assertFeature(id, "advanced_agents");
  const b = await parseBody(req, Proposal);
  return ok(await proposeExperiment({ ...b, companyId: id, actor: user.email }), { status: 201 });
});
