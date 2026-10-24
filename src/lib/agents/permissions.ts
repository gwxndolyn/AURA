/**
 * Agent permission model. Each tool is namespaced; each agent role has an
 * explicit allowlist. The tool runner (lib/agents/tools.ts) enforces this —
 * an agent attempting a tool outside its allowlist is blocked and audited.
 */

export const ALL_TOOLS = [
  "planning.createTask",
  "planning.prioritize",
  "planning.createSprint",
  "code.read",
  "code.write",
  "code.build",
  "sandbox.exec",
  "test.run",
  "browser.qa",
  "security.scan",
  "security.patch",
  "logs.read",
  "deploy.run",
  "deploy.rollback",
  "cyber.attack", // red team only — sandbox cyber range
  "cyber.monitor", // blue team
  "incident.manage",
  "message.send",
  // Builder tools (src/lib/builder/tools.ts): real working-tree operations.
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.delete",
  "cmd.run",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

/** Per-role tool allowlists. */
export const ROLE_PERMISSIONS: Record<string, ToolName[]> = {
  ceo: ["planning.prioritize", "planning.createSprint", "message.send"],
  "product-manager": [
    "planning.createTask",
    "planning.prioritize",
    "planning.createSprint",
    "message.send",
  ],
  architect: ["code.read", "planning.createTask", "message.send"],
  "frontend-engineer": ["code.read", "code.write", "code.build", "sandbox.exec", "message.send", "fs.list", "fs.read", "fs.write", "fs.delete", "cmd.run"],
  "backend-engineer": [
    "code.read",
    "code.write",
    "code.build",
    "sandbox.exec",
    "security.patch",
    "message.send",
    "fs.list",
    "fs.read",
    "fs.write",
    "fs.delete",
    "cmd.run",
  ],
  // QA may write TEST files only (enforced by write scope in the builder), and run commands.
  "qa-engineer": ["code.read", "test.run", "browser.qa", "sandbox.exec", "message.send", "fs.list", "fs.read", "fs.write", "cmd.run"],
  // Reviewer reads code and may execute probes in the sandbox; it can never write code.
  reviewer: ["code.read", "sandbox.exec", "message.send", "fs.list", "fs.read"],
  // Designer produces design artifacts only; it reads code for conventions and never writes or executes it.
  designer: ["code.read", "message.send", "fs.list", "fs.read"],
  devops: ["deploy.run", "deploy.rollback", "logs.read", "sandbox.exec", "message.send"],
  "security-engineer": ["security.scan", "security.patch", "logs.read", "incident.manage", "message.send", "fs.list", "fs.read"],
  "red-team": ["cyber.attack", "message.send"],
  "blue-team": ["cyber.monitor", "logs.read", "incident.manage", "message.send"],
  "data-analyst": ["logs.read", "message.send"],
  support: ["message.send"],
};

export function permissionsFor(agentKey: string): ToolName[] {
  return ROLE_PERMISSIONS[agentKey] ?? ["message.send"];
}

export function isAllowed(agentKey: string, tool: string): boolean {
  return permissionsFor(agentKey).includes(tool as ToolName);
}
