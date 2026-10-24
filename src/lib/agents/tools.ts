import { prisma } from "@/lib/db";
import { isAllowed } from "./permissions";
import { audit } from "@/lib/events/emit";
import { specFor, inScope } from "./toolSpecs";

/**
 * Central tool runner. Every agent tool call goes through here so we can:
 *  - enforce per-role permissions (unauthorized calls are blocked + audited)
 *  - validate arguments and results against the tool spec (toolSpecs.ts)
 *  - enforce write/read scope, timeouts and approval requirements
 *  - produce a ToolCall audit record (agent, tool, args, result, status, duration)
 *
 * `runId` ties the call to an AgentRun. Returns the tool's output or throws a
 * typed error. Enforcement never depends on what the model was told.
 */

export class PermissionError extends Error {
  constructor(public agentKey: string, public tool: string) {
    super(`Agent "${agentKey}" is not permitted to use tool "${tool}"`);
    this.name = "PermissionError";
  }
}

export type ToolErrorCode = "invalid_args" | "timeout" | "error" | "invalid_output" | "approval_required" | "out_of_scope";

/** Classified tool failure. `category` maps onto the failure taxonomy. */
export class ToolError extends Error {
  constructor(public tool: string, public code: ToolErrorCode, message: string) {
    super(`${tool}: ${message}`);
    this.name = "ToolError";
  }
  get category() {
    return (
      {
        invalid_args: "tool_argument_error",
        timeout: "tool_timeout",
        error: "tool_execution_error",
        invalid_output: "invalid_tool_output",
        approval_required: "authorization_denied",
        out_of_scope: "authorization_denied",
      } as const
    )[this.code];
  }
}

export interface ToolContext {
  companyId: string;
  agentKey: string;
  runId?: string;
  /** Paths this call may write (task write scope). Required for tools with a write path. */
  writeScope?: string[];
  /** Paths this call may read. Omit to allow any workspace path. */
  readScope?: string[];
  /** Id of an APPROVED approval, required for consequential tools. */
  approvalId?: string;
  /** Override the spec timeout (tests). */
  timeoutMs?: number;
}

async function record(ctx: ToolContext, tool: string, args: unknown, output: unknown, status: string, durationMs: number) {
  if (ctx.runId) {
    await prisma.toolCall.create({
      data: {
        runId: ctx.runId,
        tool,
        input: JSON.stringify(args ?? {}).slice(0, 4000),
        output: JSON.stringify(output ?? {}).slice(0, 4000),
        ok: status === "ok",
        status,
        durationMs,
      },
    });
  }
  await audit(ctx.companyId, ctx.agentKey, status === "denied" ? "TOOL_DENIED" : "TOOL_CALL", tool, `${status} ${durationMs}ms`);
}

export async function callTool<T>(ctx: ToolContext, tool: string, args: Record<string, unknown>, impl: () => Promise<T>): Promise<T> {
  const start = Date.now();

  if (!isAllowed(ctx.agentKey, tool)) {
    await record(ctx, tool, args, { error: "permission denied" }, "denied", 0);
    throw new PermissionError(ctx.agentKey, tool);
  }

  const spec = specFor(tool);
  const fail = async (code: ToolErrorCode, message: string, output: unknown = { error: message }): Promise<never> => {
    await record(ctx, tool, args, output, code, Date.now() - start);
    throw new ToolError(tool, code, message);
  };

  if (spec) {
    const parsed = spec.input.safeParse(args);
    if (!parsed.success) await fail("invalid_args", parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "));
    if (spec.requiresApproval) {
      // Mission approvals and product approvals (release/deploy) both count; scoped to the workspace.
      const approved = ctx.approvalId
        ? (await prisma.missionApproval.findFirst({ where: { id: ctx.approvalId, companyId: ctx.companyId, status: "APPROVED" }, select: { id: true } })) ??
          (await prisma.productApproval.findFirst({ where: { id: ctx.approvalId, companyId: ctx.companyId, status: "APPROVED" }, select: { id: true } }))
        : null;
      if (!approved) await fail("approval_required", "this action requires an approved human approval");
    }
    if (spec.writePathArg) {
      const p = String(args[spec.writePathArg]);
      if (!ctx.writeScope || !inScope(p, ctx.writeScope)) await fail("out_of_scope", `write to ${p} is outside the task's write scope`);
    }
    if (spec.readPathArg && ctx.readScope) {
      const p = String(args[spec.readPathArg]);
      if (!inScope(p, ctx.readScope)) await fail("out_of_scope", `read of ${p} is outside the task's read scope`);
    }
  }

  const timeoutMs = ctx.timeoutMs ?? spec?.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let output: unknown;
  try {
    output = timeoutMs
      ? await Promise.race([
          impl(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ToolError(tool, "timeout", `timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ])
      : await impl();
  } catch (e) {
    if (e instanceof ToolError) return fail(e.code, e.message.replace(`${tool}: `, ""));
    return fail("error", (e as Error).message);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (spec) {
    const out = spec.output.safeParse(output);
    if (!out.success) {
      return fail("invalid_output", `result failed validation: ${out.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`, {
        malformed: String(JSON.stringify(output)).slice(0, 500),
      });
    }
  }
  await record(ctx, tool, args, output, "ok", Date.now() - start);
  return output as T;
}
