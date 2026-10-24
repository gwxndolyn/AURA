import { z } from "zod";
import { ok, parseBody, handler } from "@/lib/api";
import { requireWorkspaceAccess } from "@/lib/auth/authz";
import { prisma } from "@/lib/db";
import { emitEvent } from "@/lib/events/emit";
import { PRIORITIES } from "@/lib/types";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "VIEWER");
  const tasks = await prisma.task.findMany({
    where: { companyId: id },
    orderBy: { createdAt: "desc" },
    include: { assignee: { select: { name: true, key: true, color: true, avatar: true } } },
  });
  return ok(tasks);
});

const CreateSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  assigneeKey: z.string().optional(),
  acceptance: z.array(z.string()).default([]),
  estimate: z.number().min(1).max(40).default(3),
});

export const POST = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireWorkspaceAccess(id, "MEMBER");
  const body = await parseBody(req, CreateSchema);
  const assignee = body.assigneeKey
    ? await prisma.agent.findUnique({ where: { companyId_key: { companyId: id, key: body.assigneeKey } } })
    : null;

  const task = await prisma.task.create({
    data: {
      companyId: id,
      title: body.title,
      description: body.description,
      priority: body.priority,
      estimate: body.estimate,
      assigneeId: assignee?.id,
      status: "PLANNED",
      acceptance: JSON.stringify(body.acceptance.map((text) => ({ text, met: false }))),
    },
  });
  await emitEvent({
    companyId: id,
    type: "TASK_CREATED",
    actor: assignee?.key,
    message: `Task created: ${task.title}`,
    meta: { taskId: task.id },
  });
  return ok(task, { status: 201 });
});
