/**
 * Tool specifications: input/output schemas, timeout, approval requirement and
 * scope rules. `callTool()` enforces these outside the model — a tool call with
 * malformed arguments, an out-of-scope write, a timeout or a malformed result
 * fails with a classified error and a ToolCall audit row.
 */
import { z } from "zod";
import type { ToolName } from "./permissions";

export interface ToolSpec {
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  timeoutMs: number;
  /** Consequential actions: refused unless the caller passes an approved approval id. */
  requiresApproval?: boolean;
  /** Path arguments that must fall inside ctx.writeScope / ctx.readScope. */
  writePathArg?: string;
  readPathArg?: string;
}

const path = z.string().min(1).max(200).regex(/^[A-Za-z0-9_./-]+$/, "unsafe path").refine((p) => !p.includes("..") && !p.startsWith("/"), "path must be relative and inside the workspace");

const testRun = z.object({
  mode: z.enum(["docker", "simulated"]),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  total: z.number().int().min(0),
  cases: z.array(z.object({ name: z.string(), ok: z.boolean() })),
  output: z.string(),
  durationMs: z.number(),
  timedOut: z.boolean().optional(),
});

const treePath = z.string().min(1).max(240).regex(/^[A-Za-z0-9_@./+-]+$/, "unsafe path").refine((p) => !p.split("/").includes("..") && !p.startsWith("/"), "path must be relative and inside the project");

export const TOOL_SPECS: Partial<Record<ToolName, ToolSpec>> = {
  "fs.list": { input: z.object({ dir: z.string().max(240).optional() }), output: z.object({ files: z.array(z.string()) }), timeoutMs: 10_000 },
  "fs.read": { input: z.object({ path: treePath }), output: z.object({ path: z.string(), content: z.string().nullable() }), timeoutMs: 10_000, readPathArg: "path" },
  "fs.write": { input: z.object({ path: treePath, content: z.string().max(200 * 1024) }), output: z.object({ path: z.string(), bytes: z.number().int().min(0) }), timeoutMs: 10_000, writePathArg: "path" },
  "fs.delete": { input: z.object({ path: treePath }), output: z.object({ path: z.string() }), timeoutMs: 10_000, writePathArg: "path" },
  "cmd.run": {
    input: z.object({ command: z.string().min(1).max(200), purpose: z.enum(["test", "lint", "typecheck", "build", "install", "check"]) }),
    output: z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), output: z.string(), commandRunId: z.string() }),
    timeoutMs: 300_000,
  },
  "code.read": {
    input: z.object({ path, reason: z.string().max(200).optional() }),
    output: z.object({ path: z.string(), bytes: z.number().int().min(0), lines: z.number().int().min(0) }),
    timeoutMs: 5_000,
    readPathArg: "path",
  },
  "code.write": {
    input: z.object({ path, change: z.string().min(1).max(300), addresses: z.array(z.string()).max(20).optional() }),
    output: z.object({ path: z.string(), bytes: z.number().int().min(0) }),
    timeoutMs: 5_000,
    writePathArg: "path",
  },
  "test.run": {
    input: z.object({ suite: path, label: z.string().max(120) }),
    output: testRun,
    timeoutMs: 45_000,
    readPathArg: "suite",
  },
  "sandbox.exec": {
    input: z.object({ probe: z.string().min(1).max(80), files: z.array(path).max(10) }),
    output: testRun,
    timeoutMs: 45_000,
  },
  "security.scan": {
    input: z.object({ paths: z.array(path).min(1).max(10) }),
    output: z.array(z.object({ check: z.string(), pass: z.boolean() })).min(1),
    timeoutMs: 10_000,
  },
  "message.send": {
    input: z.object({ to: z.string().min(1).max(40), type: z.string().max(40), message: z.string().min(1).max(2000) }),
    output: z.unknown(),
    timeoutMs: 5_000,
  },
  "deploy.run": {
    input: z.object({ env: z.enum(["development", "staging", "preview", "production"]) }).passthrough(),
    output: z.unknown(),
    timeoutMs: 60_000,
    requiresApproval: true,
  },
  "deploy.rollback": {
    input: z.object({ env: z.enum(["development", "staging", "preview", "production"]) }).passthrough(),
    output: z.unknown(),
    timeoutMs: 60_000,
    requiresApproval: true,
  },
};

export function specFor(tool: string): ToolSpec | undefined {
  return TOOL_SPECS[tool as ToolName];
}

// Matches a path against a scope list. Entries are exact paths or globs:
// `**` = any number of path segments, `*` = anything except "/".
// Examples: "src/a.js", "src/**", "**", "**/*.test.js".
export function inScope(p: string, scope: string[]): boolean {
  return scope.some((s) => {
    if (!s.includes("*")) return p === s;
    const re = new RegExp(
      "^" +
        s
          .split("/")
          .map((seg) => (seg === "**" ? "\u0000" : seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
          .join("/")
          .replace(/\u0000\//g, "(?:[^/]+/)*")
          .replace(/\/\u0000$/, "(?:/.*)?")
          .replace(/^\u0000$/, ".*") +
        "$",
    );
    return re.test(p);
  });
}
