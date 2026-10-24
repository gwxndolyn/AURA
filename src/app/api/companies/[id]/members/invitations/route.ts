import { z } from "zod";
import { ok, handler, parseBody } from "@/lib/api";
import { requirePermission } from "@/lib/auth/authz";
import { invite, INVITABLE_ROLES } from "@/lib/auth/members";
import { sendEmail } from "@/lib/email/send";
import { appOrigin } from "@/lib/auth/mail";
import { rateLimit } from "@/lib/auth/rateLimit";
import { ApiError } from "@/lib/api";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ email: z.string().email().max(200), role: z.enum(INVITABLE_ROLES).default("MEMBER") });

/** Invite someone by email (member.manage). Consumes a seat until accepted, revoked or expired. */
export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { user, role } = await requirePermission(id, "member.manage");
  if (!rateLimit(`invite:${id}`, 30, 60 * 60_000).ok) throw new ApiError("Too many invitations this hour", 429);
  const body = await parseBody(req, Schema);
  const r = await invite(id, { ...user, role }, body.email, body.role);
  const company = await prisma.company.findUnique({ where: { id }, select: { name: true } });
  const link = `${appOrigin(req)}/invite?token=${encodeURIComponent(r.rawToken)}`;
  const mail = await sendEmail(r.invitation.email, `You're invited to ${company?.name ?? "a workspace"} on AURA`, `${user.email} invited you to join ${company?.name ?? "their workspace"} on AURA as ${body.role.toLowerCase()}.\n\nAccept (valid 7 days; sign in or create an account with this email address):\n${link}`);
  return ok({ invitation: r.invitation, emailSent: mail.sent, ...(!mail.sent && process.env.NODE_ENV !== "production" ? { devLink: link } : {}) }, { status: 201 });
});
