/**
 * GitHub App integration (preferred for production): fine-grained,
 * repository-scoped installations; short-lived installation tokens minted per
 * operation from the App's private key. Nothing secret is stored in the DB.
 *
 * Configure: GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY (PEM, \n
 * escaped allowed). Required App permissions: Contents (read & write), Pull
 * requests (read & write), Metadata (read), Checks (read). GITHUB_API_BASE
 * may point at GitHub Enterprise (or a test double in automated tests only).
 */
import { createSign } from "node:crypto";
import { ApiError } from "@/lib/api";

const API = () => process.env.GITHUB_API_BASE || "https://api.github.com";

export function githubAppConfigured() {
  const missing = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY"].filter((k) => !process.env[k]);
  return { configured: missing.length === 0, missing, installUrl: process.env.GITHUB_APP_SLUG ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new` : null };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** RS256 JWT identifying the App (valid ≤10 min per GitHub's rules). */
export function appJwt(now = Math.floor(Date.now() / 1000)) {
  const id = process.env.GITHUB_APP_ID;
  const key = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!id || !key) throw new ApiError("GitHub App is not configured on this server", 503);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64url(sig)}`;
}

export class GithubError extends ApiError {
  constructor(message: string, status: number, public kind: "auth" | "not_found" | "rate_limited" | "permission" | "conflict" | "unavailable") {
    super(message, status);
  }
}

export async function gh<T>(path: string, init: { method?: string; token: string; body?: unknown }): Promise<T> {
  const r = await fetch(`${API()}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${init.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "AURA", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const json = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (r.ok) return json;
  const msg = json.message ?? `GitHub returned ${r.status}`;
  if (r.status === 401) throw new GithubError("GitHub rejected the credentials — the installation may have been revoked", 401, "auth");
  if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") throw new GithubError(`GitHub rate limit reached; resets at ${new Date(Number(r.headers.get("x-ratelimit-reset")) * 1000).toISOString()}`, 429, "rate_limited");
  if (r.status === 403) throw new GithubError(`GitHub denied the request: ${msg} (check the App's repository permissions)`, 403, "permission");
  if (r.status === 404) throw new GithubError("Repository or resource not found, or not accessible to this installation", 404, "not_found");
  if (r.status === 409 || r.status === 422) throw new GithubError(`GitHub refused: ${msg}`, 409, "conflict");
  throw new GithubError(`GitHub unavailable: ${msg}`, 502, "unavailable");
}

/** Short-lived installation token (≈1h). Never persisted. */
export async function installationToken(installationId: number) {
  const r = await gh<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, { method: "POST", token: appJwt() });
  return r.token;
}

export async function installationAccount(installationId: number) {
  const r = await gh<{ account: { login: string } }>(`/app/installations/${installationId}`, { token: appJwt() });
  return r.account.login;
}

export async function listInstallationRepos(installationId: number) {
  const token = await installationToken(installationId);
  const r = await gh<{ repositories: { full_name: string; default_branch: string; private: boolean; clone_url: string }[] }>(`/installation/repositories?per_page=100`, { token });
  return r.repositories.map((x) => ({ fullName: x.full_name, defaultBranch: x.default_branch, private: x.private, cloneUrl: x.clone_url }));
}

export async function openPullRequest(installationId: number, repo: string, args: { head: string; base: string; title: string; body: string }) {
  const token = await installationToken(installationId);
  const [owner] = repo.split("/");
  const existing = await gh<{ number: number; html_url: string; state: string }[]>(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${args.head}`)}`, { token });
  if (existing.length) return { number: existing[0].number, url: existing[0].html_url, created: false };
  const pr = await gh<{ number: number; html_url: string }>(`/repos/${repo}/pulls`, { method: "POST", token, body: args });
  return { number: pr.number, url: pr.html_url, created: true };
}

export async function pullRequestStatus(installationId: number, repo: string, number: number) {
  const token = await installationToken(installationId);
  const pr = await gh<{ state: string; merged: boolean; mergeable_state?: string; html_url: string; head: { sha: string } }>(`/repos/${repo}/pulls/${number}`, { token });
  const checks = await gh<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(`/repos/${repo}/commits/${pr.head.sha}/check-runs`, { token }).catch(() => ({ check_runs: [] }));
  return { state: pr.merged ? "merged" : pr.state, mergeable: pr.mergeable_state ?? null, url: pr.html_url, checks: checks.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })) };
}
