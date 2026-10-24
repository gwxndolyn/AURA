/**
 * Isolated self-modification of AURA's own code (bounded, reversible).
 *
 *   1. checkpoint: the source revision (HEAD) is recorded
 *   2. isolation: `git worktree add` on a NEW branch `aura/selfmod/<id>` —
 *      the main working tree and its branch are never touched
 *   3. bounded change: a patch limited to allow-listed paths and a maximum
 *      number of changed files/lines; protected paths (auth, permissions,
 *      sandbox, tests' assertions, benchmark definitions, lab decision rules,
 *      this file) are refused, so a self-modification cannot weaken security
 *      controls, its own permissions, or the criteria it is judged by
 *   4. verification: the relevant test files run INSIDE a Docker container
 *      (network off, worktree mounted read-only except node_modules cache),
 *      never on the host
 *   5. decision: tests pass → the change is committed on the isolated branch
 *      (reviewable; never merged automatically); tests fail → the worktree and
 *      branch are deleted (automatic rollback) and the attempt is recorded
 *
 * The repository root comes from AURA_SELFMOD_REPO; without it, or without
 * Docker, self-modification is unavailable and says so.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, normalize } from "node:path";
import { createHash } from "node:crypto";
import { dockerAvailable } from "@/lib/sandbox/docker";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/events/emit";

const run = promisify(execFile);

export const SELFMOD_LIMITS = { maxFiles: Number(process.env.AURA_SELFMOD_MAX_FILES || 5), maxLines: Number(process.env.AURA_SELFMOD_MAX_LINES || 200), testTimeoutMs: Number(process.env.AURA_SELFMOD_TEST_TIMEOUT_MS || 300_000) };
export const SELFMOD_IMAGE = process.env.AURA_SELFMOD_IMAGE || "aura-selfmod:dev";

/** Paths a self-modification may change. */
const ALLOWED = [/^src\/lib\/builder\/(intel|verdict|debug|detect)\.ts$/, /^src\/lib\/lab\/runner\.ts$/, /^docs\//];
/** Paths it may never change, even if a broader allow rule matched. */
const PROTECTED = [/^src\/lib\/auth\//, /^src\/middleware\.ts$/, /permissions\.ts$/, /toolSpecs\.ts$/, /^src\/lib\/sandbox\//, /^src\/lib\/lab\/(lab|benchmarks|scorecard)\.ts$/, /^src\/lib\/runtime\/selfmod\.ts$/, /\.test\.ts$/, /^prisma\//, /^\.env/, /^package(-lock)?\.json$/];

export function checkPatchScope(files: Record<string, string>, before: Record<string, string | null>) {
  const problems: string[] = [];
  const paths = Object.keys(files);
  if (!paths.length) problems.push("empty patch");
  if (paths.length > SELFMOD_LIMITS.maxFiles) problems.push(`changes ${paths.length} files (limit ${SELFMOD_LIMITS.maxFiles})`);
  let lines = 0;
  for (const p of paths) {
    const n = normalize(p);
    if (n !== p || p.startsWith("/") || p.includes("..")) problems.push(`unsafe path ${p}`);
    if (PROTECTED.some((r) => r.test(p))) problems.push(`${p} is protected (security, permissions, sandbox, tests, benchmarks or lab decision rules)`);
    else if (!ALLOWED.some((r) => r.test(p))) problems.push(`${p} is outside the self-modification allow-list`);
    const a = (before[p] ?? "").split("\n"), b = files[p].split("\n");
    lines += Math.abs(b.length - a.length) + b.filter((l, i) => a[i] !== l).length;
  }
  if (lines > SELFMOD_LIMITS.maxLines) problems.push(`changes ~${lines} lines (limit ${SELFMOD_LIMITS.maxLines})`);
  return problems;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await run("git", args, { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "AURA self-improvement", GIT_AUTHOR_EMAIL: "aura-selfmod@localhost", GIT_COMMITTER_NAME: "AURA self-improvement", GIT_COMMITTER_EMAIL: "aura-selfmod@localhost", HOME: tmpdir() } as unknown as NodeJS.ProcessEnv, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function selfmodAvailable() {
  const repo = process.env.AURA_SELFMOD_REPO;
  if (!repo || !existsSync(join(repo, ".git"))) return { ok: false, reason: "AURA_SELFMOD_REPO is not set to a git checkout of AURA" };
  if (!(await dockerAvailable())) return { ok: false, reason: "Docker is unavailable: self-modification tests only run in a container" };
  try {
    await run("docker", ["image", "inspect", SELFMOD_IMAGE], { timeout: 10_000 });
  } catch {
    return { ok: false, reason: `image ${SELFMOD_IMAGE} not built (docker build -f Dockerfile.selfmod -t ${SELFMOD_IMAGE} .)` };
  }
  return { ok: true, reason: "" };
}

export interface SelfmodResult { status: "COMMITTED" | "REVERTED" | "REFUSED" | "UNAVAILABLE"; branch?: string; baseSha?: string; commit?: string; tests?: { command: string; exitCode: number | null; outputTail: string }; reasons: string[] }

/**
 * Apply a bounded patch in an isolated worktree, run the given test files in
 * Docker, then commit (kept on its own branch) or remove (rolled back).
 */
export type TestRunner = (worktree: string, tests: string[]) => Promise<{ command: string; exitCode: number | null; output: string }>;

/** Production test runner: vitest inside a locked-down container built from this repository's `deps` stage. */
export const dockerTestRunner: TestRunner = async (wt, tests) => {
  const cmd = `cp -r /wt/src /wt/test /wt/vitest.config.ts /wt/tsconfig.json /app/ 2>/dev/null; cd /app && DATABASE_URL=file:/tmp/selfmod.db npx prisma db push --skip-generate >/dev/null 2>&1; DATABASE_URL=file:/tmp/selfmod.db npx vitest run ${tests.join(" ")}`; // tests needing the database require a generated Prisma client in the image
  const t0 = Date.now();
  try {
    const r = await run("docker", ["run", "--rm", "--network=none", "--memory=2g", "--cpus=2", "--pids-limit=512", "--cap-drop=ALL", "--security-opt=no-new-privileges", "-v", `${wt}:/wt:ro`, "--tmpfs", "/tmp:rw,size=512m", SELFMOD_IMAGE, "sh", "-c", cmd], { timeout: SELFMOD_LIMITS.testTimeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { command: `vitest run ${tests.join(" ")} (docker ${SELFMOD_IMAGE}, ${Date.now() - t0} ms)`, exitCode: 0, output: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    return { command: `vitest run ${tests.join(" ")} (docker ${SELFMOD_IMAGE})`, exitCode: typeof err.code === "number" ? err.code : 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.killed ? "\n[killed: test timeout]" : ""}` };
  }
};

export async function runSelfModification(args: { id: string; files: Record<string, string>; tests: string[]; message: string; signal?: AbortSignal; runner?: TestRunner }): Promise<SelfmodResult> {
  if (!args.runner) {
    const avail = await selfmodAvailable();
    if (!avail.ok) return { status: "UNAVAILABLE", reasons: [avail.reason] };
  } else if (!process.env.AURA_SELFMOD_REPO) return { status: "UNAVAILABLE", reasons: ["AURA_SELFMOD_REPO is not set"] };
  const repo = process.env.AURA_SELFMOD_REPO!;
  if (!/^[a-z0-9-]{3,60}$/.test(args.id)) return { status: "REFUSED", reasons: ["invalid experiment id"] };
  if (!args.tests.length || args.tests.some((t) => !/^src\/[A-Za-z0-9_/.[\]-]+\.test\.ts$/.test(t))) return { status: "REFUSED", reasons: ["tests must be existing src/**/*.test.ts files"] };
  const baseSha = await git(repo, ["rev-parse", "HEAD"]);
  const before: Record<string, string | null> = {};
  for (const p of Object.keys(args.files)) before[p] = existsSync(join(repo, p)) ? await readFile(join(repo, p), "utf8") : null;
  const scope = checkPatchScope(args.files, before);
  if (scope.length) return { status: "REFUSED", baseSha, reasons: scope };
  const branch = `aura/selfmod/${args.id}`;
  const wt = await mkdtemp(join(tmpdir(), "aura-selfmod-"));
  await rm(wt, { recursive: true, force: true });
  await git(repo, ["worktree", "add", "-q", "-b", branch, wt, baseSha]);
  let keep = false;
  try {
    for (const [p, c] of Object.entries(args.files)) {
      await mkdir(dirname(join(wt, p)), { recursive: true });
      await writeFile(join(wt, p), c, "utf8");
    }
    if (args.signal?.aborted) throw new Error("cancelled");
    const r = await (args.runner ?? dockerTestRunner)(wt, args.tests);
    const exitCode = r.exitCode;
    const tests = { command: r.command, exitCode, outputTail: r.output.slice(-3000) };
    if (exitCode !== 0) return { status: "REVERTED", branch, baseSha, tests, reasons: ["tests failed in the isolated container; worktree and branch removed"] };
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", `${args.message.slice(0, 200)}\n\nAURA self-improvement experiment ${args.id}. Base ${baseSha}.\nVerified: ${tests.command} → exit 0.\nNot merged: requires review.`]);
    const commit = await git(wt, ["rev-parse", "HEAD"]);
    keep = true;
    return { status: "COMMITTED", branch, baseSha, commit, tests, reasons: [`committed on ${branch}; review and merge manually`] };
  } finally {
    await git(repo, ["worktree", "remove", "--force", wt]).catch(() => rm(wt, { recursive: true, force: true }));
    if (!keep) await git(repo, ["branch", "-D", branch]).catch(() => null);
  }
}

/** Remove abandoned selfmod worktrees (crash between add and remove). */
export async function cleanupSelfmodWorktrees() {
  const repo = process.env.AURA_SELFMOD_REPO;
  if (!repo || !existsSync(join(repo, ".git"))) return 0;
  await git(repo, ["worktree", "prune"]).catch(() => null);
  return 1;
}

/**
 * Recorded self-modification: refuses a patch that already failed (same patch hash on the same base)
 * unless `force` explains what changed, then runs it and persists the attempt with rollback info.
 */
export async function attemptSelfModification(args: { companyId: string; actor: string; id: string; files: Record<string, string>; tests: string[]; message: string; force?: string; signal?: AbortSignal; runner?: TestRunner }) {
  const patchHash = createHash("sha256").update(JSON.stringify(Object.entries(args.files).sort())).digest("hex").slice(0, 24);
  const prior = await prisma.selfModAttempt.findFirst({ where: { companyId: args.companyId, patchHash, status: { in: ["REVERTED", "REFUSED"] } }, orderBy: { createdAt: "desc" } });
  if (prior && !args.force) {
    return { status: "REFUSED" as const, reasons: [`this exact patch was already ${prior.status.toLowerCase()} (attempt ${prior.id}); provide new evidence (force) to retry`], attempt: prior };
  }
  const r = await runSelfModification({ id: args.id, files: args.files, tests: args.tests, message: args.message, signal: args.signal, runner: args.runner });
  const rollback = r.status === "COMMITTED" ? `not merged; to discard: git branch -D ${r.branch}` : r.status === "REVERTED" ? "worktree and branch deleted automatically; base untouched" : "nothing was changed";
  const attempt = await prisma.selfModAttempt.create({ data: { companyId: args.companyId, key: args.id, patchHash, baseSha: r.baseSha ?? "", files: JSON.stringify(Object.keys(args.files)), status: r.status, branch: r.branch ?? null, commit: r.commit ?? null, tests: JSON.stringify(r.tests ?? {}), reasons: JSON.stringify([...r.reasons, ...(args.force ? [`retry justification: ${args.force}`] : [])]), rollback, createdBy: args.actor } });
  await audit(args.companyId, args.actor, "SELFMOD_ATTEMPT", attempt.id, `${args.id}: ${r.status}`);
  return { ...r, attempt };
}
