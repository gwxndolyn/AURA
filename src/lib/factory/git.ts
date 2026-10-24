/**
 * Source-control provider layer.
 *
 * `local` is a REAL git repository (bare repo + throwaway clones) on the AURA
 * server, driven with the git CLI via execFile (no shell; arguments are never
 * interpolated into a command string). Every product gets one; verified work
 * is committed to an isolated branch per task, never to the default branch.
 *
 * `github` / `gitlab` publish a local branch to the connected remote and open
 * a pull/merge request through the provider's REST API. Credentials are read
 * from a server environment variable whose NAME is stored on the connection
 * (the token itself is never stored, logged or sent to the browser). The token
 * is passed to git through GIT_CONFIG_* environment entries, not argv/URLs.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { normalizePath } from "@/lib/devspace/paths";
import { ApiError } from "@/lib/api";

const run = promisify(execFile);

export const PROVIDERS = ["local", "github", "gitlab"] as const;
export type Provider = (typeof PROVIDERS)[number];

export class GitError extends ApiError {
  constructor(message: string, status = 502) {
    super(message, status);
    this.name = "GitError";
  }
}

/** Root for AURA-managed repositories. Set AURA_GIT_ROOT to a durable disk in production. */
export function gitRoot() {
  return process.env.AURA_GIT_ROOT?.trim() || join(tmpdir(), "aura-git");
}

const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/;

export function assertBranch(b: string) {
  if (!SAFE_BRANCH.test(b) || b.includes("..") || b.endsWith("/") || b.endsWith(".lock")) throw new GitError(`Invalid branch name: ${b}`, 422);
  return b;
}

export function bareDir(companyId: string, repoId: string) {
  if (!SAFE_ID.test(companyId) || !SAFE_ID.test(repoId)) throw new GitError("Invalid repository id", 422);
  return join(gitRoot(), companyId, `${repoId}.git`);
}

/** Minimal, isolated git environment: no user/system config, no prompts, fixed identity. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "AURA",
    GIT_AUTHOR_EMAIL: "aura@localhost",
    GIT_COMMITTER_NAME: "AURA",
    GIT_COMMITTER_EMAIL: "aura@localhost",
    ...extra,
  };
}

async function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const { stdout } = await run("git", args, { cwd, env: gitEnv(extraEnv), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    // Never echo credentials: strip anything that looks like an auth header or token.
    const msg = (err.stderr || err.message).replace(/(authorization:|private-token:|x-access-token:)[^\n]*/gi, "$1 [redacted]").slice(0, 600);
    throw new GitError(`git ${args[0]} failed: ${msg}`);
  }
}

async function withClone<T>(bare: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aura-wt-"));
  try {
    await git(tmpdir(), ["clone", "--quiet", bare, dir]);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeTree(dir: string, files: Record<string, string>) {
  for (const [raw, content] of Object.entries(files)) {
    const p = normalizePath(raw); // rejects traversal, absolute paths, .git/
    if (p.split("/").includes(".git")) throw new GitError(`Refusing to write inside .git: ${p}`, 422);
    const abs = join(dir, p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

/** Create the bare repository with an initial commit on `branch`. Idempotent. */
export async function initRepo(companyId: string, repoId: string, branch: string, files: Record<string, string>) {
  assertBranch(branch);
  const bare = bareDir(companyId, repoId);
  if (existsSync(join(bare, "HEAD"))) return { created: false, sha: await headSha(companyId, repoId, branch) };
  await mkdir(bare, { recursive: true });
  await git(bare, ["init", "--quiet", "--bare", `--initial-branch=${branch}`]);
  const sha = await withClone(bare, async (dir) => {
    await git(dir, ["checkout", "--quiet", "-b", branch]);
    await writeTree(dir, { "README.md": "# Project\n\nManaged by AURA.\n", ...files });
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "--quiet", "-m", "Initial import"]);
    await git(dir, ["push", "--quiet", "origin", branch]);
    return git(dir, ["rev-parse", "HEAD"]);
  });
  return { created: true, sha };
}

export async function headSha(companyId: string, repoId: string, branch: string): Promise<string | null> {
  assertBranch(branch);
  try {
    return await git(bareDir(companyId, repoId), ["rev-parse", `refs/heads/${branch}`]);
  } catch {
    return null;
  }
}

export async function listBranches(companyId: string, repoId: string) {
  const out = await git(bareDir(companyId, repoId), ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]);
  return out ? out.split("\n").map((l) => { const [name, sha] = l.split(" "); return { name, sha }; }) : [];
}

/** `git archive` of a ref as a gzipped tarball (bounded to 50 MB). */
export async function archive(companyId: string, repoId: string, ref: string): Promise<Buffer> {
  assertBranch(ref);
  const { stdout } = await promisify(execFile)("git", ["archive", "--format=tar.gz", `--prefix=project/`, `refs/heads/${ref}`], { cwd: bareDir(companyId, repoId), env: gitEnv(), encoding: "buffer", maxBuffer: 50 * 1024 * 1024, timeout: 60_000 }).catch(() => {
    throw new GitError(`Branch ${ref} not found`, 404);
  });
  return stdout as unknown as Buffer;
}

export async function listFiles(companyId: string, repoId: string, ref: string): Promise<string[]> {
  try {
    const out = await git(bareDir(companyId, repoId), ["ls-tree", "-r", "--name-only", ref]);
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
}

export async function readAt(companyId: string, repoId: string, ref: string, path: string): Promise<string | null> {
  const p = normalizePath(path);
  try {
    return await git(bareDir(companyId, repoId), ["show", `${ref}:${p}`]);
  } catch {
    return null;
  }
}

/**
 * Commit files to `branch` (created from `base` if missing). Safety:
 *  - `expectBaseSha` (when given) must still be the head of `base`; otherwise
 *    the base moved and nothing is committed (caller decides how to reconcile)
 *  - an existing branch is only fast-forwarded, never rewritten
 *  - an unchanged tree produces no commit (idempotent re-runs)
 */
export async function commitFiles(args: { companyId: string; repoId: string; base: string; branch: string; files: Record<string, string>; message: string; expectBaseSha?: string }) {
  assertBranch(args.base);
  assertBranch(args.branch);
  const bare = bareDir(args.companyId, args.repoId);
  const baseHead = await headSha(args.companyId, args.repoId, args.base);
  if (!baseHead) throw new GitError(`Base branch ${args.base} does not exist`, 409);
  if (args.expectBaseSha && args.expectBaseSha !== baseHead) {
    return { status: "BASE_MOVED" as const, baseHead, sha: null as string | null, changed: [] as string[] };
  }
  return withClone(bare, async (dir) => {
    const exists = await headSha(args.companyId, args.repoId, args.branch);
    await git(dir, ["checkout", "--quiet", "-B", args.branch, exists ? `origin/${args.branch}` : `origin/${args.base}`]);
    await writeTree(dir, args.files);
    await git(dir, ["add", "-A"]);
    const changed = (await git(dir, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
    if (!changed.length) return { status: "UNCHANGED" as const, baseHead, sha: exists, changed };
    await git(dir, ["commit", "--quiet", "-m", args.message.slice(0, 2000)]);
    await git(dir, ["push", "--quiet", "origin", args.branch]); // non-forced: a diverged branch is rejected
    return { status: "COMMITTED" as const, baseHead, sha: await git(dir, ["rev-parse", "HEAD"]), changed };
  });
}

/**
 * Revert AURA's own commits on `branch` (those in base..branch authored by
 * aura@localhost), newest first, as NEW commits — history is never rewritten
 * and nothing is force-pushed. Commits by anyone else on the branch are kept.
 * If a revert conflicts with someone else's later change, everything is
 * aborted and nothing is pushed (the caller reports the conflict).
 */
export async function revertAuraCommits(args: { companyId: string; repoId: string; base: string; branch: string; message: string }) {
  assertBranch(args.base);
  assertBranch(args.branch);
  const bare = bareDir(args.companyId, args.repoId);
  if (!(await headSha(args.companyId, args.repoId, args.branch))) throw new GitError(`Branch ${args.branch} not found`, 404);
  return withClone(bare, async (dir) => {
    await git(dir, ["checkout", "--quiet", "-B", args.branch, `origin/${args.branch}`]);
    const log = await git(dir, ["log", "--format=%H %ae %s", `origin/${args.base}..HEAD`]);
    const all = log ? log.split("\n").map((l) => { const [sha, email, ...rest] = l.split(" "); return { sha, email, subject: rest.join(" ") }; }) : [];
    const ours = all.filter((c) => c.email === "aura@localhost" && !/^Revert "/.test(c.subject));
    const kept = all.filter((c) => c.email !== "aura@localhost");
    if (!ours.length) return { status: "NOTHING" as const, reverted: [] as string[], kept: kept.map((k) => k.sha), sha: await git(dir, ["rev-parse", "HEAD"]) };
    try {
      for (const c of ours) await git(dir, ["revert", "--no-edit", "--no-commit", c.sha]);
    } catch (e) {
      await git(dir, ["revert", "--abort"]).catch(() => git(dir, ["reset", "--hard", "--quiet", "HEAD"]));
      return { status: "CONFLICT" as const, reverted: [], kept: kept.map((k) => k.sha), sha: null, detail: (e as Error).message.slice(0, 300) };
    }
    const staged = await git(dir, ["diff", "--cached", "--name-only"]);
    if (!staged) return { status: "NOTHING" as const, reverted: [], kept: kept.map((k) => k.sha), sha: await git(dir, ["rev-parse", "HEAD"]) };
    await git(dir, ["commit", "--quiet", "-m", `${args.message.slice(0, 1500)}\n\nReverts: ${ours.map((c) => c.sha.slice(0, 10)).join(", ")}`]);
    await git(dir, ["push", "--quiet", "origin", args.branch]); // non-forced
    return { status: "REVERTED" as const, reverted: ours.map((c) => c.sha), kept: kept.map((k) => k.sha), sha: await git(dir, ["rev-parse", "HEAD"]), files: staged.split("\n") };
  });
}

export async function branchDiff(companyId: string, repoId: string, base: string, branch: string) {
  assertBranch(base);
  assertBranch(branch);
  const bare = bareDir(companyId, repoId);
  const stat = await git(bare, ["diff", "--stat", `${base}...${branch}`]);
  const patch = await git(bare, ["diff", `${base}...${branch}`]);
  const log = await git(bare, ["log", "--format=%H %s", `${base}..${branch}`]);
  return { stat, patch: patch.slice(0, 64 * 1024), commits: log ? log.split("\n").map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })) : [] };
}

// ---------------------------------------------------------------------------
// Remote providers
// ---------------------------------------------------------------------------

export interface RemoteConfig {
  provider: Provider;
  name: string; // owner/repo (github) or group/project (gitlab)
  remoteUrl: string | null; // https clone URL; for tests a local bare path is allowed
  credentialEnv: string | null;
  apiBase?: string; // override for GitHub Enterprise / self-managed GitLab
}

export function credential(cfg: RemoteConfig): string | null {
  if (!cfg.credentialEnv || !/^[A-Z][A-Z0-9_]{2,63}$/.test(cfg.credentialEnv)) return null;
  const v = process.env[cfg.credentialEnv];
  return v && v.trim() ? v.trim() : null;
}

/** What is configured, without revealing secrets. */
export function remoteStatus(cfg: RemoteConfig) {
  if (cfg.provider === "local") return { configured: true, missing: [] as string[] };
  const missing: string[] = [];
  if (!cfg.remoteUrl) missing.push("remote URL");
  if (!cfg.credentialEnv) missing.push("credential env var name");
  else if (!credential(cfg)) missing.push(`server env var ${cfg.credentialEnv} is not set`);
  return { configured: missing.length === 0, missing };
}

/** Push a local branch to the remote. The token travels in an HTTP header via env, never argv. */
export async function pushBranch(companyId: string, repoId: string, branch: string, cfg: RemoteConfig) {
  assertBranch(branch);
  const st = remoteStatus(cfg);
  if (!st.configured) throw new GitError(`Remote not configured: ${st.missing.join(", ")}`, 412);
  const url = cfg.remoteUrl!;
  const isHttps = /^https:\/\//.test(url);
  if (!isHttps && !(process.env.NODE_ENV === "test" && url.startsWith("/"))) throw new GitError("Only https remotes are supported", 422);
  const token = credential(cfg)!;
  const header = cfg.provider === "gitlab" ? `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}` : `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const env: Record<string, string> = isHttps ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: header } : {};
  await git(bareDir(companyId, repoId), ["push", "--quiet", url, `refs/heads/${branch}:refs/heads/${branch}`], env);
  return { pushed: true, branch };
}

/** Auth header env for an https remote; the token never appears in argv, URLs or logs. */
function tokenEnv(token: string, provider: "github" | "gitlab"): Record<string, string> {
  const basic = Buffer.from(`${provider === "gitlab" ? "oauth2" : "x-access-token"}:${token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

function assertRemoteUrl(url: string) {
  if (/^https:\/\//.test(url)) return;
  if (process.env.NODE_ENV === "test" && url.startsWith("/")) return; // local bare remotes in automated tests
  throw new GitError("Only https remotes are supported", 422);
}

/** Push a branch with a short-lived token (GitHub App installation token). Non-forced. */
export async function pushWithToken(companyId: string, repoId: string, branch: string, remoteUrl: string, token: string, provider: "github" | "gitlab" = "github") {
  assertBranch(branch);
  assertRemoteUrl(remoteUrl);
  await git(bareDir(companyId, repoId), ["push", "--quiet", remoteUrl, `refs/heads/${branch}:refs/heads/${branch}`], remoteUrl.startsWith("https://") ? tokenEnv(token, provider) : {});
  return { pushed: true, branch };
}

/**
 * Import an existing repository: mirror its default branch into AURA's local
 * bare repo (the working repository agents use). Idempotent; refuses if the
 * local repo already has history.
 */
export async function importRemote(companyId: string, repoId: string, remoteUrl: string, branch: string, token: string | null, provider: "github" | "gitlab" = "github") {
  assertBranch(branch);
  assertRemoteUrl(remoteUrl);
  const bare = bareDir(companyId, repoId);
  if (existsSync(join(bare, "HEAD"))) throw new GitError("This product already has a repository", 409);
  await mkdir(bare, { recursive: true });
  await git(bare, ["init", "--quiet", "--bare", `--initial-branch=${branch}`]);
  await git(bare, ["fetch", "--quiet", "--depth=200", remoteUrl, `refs/heads/${branch}:refs/heads/${branch}`], token && remoteUrl.startsWith("https://") ? tokenEnv(token, provider) : {});
  return { sha: await headSha(companyId, repoId, branch) };
}

type Fetch = typeof fetch;

/** Open a pull request (GitHub) or merge request (GitLab). Idempotent per head branch. */
export async function openChangeRequest(cfg: RemoteConfig, args: { head: string; base: string; title: string; body: string }, f: Fetch = fetch) {
  assertBranch(args.head);
  assertBranch(args.base);
  const token = credential(cfg);
  if (!token) throw new GitError(`Remote not configured: credential env var ${cfg.credentialEnv ?? "(unset)"} is not set`, 412);
  if (cfg.provider === "github") {
    const api = cfg.apiBase ?? "https://api.github.com";
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
    const [owner] = cfg.name.split("/");
    const existing = await f(`${api}/repos/${cfg.name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${args.head}`)}`, { headers });
    if (existing.ok) {
      const list = (await existing.json()) as { number: number; html_url: string }[];
      if (list.length) return { number: list[0].number, url: list[0].html_url, created: false };
    }
    const r = await f(`${api}/repos/${cfg.name}/pulls`, { method: "POST", headers, body: JSON.stringify({ title: args.title, head: args.head, base: args.base, body: args.body }) });
    if (!r.ok) throw new GitError(`GitHub refused the pull request (${r.status})`, r.status === 422 ? 409 : 502);
    const pr = (await r.json()) as { number: number; html_url: string };
    return { number: pr.number, url: pr.html_url, created: true };
  }
  if (cfg.provider === "gitlab") {
    const api = cfg.apiBase ?? "https://gitlab.com/api/v4";
    const id = encodeURIComponent(cfg.name);
    const headers = { "PRIVATE-TOKEN": token, "Content-Type": "application/json" };
    const existing = await f(`${api}/projects/${id}/merge_requests?state=opened&source_branch=${encodeURIComponent(args.head)}`, { headers });
    if (existing.ok) {
      const list = (await existing.json()) as { iid: number; web_url: string }[];
      if (list.length) return { number: list[0].iid, url: list[0].web_url, created: false };
    }
    const r = await f(`${api}/projects/${id}/merge_requests`, { method: "POST", headers, body: JSON.stringify({ source_branch: args.head, target_branch: args.base, title: args.title, description: args.body }) });
    if (!r.ok) throw new GitError(`GitLab refused the merge request (${r.status})`, 502);
    const mr = (await r.json()) as { iid: number; web_url: string };
    return { number: mr.iid, url: mr.web_url, created: true };
  }
  throw new GitError("The local provider has no change requests; connect GitHub or GitLab", 422);
}

/** Detect language/framework/test command from repository files (pure). */
export function detectProject(files: Record<string, string>) {
  const paths = Object.keys(files);
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
  try {
    pkg = files["package.json"] ? JSON.parse(files["package.json"]) : null;
  } catch {
    pkg = null;
  }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const js = paths.some((p) => /\.(c|m)?jsx?$/.test(p));
  const ts = paths.some((p) => /\.tsx?$/.test(p));
  const py = paths.some((p) => p.endsWith(".py"));
  const framework = deps.next ? "Next.js" : deps.react ? "React" : deps.express ? "Express" : py && paths.some((p) => /manage\.py$/.test(p)) ? "Django" : null;
  const packageManager = paths.includes("pnpm-lock.yaml") ? "pnpm" : paths.includes("yarn.lock") ? "yarn" : pkg ? "npm" : py ? "pip" : null;
  const testCommand = pkg?.scripts?.test ? `${packageManager ?? "npm"} test` : paths.some((p) => /\.test\.(c|m)?js$/.test(p)) ? "node --test" : py ? "pytest" : null;
  return { language: ts ? "TypeScript" : js ? "JavaScript" : py ? "Python" : "unknown", framework, packageManager, testCommand, files: paths.length };
}

/** Read a file from a clone-free bare repo — helper used by tests. */
export async function readBareFile(path: string) {
  return readFile(path, "utf8");
}
