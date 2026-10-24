/**
 * Journey 6: GitHub App connect → list repos → link → verified branch pushed
 * (real git push to a local bare "GitHub" remote) → PR opened once → PR status
 * → revoked credentials handled → disconnect. The GitHub REST API is a test
 * double that verifies the App JWT; plan entitlements are enforced.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { initRepo, commitFiles } from "@/lib/factory/git";
import { appJwt } from "./app";
import { connectInstallation, linkRepo, publishBranch, prStatus, repos, disconnect, installState, verifyInstallState } from "./service";
import { startGithubDouble, testKeyPair } from "../../../../test/doubles/github";

let user: string, ws: string, freeWs: string, productId: string, repoId: string, remote: string, gh: Awaited<ReturnType<typeof startGithubDouble>>;
const dirs: string[] = [];

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "aura-gh-"));
  dirs.push(root);
  process.env.AURA_GIT_ROOT = join(root, "git");
  remote = join(root, "remote.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const keys = testKeyPair();
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_SLUG = "aura-test";
  process.env.GITHUB_APP_PRIVATE_KEY = keys.privateKey;
  gh = await startGithubDouble({ publicKey: keys.publicKey, installationId: 777, account: "acme", repos: [{ full_name: "acme/scamscout", default_branch: "main", clone_url: remote }] });
  process.env.GITHUB_API_BASE = gh.url;
  const s = Date.now();
  user = (await prisma.user.create({ data: { email: `gh_${s}@t.local`, name: "G" } })).id;
  ws = (await createCompany({ name: "GH", mission: "m", industry: "SaaS", ownerId: user })).id;
  freeWs = (await createCompany({ name: "GH-FREE", mission: "m", industry: "SaaS", ownerId: user })).id;
  await prisma.subscription.create({ data: { companyId: ws, plan: "pro", status: "active" } });
  const repo = await prisma.repoConnection.create({ data: { companyId: ws, provider: "local", name: `p-${s}`, defaultBranch: "main" } });
  repoId = repo.id;
  await initRepo(ws, repo.id, "main", { "src/a.js": "1\n" });
  const p = await prisma.product.create({ data: { companyId: ws, title: "ScamScout", idea: "x", repoId: repo.id, createdById: user } });
  productId = p.id;
  await commitFiles({ companyId: ws, repoId: repo.id, base: "main", branch: "aura/release-1", files: { "src/a.js": "2\n" }, message: "verified" });
}, 60_000);

afterAll(async () => {
  await gh.close();
  for (const k of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE"]) delete process.env[k];
  await prisma.company.deleteMany({ where: { id: { in: [ws, freeWs] } } });
  if (user) await prisma.user.deleteMany({ where: { id: user } });
  await prisma.$disconnect();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("GitHub App integration", () => {
  it("install state is signed and bound to workspace + user", () => {
    const st = installState(ws, user);
    expect(verifyInstallState(st)).toEqual({ companyId: ws, userId: user });
    expect(verifyInstallState(st.replace(/.$/, "x"))).toBeNull();
    expect(verifyInstallState(installState(ws, user, Date.now() - 3600_000))).toBeNull();
    expect(appJwt().split(".")).toHaveLength(3);
  });

  it("free plan cannot connect GitHub (server-side entitlement)", async () => {
    await expect(connectInstallation(freeWs, "x", 777)).rejects.toThrow(/paid plans/);
  });

  it("connect → repos → link → push + PR (once) → status", async () => {
    await connectInstallation(ws, "owner@test", 777);
    expect((await repos(ws)).map((r) => r.fullName)).toEqual(["acme/scamscout"]);
    await expect(linkRepo(ws, productId, "owner@test", { fullName: "acme/other", mode: "publish" })).rejects.toThrow(/not accessible/);
    await linkRepo(ws, productId, "owner@test", { fullName: "acme/scamscout", mode: "publish" });
    const pr = await publishBranch(ws, productId, "aura/release-1", "Release 1", "body");
    expect(pr).toMatchObject({ number: 1, created: true });
    // Real git push reached the remote.
    expect(execFileSync("git", ["-C", remote, "show", "aura/release-1:src/a.js"]).toString()).toBe("2\n");
    const again = await publishBranch(ws, productId, "aura/release-1", "Release 1", "body");
    expect(again).toMatchObject({ number: 1, created: false });
    expect(gh.prs).toHaveLength(1);
    const st = await prStatus(ws, productId, 1);
    expect(st).toMatchObject({ state: "open", checks: [{ name: "ci", conclusion: "success" }] });
  }, 60_000);

  it("revoked installation → clear error, nothing pushed; disconnect", async () => {
    gh.revoke();
    await expect(publishBranch(ws, productId, "aura/release-1", "R", "b")).rejects.toThrow(/not found|revoked|accessible/i);
    const inst = await prisma.githubInstallation.findFirst({ where: { companyId: ws } });
    expect((await disconnect(ws, "owner@test", inst!.id)).status).toBe("REVOKED");
    await expect(repos(ws)).rejects.toThrow(/not connected/);
  });
});
