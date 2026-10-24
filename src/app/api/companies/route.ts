import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { requireUser, accessibleCompanyIds } from "@/lib/auth/authz";
import { AUTONOMY_LEVELS } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  // Only return workspaces the authenticated user owns or belongs to.
  const user = await requireUser();
  const ids = await accessibleCompanyIds(user.userId);
  const companies = await prisma.company.findMany({
    where: { id: { in: ids } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      mission: true,
      industry: true,
      status: true,
      isDemo: true,
      customers: true,
      revenue: true,
      createdAt: true,
    },
  });
  return ok(companies);
});

const CreateSchema = z.object({
  name: z.string().min(1).max(60),
  mission: z.string().min(1).max(300),
  industry: z.string().min(1).max(60),
  personality: z.string().max(60).optional(),
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
  cash: z.number().min(0).max(1_000_000_000).optional(),
});

export const POST = handler(async (req) => {
  const user = await requireUser();
  const body = await parseBody(req, CreateSchema);
  const company = await createCompany({ ...body, ownerId: user.userId });
  return ok(company, { status: 201 });
});
