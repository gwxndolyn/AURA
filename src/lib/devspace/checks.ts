/**
 * Workspace checks: a fixed allowlist of commands executed through the
 * existing Docker sandbox (no network, memory/CPU/pids limits, non-root,
 * cap-drop ALL, wall-clock timeout, bounded output). The project files are
 * written to an ephemeral directory that is removed after the run. Users never
 * supply a command string.
 *
 * Unsupported checks (lint/typecheck/build need toolchains this project and
 * sandbox image don't have) are reported as UNSUPPORTED — never as passing.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { emitEvent } from "@/lib/events/emit";
import { createWorkspace, execInSandbox, dockerAvailable, killSandbox } from "@/lib/sandbox/docker";
import { getWorkspace, filesOf } from "./files";
import { proposedContent } from "./changes";

export const MAX_OUTPUT = 32 * 1024;
// Wall-clock limit per check (container start + run). Bounded 5 s … 120 s.
const TIMEOUT_MS = Math.min(Math.max(Number(process.env.AURA_CHECK_TIMEOUT_MS ?? 30_000) || 30_000, 5_000), 120_000);

export interface CheckSpec {
  id: string;
  label: string;
  command: string | null; // null = unsupported
  unsupportedReason?: string;
}

export const CHECKS: Record<string, CheckSpec> = {
  "unit-tests": { id: "unit-tests", label: "Unit tests (node --test)", command: "node --test" },
  syntax: { id: "syntax", label: "Syntax check (node --check)", command: "for f in $(find . -name '*.js' -not -path './node_modules/*'); do node --check \"$f\" || exit 1; done && echo SYNTAX_OK" },
  lint: { id: "lint", label: "Lint", command: null, unsupportedReason: "No linter is configured for this project and the sandbox image has no network to install one." },
  typecheck: { id: "typecheck", label: "Type check", command: null, unsupportedReason: "The project is plain JavaScript with no TypeScript configuration." },
  build: { id: "build", label: "Build", command: null, unsupportedReason: "The project has no build step (no package.json scripts)." },
};

function parseTap(out: string) {
  const cases: { name: string; ok: boolean }[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(not ok|ok)\s+\d+\s+-\s+(.*)$/);
    if (m && !/^(\S+\.test\.js)$/.test(m[2].trim())) cases.push({ name: m[2].trim().replace(/\\#/g, "#"), ok: m[1] === "ok" });
  }
  const p = out.match(/^[#ℹ]\s*pass\s+(\d+)/m);
  const f = out.match(/^[#ℹ]\s*fail\s+(\d+)/m);
  const passed = p ? Number(p[1]) : cases.filter((c) => c.ok).length;
  const failed = f ? Number(f[1]) : cases.filter((c) => !c.ok).length;
  return { passed, failed, total: passed + failed, failedNames: cases.filter((c) => !c.ok).map((c) => c.name) };
}

const running = new Map<string, { cancelled: boolean; container: string }>();

/**
 * Run an allowlisted check against the current project revision, optionally
 * with one proposed change overlaid (so a reviewer can verify a change before
 * accepting it). Persists the ExecRun with real exit code + bounded output.
 */
export async function runCheck(companyId: string, checkId: string, requestedBy: string, opts: { changeId?: string } = {}) {
  const spec = CHECKS[checkId];
  if (!spec) throw new ApiError(`Unknown check ${checkId}`, 422);
  const ws = await getWorkspace(companyId);
  let files = filesOf(ws);
  let overlay: string | null = null;
  if (opts.changeId) {
    const c = await prisma.fileChange.findFirst({ where: { id: opts.changeId, companyId } });
    if (!c) throw new ApiError("Change not found", 404);
    const content = await proposedContent(c);
    if (content === null) throw new ApiError("Proposed content is no longer available", 410);
    files = { ...files, [c.path]: content };
    overlay = c.path;
  }

  if (!spec.command) {
    return prisma.execRun.create({ data: { workspaceId: ws.id, companyId, check: spec.id, command: "", revision: ws.revision, changeId: opts.changeId ?? null, status: "UNSUPPORTED", output: spec.unsupportedReason ?? "Unsupported", requestedBy, completedAt: new Date() } });
  }
  if (await prisma.execRun.count({ where: { companyId, status: { in: ["QUEUED", "RUNNING"] } } }) >= 2) throw new ApiError("Two checks are already running in this workspace; wait or cancel one", 429);

  const container = `aura-${randomBytes(8).toString("hex")}`;
  const row = await prisma.execRun.create({ data: { workspaceId: ws.id, companyId, check: spec.id, command: spec.command, revision: ws.revision, changeId: opts.changeId ?? null, status: "RUNNING", requestedBy, startedAt: new Date(), container } });
  await emitEvent({ companyId, type: "TEST_STARTED", actor: "system", message: `${spec.label} started on r${ws.revision}${overlay ? ` + proposed ${overlay}` : ""}`, meta: { execRunId: row.id } });

  if (!(await dockerAvailable())) {
    return prisma.execRun.update({ where: { id: row.id }, data: { status: "ERROR", mode: "unavailable", output: "Docker sandbox unavailable — the check was NOT executed.", completedAt: new Date(), container: null } });
  }
  const state = { cancelled: false, container };
  running.set(row.id, state);
  const sandbox = await createWorkspace(files) /* paths keep their directories; node --test discovers *.test.js recursively */;
  try {
    const r = await execInSandbox(sandbox, `${spec.command} 2>&1`, { timeoutMs: TIMEOUT_MS, name: container });
    const raw = r.stdout + r.stderr;
    const truncated = raw.length > MAX_OUTPUT;
    const output = truncated ? `${raw.slice(0, MAX_OUTPUT)}\n…[output truncated at ${MAX_OUTPUT / 1024} KB]` : raw;
    const tap = spec.id === "unit-tests" ? parseTap(raw) : null;
    const status = state.cancelled ? "CANCELLED" : r.timedOut ? "TIMED_OUT" : r.exitCode === 0 && (spec.id !== "unit-tests" || (tap!.total > 0 && tap!.failed === 0)) ? "PASSED" : "FAILED";
    const done = await prisma.execRun.update({
      where: { id: row.id },
      data: { status, mode: r.mode, exitCode: r.exitCode, passed: tap?.passed ?? null, failed: tap?.failed ?? null, total: tap?.total ?? null, failedNames: JSON.stringify(tap?.failedNames ?? []), output, truncated, completedAt: new Date(), container: null },
    });
    await emitEvent({ companyId, type: "TEST_COMPLETED", actor: "system", level: status === "PASSED" ? "success" : "danger", message: `${spec.label}: ${status.toLowerCase()}${tap ? ` (${tap.passed}/${tap.total})` : ""}`, meta: { execRunId: row.id } });
    return done;
  } finally {
    running.delete(row.id);
    await sandbox.cleanup(); // ephemeral directory removed; the container is --rm
  }
}

/** Cancel a running check: kill its container; the run records CANCELLED. */
export async function cancelCheck(companyId: string, execRunId: string, actor: string) {
  const run = await prisma.execRun.findFirst({ where: { id: execRunId, companyId } });
  if (!run) throw new ApiError("Check not found", 404);
  if (run.status !== "RUNNING") throw new ApiError(`Check is ${run.status.toLowerCase()}`, 409);
  const state = running.get(run.id);
  if (state) state.cancelled = true;
  if (run.container) await killSandbox(run.container).catch(() => false);
  if (!state) {
    // Not in this process (server restarted): record it as cancelled/abandoned so it never looks like it is still running.
    await prisma.execRun.updateMany({ where: { id: run.id, status: "RUNNING" }, data: { status: "CANCELLED", output: `${run.output}\nCancelled by ${actor} (the executing process was no longer running).`, completedAt: new Date(), container: null } });
  }
  return { cancelled: true };
}

/** Runs left RUNNING by a crashed process are closed out, not shown as running forever. */
export async function reapStaleRuns(companyId: string) {
  const cutoff = new Date(Date.now() - TIMEOUT_MS - 30_000);
  const stale = await prisma.execRun.findMany({ where: { companyId, status: "RUNNING", startedAt: { lt: cutoff } } });
  for (const r of stale) {
    if (running.has(r.id)) continue;
    if (r.container) await killSandbox(r.container).catch(() => false);
    await prisma.execRun.update({ where: { id: r.id }, data: { status: "ERROR", output: `${r.output}\nAbandoned: the process running this check stopped before it finished.`, completedAt: new Date(), container: null } });
  }
  return stale.length;
}
