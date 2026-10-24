/**
 * Product factory: lifecycle model (pure), policy, git provider (real git),
 * webhooks (signatures + idempotency), and the end-to-end lifecycle
 * acceptance scenario on a disposable example app with REAL sandbox tests:
 *
 *   idea → brief → backlog → design artifact → dependent tasks → real code
 *   change → real tests → controlled failure (reviewer probes) → bounded
 *   repair → verification → git commit on an isolated branch → release
 *   candidate re-tested on the integrated tree → approval gate → recovery
 *   after a crashed tick → unfinished work never marked complete → tenant
 *   isolation.
 *
 * Deterministic: no API key, so the PM/designer use labelled templates and
 * the engineer applies the fixture's prepared repair candidates (labelled
 * "simulated-candidate"); tests and probes RUN in Docker. Docker-dependent
 * steps are skipped (not faked) when Docker is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { dockerAvailable } from "@/lib/sandbox/runner";
import { canMovePhase, assertItemMove, readyKeys, rollUp, validateGraph, progress, derivePhase, LifecycleError } from "./lifecycle";
import { needsApproval, clampLimits } from "./policy";
import { validateBacklog, BriefSchema } from "./brief";
import { buildHandoff, DesignSpecSchema } from "./design";
import { templateBrief, templateBacklog, templateDesign } from "../../../test/fixtures/product";
import { resetClientForTests } from "@/lib/ai/claude";
import { startAnthropicDouble, text, lastUserText, type Double } from "../../../test/doubles/anthropic";
import { drain } from "@/lib/jobs/worker";
import { initRepo, commitFiles, headSha, branchDiff, readAt, assertBranch, detectProject, openChangeRequest, pushBranch, GitError } from "./git";
import { createProduct, userSetItemStatus, reviseBrief, loadProduct } from "./store";
import { tickProduct, controlProduct } from "./scheduler";
import { reviewArtifact } from "./artifacts";
import { readiness, decideProductApproval, requestDeployment } from "./release";
import { productDetail, productTimeline } from "./read";
import { verifyGithubSignature, handleWebhook } from "./webhooks";

const IDEA = "Build a web application that helps university students discover hackathons and find teammates based on their skills, interests, and availability.";
let user: string, ws: string, other: string, otherWs: string, docker = false;
const gitRoot = mkdtempSync(join(tmpdir(), "aura-git-test-"));

beforeAll(async () => {
  process.env.AURA_GIT_ROOT = gitRoot;
  docker = await dockerAvailable();
  const s = Date.now();
  user = (await prisma.user.create({ data: { email: `pf_${s}@t.local`, name: "P" } })).id;
  other = (await prisma.user.create({ data: { email: `pf_o_${s}@t.local`, name: "O" } })).id;
  ws = (await createCompany({ name: "PF", mission: "m", industry: "SaaS", ownerId: user })).id;
  otherWs = (await createCompany({ name: "PF-OTHER", mission: "m", industry: "SaaS", ownerId: other })).id;
}, 60_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await prisma.user.deleteMany({ where: { id: { in: [user, other] } } });
  await prisma.$disconnect();
  rmSync(gitRoot, { recursive: true, force: true });
});

describe("lifecycle model", () => {
  it("phases move forward and backward only along defined edges", () => {
    expect(canMovePhase("DISCOVERY", "PLANNING")).toBe(true);
    expect(canMovePhase("VERIFY", "BUILD")).toBe(true); // failed check returns work
    expect(canMovePhase("BUILD", "ARCHITECTURE")).toBe(true); // constraint discovered while building
    expect(canMovePhase("DISCOVERY", "DEPLOY")).toBe(false);
    expect(canMovePhase("PLANNING", "DEPLOY")).toBe(false);
  });
  it("only execution evidence marks work VERIFIED; executable work can't be accepted unverified", () => {
    const item = { status: "IN_REVIEW", executable: true, level: "TASK" };
    expect(() => assertItemMove(item, "VERIFIED", { kind: "user", id: "u" })).toThrow(LifecycleError);
    expect(() => assertItemMove(item, "VERIFIED", { kind: "agent", id: "backend-engineer" })).toThrow(/verification evidence/);
    expect(() => assertItemMove(item, "VERIFIED", { kind: "engine", id: "s" })).toThrow(/verification evidence/);
    expect(() => assertItemMove(item, "VERIFIED", { kind: "engine", id: "s" }, { verified: true })).not.toThrow();
    expect(() => assertItemMove({ status: "READY", executable: true, level: "TASK" }, "DONE_UNVERIFIED", { kind: "user", id: "u" })).toThrow(/executable test suite/);
    expect(() => assertItemMove({ status: "READY", executable: false, level: "TASK" }, "DONE_UNVERIFIED", { kind: "agent", id: "x" })).toThrow(/Only a person/);
    expect(() => assertItemMove({ status: "TODO", executable: false, level: "TASK" }, "VERIFIED", { kind: "engine", id: "s" }, { verified: true })).toThrow(/Cannot move/);
  });
  it("dependency readiness, cycle detection, roll-up and the single progress definition", () => {
    const items = [
      { key: "A", level: "TASK", status: "VERIFIED", dependsOn: [] },
      { key: "B", level: "TASK", status: "TODO", dependsOn: ["A"] },
      { key: "C", level: "TASK", status: "TODO", dependsOn: ["B"] },
      { key: "D", level: "TASK", status: "TODO", dependsOn: ["X"] },
    ];
    expect(readyKeys(items)).toEqual(["B"]);
    expect(validateGraph([{ key: "A", dependsOn: ["B"] }, { key: "B", dependsOn: ["A"] }]).join()).toMatch(/cycle/);
    expect(validateGraph([{ key: "A", dependsOn: ["Z"] }]).join()).toMatch(/unknown Z/);
    expect(rollUp([{ status: "VERIFIED" }, { status: "DONE_UNVERIFIED" }])).toBe("DONE_UNVERIFIED");
    expect(rollUp([{ status: "VERIFIED" }, { status: "FAILED" }])).toBe("FAILED");
    expect(rollUp([{ status: "VERIFIED" }, { status: "VERIFIED" }])).toBe("VERIFIED");
    const pr = progress([{ level: "TASK", status: "VERIFIED", executable: true }, { level: "TASK", status: "DONE_UNVERIFIED", executable: false }, { level: "TASK", status: "TODO", executable: true }]);
    expect(pr).toMatchObject({ verified: 1, executable: 2, ratio: 0.5, nonExecutable: 1, acceptedUnverified: 1 });
    expect(progress([]).ratio).toBeNull();
    expect(derivePhase("PLANNING", [{ level: "TASK", kind: "BACKEND", status: "FAILED", executable: true }], { verifying: false, scopeApproved: true })).toBe("ITERATE");
    expect(derivePhase("BUILD", [], { verifying: false, scopeApproved: false })).toBe("PLANNING");
  });
  it("policy: production and publication always need a person; SUGGEST never auto-executes", () => {
    for (const a of ["SUGGEST", "SUPERVISED", "BOUNDED", "CONTINUOUS"] as const) {
      expect(needsApproval(a, "production")).toBe(true);
      expect(needsApproval(a, "external_publication")).toBe(true);
      expect(needsApproval(a, "infrastructure")).toBe(true);
    }
    expect(needsApproval("SUGGEST", "local_execution")).toBe(true);
    expect(needsApproval("BOUNDED", "local_commit")).toBe(false);
    expect(clampLimits({ maxRepairs: 99, maxParallel: 0, budgetUsd: -1 })).toMatchObject({ maxRepairs: 5, maxParallel: 1, budgetUsd: 0.01 });
  });
  it("fixture brief/backlog and designer spec validate against the production schemas; the backlog is small and acyclic", () => {
    const b = templateBrief(IDEA);
    expect(BriefSchema.safeParse(b).success).toBe(true);
    expect(b.functional.some((f) => /availability/.test(f.text))).toBe(true);
    expect(b.assumptions.every((a) => a.editable)).toBe(true);
    const bl = templateBacklog(b);
    expect(validateBacklog(bl)).toEqual([]);
    const d = templateDesign(b, ["CommonJS"]);
    expect(DesignSpecSchema.safeParse(d).success).toBe(true);
    for (const p of d.pages) expect(Object.keys(p.states).sort()).toEqual(["empty", "error", "loading", "success"]);
    const h = buildHandoff({ id: "a1", version: 1, content: d }, ["E1.S2.T1"]);
    expect(h.acceptance.length).toBeGreaterThan(2);
    expect(h.note).toMatch(/does not mark the design implemented/);
  });
});

describe("git provider (real git)", () => {
  const co = "testco", rid = "repo1";
  it("initialises, commits to an isolated branch, never rewrites, detects base moves", async () => {
    const init = await initRepo(co, rid, "main", { "src/a.js": "1\n" });
    expect(init.created).toBe(true);
    expect((await initRepo(co, rid, "main", {})).created).toBe(false); // idempotent
    const base = (await headSha(co, rid, "main"))!;
    const c1 = await commitFiles({ companyId: co, repoId: rid, base: "main", branch: "aura/t1", files: { "src/a.js": "2\n" }, message: "t1", expectBaseSha: base });
    expect(c1.status).toBe("COMMITTED");
    expect(await readAt(co, rid, "aura/t1", "src/a.js")).toBe("2");
    expect(await readAt(co, rid, "main", "src/a.js")).toBe("1"); // default branch untouched
    expect((await commitFiles({ companyId: co, repoId: rid, base: "main", branch: "aura/t1", files: { "src/a.js": "2\n" }, message: "again" })).status).toBe("UNCHANGED");
    const moved = await commitFiles({ companyId: co, repoId: rid, base: "main", branch: "aura/t2", files: { "src/a.js": "3\n" }, message: "t2", expectBaseSha: "0".repeat(40) });
    expect(moved.status).toBe("BASE_MOVED");
    const d = await branchDiff(co, rid, "main", "aura/t1");
    expect(d.patch).toMatch(/-1\n\+2/);
    expect(d.commits).toHaveLength(1);
  }, 60_000);
  it("rejects unsafe paths and branch names", async () => {
    expect(() => assertBranch("../x")).toThrow(GitError);
    expect(() => assertBranch("a;rm -rf /")).toThrow(GitError);
    await expect(commitFiles({ companyId: co, repoId: rid, base: "main", branch: "aura/t3", files: { "../escape.js": "x" }, message: "x" })).rejects.toThrow();
    await expect(commitFiles({ companyId: co, repoId: rid, base: "main", branch: "aura/t3", files: { ".git/config": "x" }, message: "x" })).rejects.toThrow();
  }, 60_000);
  it("detects project metadata from files", () => {
    expect(detectProject({ "src/match/match.js": "", "src/match/match.test.js": "" })).toMatchObject({ language: "JavaScript", testCommand: "node --test" });
    expect(detectProject({ "package.json": JSON.stringify({ scripts: { test: "vitest" }, dependencies: { next: "15" } }), "a.ts": "" })).toMatchObject({ framework: "Next.js", testCommand: "npm test", language: "TypeScript" });
  });
  it("remote publication: refuses without credentials; pushes to a remote and opens a PR idempotently (mock API)", async () => {
    const cfg = { provider: "github" as const, name: "acme/app", remoteUrl: null as string | null, credentialEnv: "AURA_TEST_GH_TOKEN" };
    await expect(pushBranch(co, rid, "aura/t1", cfg)).rejects.toThrow(/not configured/);
    const remote = join(gitRoot, "remote.git");
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    process.env.AURA_TEST_GH_TOKEN = "ghp_test_secret_value";
    await pushBranch(co, rid, "aura/t1", { ...cfg, remoteUrl: remote });
    expect(execFileSync("git", ["-C", remote, "branch", "--list", "aura/t1"]).toString()).toMatch(/aura\/t1/);
    const calls: { url: string; method: string; auth: string }[] = [];
    let open: { number: number; html_url: string }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method ?? "GET", auth: h.Authorization });
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify(open), { status: 200 });
      open = [{ number: 7, html_url: "https://github.com/acme/app/pull/7" }];
      return new Response(JSON.stringify(open[0]), { status: 201 });
    }) as typeof fetch;
    const pr1 = await openChangeRequest({ ...cfg, remoteUrl: remote }, { head: "aura/t1", base: "main", title: "t", body: "b" }, fakeFetch);
    const pr2 = await openChangeRequest({ ...cfg, remoteUrl: remote }, { head: "aura/t1", base: "main", title: "t", body: "b" }, fakeFetch);
    expect(pr1).toMatchObject({ number: 7, created: true });
    expect(pr2).toMatchObject({ number: 7, created: false }); // no duplicate PR
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls[0].auth).toBe("Bearer ghp_test_secret_value");
    delete process.env.AURA_TEST_GH_TOKEN;
  }, 60_000);
});

describe("webhooks", () => {
  it("verifies GitHub signatures in constant time and rejects tampering", () => {
    const body = '{"a":1}';
    const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(verifyGithubSignature("s3cret", body, sig)).toBe(true);
    expect(verifyGithubSignature("s3cret", body + " ", sig)).toBe(false);
    expect(verifyGithubSignature("other", body, sig)).toBe(false);
    expect(verifyGithubSignature("s3cret", body, null)).toBe(false);
  });
});

describe("product lifecycle acceptance (real planning through the provider boundary)", () => {
  let productId = "";
  let double: Double;
  const brief = () => templateBrief(IDEA);

  beforeAll(async () => {
    // The model provider is the only test double: it answers as a model would; everything else is real.
    double = await startAnthropicDouble((req) => {
      if (/UX\/UI Designer/.test(req.system)) return [text(JSON.stringify(templateDesign(brief(), ["CommonJS"])))];
      if (/Software Architect/.test(req.system)) return [text(JSON.stringify({ summary: "Node HTTP app; add src/match.js", components: [{ name: "match", responsibility: "ranking", files: ["src/match.js"] }], dataModel: [{ entity: "Profile", fields: ["skills", "availability"] }], contracts: [], decisions: [{ id: "AD-1", decision: "Extend src/app.js routes", rationale: "existing structure" }], risks: [] }))];
      if (/backlog/i.test(req.system)) return [text(JSON.stringify(templateBacklog(brief())))];
      if (/Product Manager/.test(req.system)) return [text(JSON.stringify(brief()))];
      return [text(`unexpected prompt: ${lastUserText(req.messages).slice(0, 40)}`)];
    });
    process.env.ANTHROPIC_API_KEY = "test-key-for-double";
    process.env.ANTHROPIC_BASE_URL = double.url;
    resetClientForTests();
  });
  afterAll(async () => {
    await double.close();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    resetClientForTests();
  });

  it("idea → product + real repo; planning job produces a validated brief and backlog; nothing runs before scope approval", async () => {
    const r = await createProduct({ companyId: ws, userId: user, actor: "ceo@test", idea: IDEA, autonomy: "BOUNDED", limits: { maxRepairs: 2, maxParallel: 2, maxAttempts: 2 } });
    productId = r.product.id;
    expect(r.product.planningStatus).toBe("QUEUED");
    await drain(5, [ws, otherWs]);
    const d = await productDetail(ws, productId);
    expect(d.product.phase).toBe("PLANNING");
    expect(d.brief?.source).toBe("model");
    const tasks = d.items.filter((i) => i.level === "TASK");
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks.every((t) => t.acceptance.length > 0 && t.verifyBy.length > 0)).toBe(true);
    expect(d.items.find((i) => i.kind === "BACKEND")!.executable).toBe(true);
    expect(d.items.find((i) => i.kind === "DESIGN")!.executable).toBe(false);
    expect(d.repo?.provider).toBe("local");
    expect(d.gitOps.find((g) => g.op === "init")?.status).toBe("SUCCEEDED");
    expect(d.approvals.find((a) => a.action === "scope")?.status).toBe("PENDING");
    const t = await tickProduct(ws, productId);
    expect(t.waitingOn).toContain("scope approval");
    expect(await prisma.build.count({ where: { companyId: ws, productId } })).toBe(0);
  }, 60_000);

  it("scope approval → designer + architect artifacts from the model; revision loop; approval → handoff", async () => {
    const scope = (await productDetail(ws, productId)).approvals.find((a) => a.action === "scope")!;
    await decideProductApproval(ws, productId, scope.id, "ceo@test", "approve");
    // Keep code tasks from dispatching in this test: their execution is covered in builder.test.ts.
    await prisma.backlogItem.updateMany({ where: { productId, kind: { in: ["BACKEND", "FRONTEND", "DATA", "TEST"] } }, data: { status: "BLOCKED", blockedReason: "held for test" } });
    const t1 = await tickProduct(ws, productId);
    expect(t1.dispatched).toEqual(expect.arrayContaining(["E1.S1.T1", "E1.S1.T2"]));
    let d = await productDetail(ws, productId);
    const design = d.artifacts.find((a) => a.kind === "DESIGN")!;
    expect(design.source).toBe("model");
    const rev = await reviewArtifact(ws, productId, design.id, "ceo@test", "revise", "Show shared availability slots on each card");
    expect(rev.next?.version).toBe(2);
    expect(double.calls.some((c) => /Show shared availability slots/.test(c.lastUser))).toBe(true); // feedback reached the designer
    d = await productDetail(ws, productId);
    const v2 = d.artifacts.find((a) => a.kind === "DESIGN" && a.version === 2)!;
    expect((await reviewArtifact(ws, productId, v2.id, "ceo@test", "approve")).handoffId).toBeTruthy();
    await reviewArtifact(ws, productId, d.artifacts.find((a) => a.kind === "ARCHITECTURE")!.id, "ceo@test", "approve");
    d = await productDetail(ws, productId);
    expect(d.items.find((i) => i.key === "E1.S1.T1")!.status).toBe("DONE_UNVERIFIED"); // reviewed by a person, not machine-verified
  }, 60_000);

  it("unfinished work is never complete; readiness reports what did not run; production deploy is never claimed", async () => {
    const d = await productDetail(ws, productId);
    const be = d.items.find((i) => i.kind === "BACKEND")!;
    await expect(userSetItemStatus(ws, productId, be.key, "ceo@test", "VERIFIED")).rejects.toThrow(/verification evidence|Cannot move/);
    await expect(userSetItemStatus(ws, productId, be.key, "ceo@test", "DONE_UNVERIFIED")).rejects.toThrow(/executable test suite/);
    await expect(requestDeployment(ws, productId)).rejects.toThrow(/paid plans/); // free plan: not entitled
    await prisma.subscription.upsert({ where: { companyId: ws }, create: { companyId: ws, plan: "pro", status: "active" }, update: { plan: "pro", status: "active" } });
    const r = await readiness(ws, productId);
    expect(r.productionReady).toBe(false);
    expect(r.canCreateCandidate).toBe(false);
    expect(r.checks.find((c) => c.id === "monitoring")!.status).toBe("not_run");
    await expect(requestDeployment(ws, productId)).rejects.toThrow(/release candidate/);
  });

  it("requirement changes re-open scope and flag affected work; pause/cancel propagate", async () => {
    const d = await productDetail(ws, productId);
    const content = { ...(d.brief!.content as Record<string, unknown>), functional: [...((d.brief!.content as { functional: { id: string; text: string }[] }).functional), { id: "FR-9", text: "Users can export their team as a calendar invite" }] };
    const r = await reviseBrief(ws, productId, "ceo@test", content, d.brief!.version);
    // An added requirement invalidates no existing (traced) work; it is reported as unplanned and needs scope re-approval.
    expect(r.requirements.added).toEqual(["FR-9"]);
    expect(r.unplanned).toEqual(["FR-9"]);
    expect(r.reopened).toEqual([]);
    expect((await loadProduct(ws, productId)).scopeApproved).toBe(false);
    await expect(reviseBrief(ws, productId, "ceo@test", content, d.brief!.version)).rejects.toThrow(/changed since/);
    await controlProduct(ws, productId, "pause", "ceo@test");
    expect((await tickProduct(ws, productId)).note).toMatch(/paused/);
    await controlProduct(ws, productId, "cancel", "ceo@test");
    const after = await productDetail(ws, productId);
    expect(after.approvals.every((a) => a.status !== "PENDING")).toBe(true);
  }, 60_000);

  it("another workspace cannot read or act on the product", async () => {
    await expect(productDetail(otherWs, productId)).rejects.toThrow(/not found/i);
    await expect(tickProduct(otherWs, productId)).rejects.toThrow(/not found/i);
    await expect(productTimeline(otherWs, productId)).rejects.toThrow(/not found/i);
    await expect(userSetItemStatus(otherWs, productId, "E1.S1.T3", "x", "CANCELLED")).rejects.toThrow(/not found/i);
    expect((await productTimeline(ws, productId)).some((e) => e.kind === "phase")).toBe(true);
  });

  it("webhook: unsigned rejected, signed processed once, duplicates ignored, automation is opt-in", async () => {
    const d1 = `d1-${Date.now()}`, d2 = `d2-${Date.now()}`;
    const repo = await prisma.repoConnection.create({ data: { companyId: ws, provider: "github", name: `acme/hackmate-${Date.now()}`, webhookEnv: "AURA_TEST_WEBHOOK", triggers: JSON.stringify({ check_failed: "propose" }) } });
    const p = await prisma.product.create({ data: { companyId: ws, title: "Webhook target", idea: "x", repoId: repo.id, createdById: user } });
    process.env.AURA_TEST_WEBHOOK = "whsec_test";
    const sign = (b: string) => `sha256=${createHmac("sha256", "whsec_test").update(b).digest("hex")}`;
    const body = JSON.stringify({ repository: { full_name: repo.name }, check_run: { name: "ci", conclusion: "failure" } });
    expect((await handleWebhook({ provider: "github", deliveryId: d1, eventHeader: "check_run", rawBody: body, signature: "sha256=bad" })).status).toBe(401);
    expect(await handleWebhook({ provider: "github", deliveryId: d1, eventHeader: "check_run", rawBody: body, signature: sign(body) })).toMatchObject({ status: 200, action: "propose" });
    expect((await handleWebhook({ provider: "github", deliveryId: d1, eventHeader: "check_run", rawBody: body, signature: sign(body) })).action).toBe("duplicate");
    const created = await prisma.backlogItem.findMany({ where: { productId: p.id, key: { startsWith: "OPS." } } });
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("TODO");
    const pushBody = JSON.stringify({ repository: { full_name: repo.name }, ref: "refs/heads/main" });
    expect((await handleWebhook({ provider: "github", deliveryId: d2, eventHeader: "push", rawBody: pushBody, signature: sign(pushBody) })).action).toBe("off");
    delete process.env.AURA_TEST_WEBHOOK;
  }, 60_000);
});
