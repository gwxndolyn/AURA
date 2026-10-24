/**
 * Evidence-driven debugging (acceptance 8, 9, 10) and project memory
 * (acceptance 5, 6).
 *
 * The failing/passing outputs here are produced by REALLY running `node --test`
 * on the ScamScout fixture code (buggy, then fixed) in a temp directory on
 * the host. That is the same command the engine runs inside the Docker
 * sandbox; running it on the host keeps these tests meaningful when Docker is
 * unavailable. The model is not involved.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { stackFor } from "./stacks";
import { classify, signatureOf, recordAttempt, repeatDecision, diagnosisBrief, implicatedFiles, abandonOpen, type CheckResult } from "./debug";
import { remember, retrieve, renderMemory, markStale, setMemoryStatus, listMemory } from "@/lib/factory/memory";
import { ROUTE_BUGGY, ROUTE_FIXED, ROUTE_TEST, APP_PATCH } from "../../../test/doubles/scamscout";

function runNodeTest(routeSrc: string) {
  const dir = mkdtempSync(join(tmpdir(), "aura-dbg-"));
  const files: Record<string, string> = { ...stackFor("node-web").files, "src/routes/assessments.js": routeSrc, "src/routes/assessments.test.js": ROUTE_TEST };
  files["src/app.js"] = APP_PATCH(files["src/app.js"]);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  let output = "", exitCode = 0;
  try {
    output = execFileSync(process.execPath, ["--test", "--test-reporter=tap"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv, timeout: 60_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    exitCode = err.status ?? 1;
  }
  rmSync(dir, { recursive: true, force: true });
  return { output: output.replaceAll(dir, "/work"), exitCode, files: Object.keys(files) };
}

let user: string, ws: string, otherWs: string, other: string;
const PRODUCT = "prod-debug-test";
let failing: ReturnType<typeof runNodeTest>, passing: ReturnType<typeof runNodeTest>;

beforeAll(async () => {
  failing = runNodeTest(ROUTE_BUGGY);
  passing = runNodeTest(ROUTE_FIXED);
  const s = Date.now();
  user = (await prisma.user.create({ data: { email: `dbg_${s}@t.local`, name: "D" } })).id;
  other = (await prisma.user.create({ data: { email: `dbg_o_${s}@t.local`, name: "O" } })).id;
  ws = (await createCompany({ name: "DBG", mission: "m", industry: "SaaS", ownerId: user })).id;
  otherWs = (await createCompany({ name: "DBG-O", mission: "m", industry: "SaaS", ownerId: other })).id;
}, 120_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await prisma.user.deleteMany({ where: { id: { in: [user, other] } } });
  await prisma.$disconnect();
});

const check = (r: ReturnType<typeof runNodeTest>, id: string): CheckResult => ({ id: "test", command: "npm test --silent", ok: r.exitCode === 0, exitCode: r.exitCode, commandRunId: id, output: r.output });

describe("failure classification and signatures (real node --test output)", () => {
  it("a real assertion failure is a code defect with the failing test named", () => {
    expect(failing.exitCode).not.toBe(0);
    expect(passing.exitCode).toBe(0);
    const c = check(failing, "cr1");
    expect(classify(c).category).toBe("code");
    const sig = signatureOf(c);
    expect(sig.failingTests).toEqual(["upfront payment is high risk"]);
    // Stable across runs (durations, temp paths differ) — same failure, same signature.
    expect(signatureOf(check(runNodeTest(ROUTE_BUGGY), "cr9")).signature).toBe(sig.signature);
    expect(implicatedFiles(failing.output, failing.files)).toContain("src/routes/assessments.test.js");
    // The default spec reporter (what `npm test` prints) yields the same failing test name.
    expect(signatureOf({ ...c, output: "✖ upfront payment is high risk (5.4ms)\nℹ tests 5\nℹ pass 4\nℹ fail 1\n✖ failing tests:\n\n✖ upfront payment is high risk (5.4ms)" }).failingTests).toEqual(["upfront payment is high risk"]);
  });

  it("infrastructure, dependency, configuration and timeout failures are not treated as code defects", () => {
    const base = { id: "install", command: "npm ci --ignore-scripts", ok: false, exitCode: 1, commandRunId: "x" };
    expect(classify({ ...base, output: "npm ERR! code ENOTFOUND\nnpm ERR! getaddrinfo ENOTFOUND registry.npmjs.org" }).category).toBe("infrastructure");
    expect(classify({ ...base, output: "npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for left-pad@^99" }).category).toBe("dependency");
    expect(classify({ ...base, id: "test", command: "npm test", output: "npm ERR! Missing script: \"test\"" }).category).toBe("configuration");
    expect(classify({ ...base, id: "test", command: "npm test", output: "", timedOut: true }).category).toBe("timeout");
    expect(classify({ ...base, id: "test", command: "npm test", output: "Error: EACCES: permission denied, open '/etc/x'" }).category).toBe("permissions");
  });
});

describe("defect records across repair attempts", () => {
  it("a real failing test produces a traceable defect; the fix is proven by the passing run (acceptance 8, 9)", async () => {
    const buildId = `bld-fix-${Date.now()}`;
    const a0 = await recordAttempt({ companyId: ws, productId: PRODUCT, itemKey: "E1.S1.T1", buildId, attempt: 0, results: [check(failing, "cmd-fail-1")], knownFiles: failing.files, testImports: () => ["src/routes/assessments.js"] });
    expect(a0.open).toHaveLength(1);
    const d = a0.open[0];
    expect(d).toMatchObject({ category: "code", command: "npm test --silent", commandRunId: "cmd-fail-1", status: "OPEN", failingTests: ["upfront payment is high risk"] });
    expect(d.files).toEqual(expect.arrayContaining(["src/routes/assessments.js", "src/routes/assessments.test.js"]));
    expect(d.exitCode).not.toBe(0);
    const brief = diagnosisBrief(a0.open, [check(failing, "cmd-fail-1")], []);
    expect(brief).toMatch(/Likely cause: code/);
    expect(brief).toMatch(/'low' !== 'high'|expected: 'high'/);
    expect(a0.recurring).toBeNull();

    const a1 = await recordAttempt({ companyId: ws, productId: PRODUCT, itemKey: "E1.S1.T1", buildId, attempt: 1, results: [check(passing, "cmd-pass-2")], knownFiles: passing.files, testImports: () => [], headSha: "abc123" });
    expect(a1.open).toEqual([]);
    expect(a1.fixed).toHaveLength(1);
    const row = await prisma.defect.findUnique({ where: { id: d.id } });
    expect(row).toMatchObject({ status: "FIXED", fixedByCommandRunId: "cmd-pass-2", fixedSha: "abc123" });
  });

  it("the same failure after repairs escalates, then stops within the limit (acceptance 10)", async () => {
    const buildId = `bld-rep-${Date.now()}`;
    const args = (attempt: number) => ({ companyId: ws, productId: PRODUCT, itemKey: "E1.S1.T2", buildId, attempt, results: [check(failing, `cmd-${attempt}`)], knownFiles: failing.files, testImports: () => [] });
    const a0 = await recordAttempt(args(0));
    expect(repeatDecision(a0.open, a0.recurring).action).toBe("continue");
    const a1 = await recordAttempt(args(1));
    expect(a1.recurring?.signature).toBe(a0.open[0].signature);
    expect(repeatDecision(a1.open, a1.recurring)).toMatchObject({ action: "escalate" });
    const a2 = await recordAttempt(args(2));
    expect(repeatDecision(a2.open, a2.recurring)).toMatchObject({ action: "stop" });
    // Duplicate delivery of the same attempt does not double-count.
    await recordAttempt(args(2));
    expect((await prisma.defect.findFirst({ where: { buildId } }))!.occurrences).toBe(3);
    await abandonOpen(buildId);
    expect((await prisma.defect.findFirst({ where: { buildId } }))!.status).toBe("ABANDONED");
  });
});

describe("project memory", () => {
  it("retrieves relevant verified facts, labels assumptions, and never returns stale memory (acceptance 5, 6)", async () => {
    await remember({ companyId: ws, productId: PRODUCT, key: "test:commands", kind: "test_setup", content: "Verification that passes: `npm test --silent`.", status: "VERIFIED", files: ["package.json"], provenance: { type: "build", ref: "b1", detail: "5/5 passed" } });
    await remember({ companyId: ws, productId: PRODUCT, key: "api:POST /api/assessments", kind: "api_contract", content: "POST /api/assessments is served by src/routes/assessments.js; exercised by src/routes/assessments.test.js.", status: "VERIFIED", files: ["src/routes/assessments.js"], requirements: ["FR-1"], provenance: { type: "build", ref: "b1", detail: "" } });
    await remember({ companyId: ws, productId: PRODUCT, key: "assume:english", kind: "decision", content: "Listings are English only.", status: "ASSUMPTION", requirements: ["FR-1"], provenance: { type: "brief", ref: "v1", detail: "A-1" } });
    await remember({ companyId: ws, productId: PRODUCT, key: "pattern:unrelated", kind: "pattern", content: "Invoices are rendered as PDF.", status: "VERIFIED", files: ["src/invoices.js"], provenance: { type: "build", ref: "b0", detail: "" } });
    await remember({ companyId: otherWs, productId: "other-product", key: "api:secret", kind: "api_contract", content: "OTHER TENANT SECRET ROUTE", status: "VERIFIED", files: ["src/routes/assessments.js"], provenance: { type: "build", ref: "x", detail: "" } });

    const got = await retrieve(ws, PRODUCT, { files: ["src/routes/assessments.js"], requirements: ["FR-1"] });
    const keys = got.map((g) => g.key);
    expect(keys).toEqual(expect.arrayContaining(["api:POST /api/assessments", "test:commands", "assume:english"]));
    expect(keys).not.toContain("pattern:unrelated");
    expect(got.some((g) => g.content.includes("OTHER TENANT"))).toBe(false);
    const text = renderMemory(got);
    expect(text).toMatch(/Verified facts[\s\S]*POST \/api\/assessments/);
    expect(text).toMatch(/Assumptions \(NOT verified[\s\S]*English only/);

    // A requirement change makes dependent memory stale → excluded from retrieval.
    const stale = await markStale(ws, PRODUCT, { requirements: ["FR-1"], reason: "FR-1 changed in brief v2" });
    expect(stale.sort()).toEqual(["api:POST /api/assessments", "assume:english"]);
    const after = await retrieve(ws, PRODUCT, { files: ["src/routes/assessments.js"], requirements: ["FR-1"] });
    expect(after.map((a) => a.key)).toEqual(["test:commands"]);
    const all = await listMemory(ws, PRODUCT);
    expect(all.find((m) => m.key === "api:POST /api/assessments")).toMatchObject({ status: "STALE", staleReason: "FR-1 changed in brief v2" });

    // An assertion never downgrades verified knowledge; new verified evidence refreshes stale memory.
    await remember({ companyId: ws, productId: PRODUCT, key: "test:commands", kind: "test_setup", content: "maybe tests are broken", status: "ASSUMPTION", provenance: { type: "user", ref: "u", detail: "" } });
    expect((await listMemory(ws, PRODUCT)).find((m) => m.key === "test:commands")!.content).toMatch(/npm test/);
    await remember({ companyId: ws, productId: PRODUCT, key: "api:POST /api/assessments", kind: "api_contract", content: "POST /api/assessments re-verified.", status: "VERIFIED", files: ["src/routes/assessments.js"], provenance: { type: "build", ref: "b2", detail: "" } });
    expect((await listMemory(ws, PRODUCT)).find((m) => m.key === "api:POST /api/assessments")!.status).toBe("VERIFIED");

    // A person can invalidate; another workspace cannot touch it.
    const m = (await listMemory(ws, PRODUCT)).find((x) => x.key === "assume:english")!;
    await expect(setMemoryStatus(otherWs, PRODUCT, m.id, "x@t", "INVALIDATED")).rejects.toThrow(/not found/i);
    expect((await setMemoryStatus(ws, PRODUCT, m.id, "owner@t", "INVALIDATED", "we support Spanish too")).status).toBe("INVALIDATED");
  });
});
