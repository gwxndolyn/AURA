/**
 * Build workspace: a real git working tree for one engineering run.
 *
 *   <AURA_WORK_ROOT>/<companyId>/<buildId>/     (clone of the product repo, branch checked out)
 *
 * Files are read and written ONLY through these helpers, which normalise
 * paths (no traversal, no absolute paths, no .git, no protected secret files)
 * and cap sizes. Commands run in the Docker sandbox (sandbox.ts), never on the
 * host. The tree is removed after the run; the result lives on as git commits.
 */
import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePath, isProtected, MAX_FILE_BYTES } from "@/lib/devspace/paths";
import { bareDir, assertBranch } from "@/lib/factory/git";
import { ApiError } from "@/lib/api";

const run = promisify(execFile);
const SAFE = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_FILES_IN_TREE = 2000;

export function workRoot() {
  return process.env.AURA_WORK_ROOT?.trim() || join(tmpdir(), "aura-work");
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  HOME: tmpdir(),
  NODE_ENV: process.env.NODE_ENV,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "AURA",
  GIT_AUTHOR_EMAIL: "aura@localhost",
  GIT_COMMITTER_NAME: "AURA",
  GIT_COMMITTER_EMAIL: "aura@localhost",
});

export async function git(cwd: string, args: string[]) {
  try {
    const { stdout } = await run("git", args, { cwd, env: gitEnv(), timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new ApiError(`git ${args[0]} failed: ${(err.stderr || err.message).slice(0, 400)}`, 502);
  }
}

export interface Tree {
  dir: string;
  branch: string;
  baseSha: string;
}

/** Clone the product repo and check out `branch` (created from `base` if missing). */
export async function openTree(companyId: string, repoId: string, buildId: string, base: string, branch: string): Promise<Tree> {
  if (!SAFE.test(companyId) || !SAFE.test(buildId)) throw new ApiError("invalid id", 422);
  assertBranch(base);
  assertBranch(branch);
  const dir = join(workRoot(), companyId, buildId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  await git(dirname(dir), ["clone", "--quiet", bareDir(companyId, repoId), dir]);
  const remoteBranches = await git(dir, ["branch", "-r"]);
  if (remoteBranches.split("\n").some((b) => b.trim() === `origin/${branch}`)) await git(dir, ["checkout", "--quiet", "-B", branch, `origin/${branch}`]);
  else await git(dir, ["checkout", "--quiet", "-b", branch, `origin/${base}`]);
  const baseSha = await git(dir, ["rev-parse", `origin/${base}`]);
  return { dir, branch, baseSha };
}

export async function closeTree(t: Tree) {
  await rm(t.dir, { recursive: true, force: true });
}

function safePath(raw: string) {
  const p = normalizePath(raw);
  if (p.split("/").some((s) => s === ".git" || s === "node_modules")) throw new ApiError(`Path not allowed: ${p}`, 422);
  if (isProtected(p)) throw new ApiError(`${p} is a protected file (secrets/configuration)`, 422);
  return p;
}

export async function readTreeFile(t: Tree, raw: string): Promise<string | null> {
  const p = safePath(raw);
  try {
    const s = await stat(join(t.dir, p));
    if (s.size > MAX_FILE_BYTES) return `<<file too large to read: ${s.size} bytes>>`;
    return await readFile(join(t.dir, p), "utf8");
  } catch {
    return null;
  }
}

export async function writeTreeFile(t: Tree, raw: string, content: string) {
  const p = safePath(raw);
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new ApiError(`File exceeds ${MAX_FILE_BYTES / 1024} KB`, 422);
  await mkdir(dirname(join(t.dir, p)), { recursive: true });
  await writeFile(join(t.dir, p), content, "utf8");
  return p;
}

export async function deleteTreeFile(t: Tree, raw: string) {
  const p = safePath(raw);
  await rm(join(t.dir, p), { force: true });
  return p;
}

export async function listTree(t: Tree, sub = ""): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    if (out.length >= MAX_FILES_IN_TREE) return;
    for (const e of await readdir(join(t.dir, rel), { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === "data") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else out.push(r);
    }
  };
  const start = sub ? safePath(sub) : "";
  if (start && !existsSync(join(t.dir, start))) return [];
  await walk(start);
  return out.sort();
}

/** Files changed vs the base commit (working tree, including untracked). */
export async function changedFiles(t: Tree) {
  await git(t.dir, ["add", "-A"]);
  const out = await git(t.dir, ["diff", "--cached", "--name-status", t.baseSha]);
  return out ? out.split("\n").map((l) => { const [st, ...rest] = l.split("\t"); return { status: st, path: rest.join("\t") }; }) : [];
}

export async function diffText(t: Tree) {
  await git(t.dir, ["add", "-A"]);
  return (await git(t.dir, ["diff", "--cached", t.baseSha])).slice(0, 200_000);
}

/** Commit the working tree and push the branch to the product repo (non-forced). */
export async function commitAndPush(t: Tree, message: string) {
  await git(t.dir, ["add", "-A"]);
  const staged = await git(t.dir, ["diff", "--cached", "--name-only"]);
  if (!staged) return { sha: await git(t.dir, ["rev-parse", "HEAD"]), committed: false };
  await git(t.dir, ["commit", "--quiet", "-m", message.slice(0, 4000)]);
  await git(t.dir, ["push", "--quiet", "origin", t.branch]);
  return { sha: await git(t.dir, ["rev-parse", "HEAD"]), committed: true };
}
