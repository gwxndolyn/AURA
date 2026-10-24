/**
 * Run one command in the Docker sandbox against a build working tree and
 * persist it as a CommandRun (exact command, exit code, duration, bounded
 * output). Isolation (src/lib/sandbox/docker.ts flags): non-root, cap-drop
 * ALL, no-new-privileges, read-only root FS, memory/CPU/pids limits, wall-clock
 * timeout. Network is OFF except for dependency installation, which runs as its
 * own step with `--ignore-scripts` so package lifecycle scripts never execute
 * with network access. No host environment variables or secrets are passed in.
 */
import { randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";
import { prisma } from "@/lib/db";
import { execInSandbox, dockerAvailable, type Workspace } from "@/lib/sandbox/docker";
import { JobError } from "@/lib/jobs/queue";
import { recordUsage } from "@/lib/billing/entitlements";
import type { Tree } from "./workspace";

export const OUTPUT_CAP = 48 * 1024;
const TIMEOUT = {
  install: Number(process.env.AURA_INSTALL_TIMEOUT_MS || 240_000),
  default: Number(process.env.AURA_COMMAND_TIMEOUT_MS || 120_000),
};

/** Allowed command shapes. Agents choose from these; arbitrary shell is refused. */
const ALLOWED = [
  /^npm (test|ci|install)( --[a-z-]+)*$/,
  /^npm (test|run [a-z0-9:_-]{1,40})( --silent)?$/,
  /^npm (ci|install) --ignore-scripts( --no-audit| --no-fund)*$/,
  /^corepack (yarn|pnpm) (install|run [a-z0-9:_-]{1,40})( --[a-z-]+)*$/,
  /^node --test( [A-Za-z0-9_./-]+)*$/,
  /^node --check [A-Za-z0-9_./-]+$/,
  /^node scripts\/[A-Za-z0-9_.-]+\.js$/,
  /^npx --no-install (tsc|eslint|vitest|jest|prettier)( [A-Za-z0-9_./=:-]+)*$/,
];

export function isAllowedCommand(cmd: string) {
  const c = cmd.trim();
  if (/[;&|`$<>\\\n]/.test(c)) return false;
  return ALLOWED.some((re) => re.test(c));
}

export function isDaemonFailure(exitCode: number | null, stderr: string) {
  return exitCode === 125 || /^docker: Error response from daemon|Cannot connect to the Docker daemon/m.test(stderr);
}

export async function sandboxReady() {
  return dockerAvailable();
}

export async function runInTree(args: { buildId: string; companyId: string; tree: Tree; command: string; purpose: string; actor: string; network?: boolean; timeoutMs?: number }) {
  if (!isAllowedCommand(args.command)) throw new JobError(`Command not allowed in the sandbox: ${args.command}`, false, "command_refused");
  if (!(await dockerAvailable())) throw new JobError("The execution sandbox (Docker) is not available on this server — nothing was executed", true, "sandbox_unavailable");
  // The container runs as the unprivileged `node` user; make the tree writable for it.
  await chmod(args.tree.dir, 0o777).catch(() => {});
  const ws: Workspace = { dir: args.tree.dir, write: async () => {}, read: async () => null, list: async () => [], cleanup: async () => {} };
  const network = !!args.network;
  const name = `aura-b-${args.buildId.slice(-10).toLowerCase()}-${randomBytes(3).toString("hex")}`;
  const timeoutMs = args.timeoutMs ?? (args.purpose === "install" ? TIMEOUT.install : TIMEOUT.default);
  // HOME/npm cache inside /tmp (tmpfs); CI=1 keeps tools non-interactive.
  const cmd = `export HOME=/tmp CI=1 npm_config_cache=/tmp/.npm npm_config_update_notifier=false; ${args.command}`;
  // Record the container so cancellation can stop it (cancelBuild → killSandbox).
  await prisma.build.update({ where: { id: args.buildId }, data: { container: name } });
  const r = await execInSandbox(ws, cmd, { timeoutMs, network, name, tmpfsMb: args.purpose === "install" ? 512 : 128 });
  await prisma.build.updateMany({ where: { id: args.buildId, container: name }, data: { container: null } });
  if (r.mode !== "docker") throw new JobError("The execution sandbox became unavailable — nothing was executed", true, "sandbox_unavailable");
  // `docker run` itself failed (daemon/image/storage error, exit 125) — the command never ran. That is an
  // infrastructure failure, never a verdict on the project's code.
  if (isDaemonFailure(r.exitCode, r.stderr)) throw new JobError(`The execution sandbox failed to start a container: ${r.stderr.replace(/\s+/g, " ").slice(0, 200)}`, true, "sandbox_unavailable");
  const output = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();
  const row = await prisma.commandRun.create({
    data: { buildId: args.buildId, companyId: args.companyId, purpose: args.purpose, actor: args.actor, command: args.command, network, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, output: output.slice(-OUTPUT_CAP), truncated: output.length > OUTPUT_CAP },
  });
  await prisma.build.update({ where: { id: args.buildId }, data: { sandboxMs: { increment: r.durationMs } } });
  await recordUsage(args.companyId, [{ metric: "sandbox_ms", quantity: r.durationMs }], `command:${row.id}`);
  return { id: row.id, exitCode: r.exitCode, timedOut: r.timedOut, output: row.output, durationMs: r.durationMs, ok: r.exitCode === 0 && !r.timedOut };
}
