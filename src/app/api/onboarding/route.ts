import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireUser, requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";
import { parseOnboarding, TOUR_STEP_IDS, TOUR_STEPS } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const { userId } = await requireUser();
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { onboarding: true } });
  return ok(parseOnboarding(u?.onboarding));
});

const Schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("step"), step: z.enum(TOUR_STEP_IDS), companyId: z.string().max(40).optional() }),
  z.object({ action: z.literal("intro-seen"), companyId: z.string().max(40).optional() }),
  z.object({ action: z.literal("skip"), companyId: z.string().max(40).optional() }),
  z.object({ action: z.literal("restart"), companyId: z.string().max(40).optional() }),
]);

/**
 * Update tour progress. Usage signal is recorded as an audit entry with the
 * step id only — never mission content — and only in a workspace the user
 * can access.
 */
export const POST = handler(async (req) => {
  const { userId } = await requireUser();
  const body = await parseBody(req, Schema);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { onboarding: true } });
  const s = parseOnboarding(u?.onboarding);
  const now = new Date().toISOString();
  if (body.action === "step" && !s.steps.includes(body.step)) s.steps.push(body.step);
  if (body.action === "intro-seen") s.introSeenAt ??= now;
  if (body.action === "skip") s.skippedAt = now;
  if (body.action === "restart") Object.assign(s, { steps: [], skippedAt: undefined, completedAt: undefined, introSeenAt: undefined });
  if (s.steps.length === TOUR_STEPS.length) s.completedAt ??= now;
  await prisma.user.update({ where: { id: userId }, data: { onboarding: JSON.stringify(s) } });
  // Usage signal only when progress actually changed (not on every page view), so the audit trail is not
  // flooded with repeats; actor is the user's email like every other audit entry.
  const changed = JSON.stringify(s) !== JSON.stringify(parseOnboarding(u?.onboarding));
  if (body.companyId && changed) {
    const { user } = await requireWorkspaceAccess(body.companyId, "VIEWER");
    await audit(body.companyId, user.email, "TOUR_PROGRESS", body.action === "step" ? body.step : body.action, "ok");
  }
  return ok(s);
});
