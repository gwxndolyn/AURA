/**
 * Tools the builder agents may call. Every call goes through callTool()
 * (role allowlist, Zod args, write scope, timeout, audited ToolCall row). The
 * implementations act on the real working tree and the real sandbox.
 */
import type { ToolDef, ToolUse } from "@/lib/ai/claude";
import { callTool } from "@/lib/agents/tools";
import { readTreeFile, writeTreeFile, deleteTreeFile, listTree, type Tree } from "./workspace";
import { runInTree, isAllowedCommand } from "./sandbox";

export const BUILDER_TOOLS: Record<string, ToolDef> = {
  "fs.list": { name: "fs_list", description: "List files in the project (optionally under a directory). node_modules and .git are excluded.", input_schema: { type: "object", properties: { dir: { type: "string" } } } },
  "fs.read": { name: "fs_read", description: "Read a UTF-8 text file from the project.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  "fs.write": { name: "fs_write", description: "Create or overwrite a file with the FULL new content.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  "fs.delete": { name: "fs_delete", description: "Delete a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  "cmd.run": { name: "cmd_run", description: "Run an allowlisted project command in the isolated sandbox and get the real exit code and output. Allowed: `npm test`, `npm run <script>`, `npm install --ignore-scripts` (purpose=install, the only step with network), `node --test [files]`, `node --check <file>`, `node scripts/<file>.js`, `npx --no-install tsc|eslint|vitest|jest|prettier ...`. No shell operators.", input_schema: { type: "object", properties: { command: { type: "string" }, purpose: { type: "string", enum: ["test", "lint", "typecheck", "build", "install", "check"] } }, required: ["command", "purpose"] } },
};

const NAME_TO_TOOL: Record<string, string> = Object.fromEntries(Object.entries(BUILDER_TOOLS).map(([k, v]) => [v.name, k]));

export function toolDefsFor(tools: string[]): ToolDef[] {
  return tools.filter((t) => BUILDER_TOOLS[t]).map((t) => BUILDER_TOOLS[t]);
}

export interface ToolEnv {
  companyId: string;
  buildId: string;
  agentKey: string;
  runId: string;
  tree: Tree;
  writeScope: string[];
  touched: Set<string>;
}

/** Dispatch a model tool_use to the real implementation through callTool. */
export async function executeTool(env: ToolEnv, use: ToolUse): Promise<unknown> {
  const tool = NAME_TO_TOOL[use.name];
  if (!tool) throw new Error(`Unknown tool ${use.name}`);
  const ctx = { companyId: env.companyId, agentKey: env.agentKey, runId: env.runId, writeScope: env.writeScope };
  const a = use.input as Record<string, unknown>;
  switch (tool) {
    case "fs.list":
      return callTool(ctx, tool, a, async () => ({ files: await listTree(env.tree, typeof a.dir === "string" ? a.dir : "") }));
    case "fs.read":
      return callTool(ctx, tool, a, async () => ({ path: String(a.path), content: await readTreeFile(env.tree, String(a.path)) }));
    case "fs.write":
      return callTool(ctx, tool, a, async () => {
        const p = await writeTreeFile(env.tree, String(a.path), String(a.content ?? ""));
        env.touched.add(p);
        return { path: p, bytes: Buffer.byteLength(String(a.content ?? "")) };
      });
    case "fs.delete":
      return callTool(ctx, tool, a, async () => {
        const p = await deleteTreeFile(env.tree, String(a.path));
        env.touched.add(p);
        return { path: p };
      });
    case "cmd.run":
      return callTool(ctx, tool, a, async () => {
        const command = String(a.command).trim();
        if (!isAllowedCommand(command)) throw new Error(`command not allowed: ${command}`);
        const install = a.purpose === "install";
        if (install && !/--ignore-scripts/.test(command)) throw new Error("installs must use --ignore-scripts (no package scripts run with network access)");
        const r = await runInTree({ buildId: env.buildId, companyId: env.companyId, tree: env.tree, command, purpose: String(a.purpose), actor: env.agentKey, network: install });
        return { exitCode: r.exitCode, timedOut: r.timedOut, output: r.output.slice(-12_000), commandRunId: r.id };
      });
  }
  throw new Error(`Unhandled tool ${tool}`);
}
