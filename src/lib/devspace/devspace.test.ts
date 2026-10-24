/**
 * Development workspace tests: path policy, file service (CAS, all-or-nothing,
 * history), change lifecycle (mission → proposed → verified → accepted /
 * rejected / reverted / conflict), sandbox checks (real Docker: execution,
 * cancellation, output limits), and tenant isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { createCompany } from "@/lib/company/provision";
import { dockerAvailable } from "@/lib/sandbox/runner";
import { decidePlan, runUntilBlocked } from "@/lib/missions/engine";
import { VALIDATION_FIXTURE } from "@/lib/missions/repos";
import { normalizePath, PathError, isProtected, MAX_FILE_BYTES } from "./paths";
import { applyWrites, getWorkspace, readFile, filesOf, ConflictError, fileHistory } from "./files";
import { seedProjectFromFixture, startProjectMission, syncMissionChanges, acceptChange, rejectChange, revertChange, saveUserEdit, acceptanceBlockers } from "./changes";
import { runCheck, cancelCheck, MAX_OUTPUT } from "./checks";
import { lineDiff } from "@/lib/missions/diff";

const SCENARIO = "Find and fix a validation bug in a sample checkout module: inspect the checkout validation code, fix the failing validation test, run the tests.";
let user: string, ws: string, other: string, otherWs: string, docker = false;

beforeAll(async () => {
  docker = await dockerAvailable();
  const s = Date.now();
  user = (await prisma.user.create({ data: { email: `dev_${s}@t.local`, name: "D" } })).id;
  other = (await prisma.user.create({ data: { email: `dev_o_${s}@t.local`, name: "O" } })).id;
  ws = (await createCompany({ name: "DEV", mission: "m", industry: "SaaS", ownerId: user })).id;
  otherWs = (await createCompany({ name: "DEV-OTHER", mission: "m", industry: "SaaS", ownerId: other })).id;
}, 60_000);

afterAll(async () => {
  await prisma.company.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await prisma.user.deleteMany({ where: { id: { in: [user, other] } } });
  await prisma.$disconnect();
});

describe("path policy", () => {
  it("rejects traversal, absolute paths, backslashes and control characters", () => {
    for (const bad of ["../etc/passwd", "a/../../b", "/etc/passwd", "C:/win", "a\\b", "a//b", "./a", "a\u0000b", "a/./b", ""]) expect(() => normalizePath(bad)).toThrow(PathError);
    expect(normalizePath("src/checkout/validation.js")).toBe("src/checkout/validation.js");
  });
  it("protects secret and configuration files", () => {
    for (const p of [".env", "config/.env.local", "certs/server.pem", ".git/config", "secrets/db.json", "id_rsa"]) expect(isProtected(p)).toBe(true);
    expect(isProtected("src/env.js")).toBe(false);
  });
});

describe("file service", () => {
  it("writes are all-or-nothing and conflict-checked per file", async () => {
    const before = await getWorkspace(ws);
    // One valid + one protected file → nothing written.
    await expect(applyWrites(ws, [{ path: "notes/a.md", content: "a", expectedRev: 0 }, { path: ".env", content: "SECRET=1", expectedRev: 0 }], "u@test")).rejects.toThrow(/protected/);
    expect(filesOf(await getWorkspace(ws))).not.toHaveProperty("notes/a.md");
    expect((await getWorkspace(ws)).revision).toBe(before.revision);
    const r = await applyWrites(ws, [{ path: "notes/a.md", content: "a", expectedRev: 0 }], "u@test");
    // A second writer with a stale revision is refused.
    await expect(applyWrites(ws, [{ path: "notes/a.md", content: "b", expectedRev: 0 }], "v@test")).rejects.toBeInstanceOf(ConflictError);
    expect(readFile(await getWorkspace(ws), "notes/a.md")!.content).toBe("a");
    await applyWrites(ws, [{ path: "notes/a.md", content: "b", expectedRev: r.files[0].rev }], "u@test");
    expect((await fileHistory(ws, "notes/a.md")).map((h) => h.op)).toEqual(["modify", "create"]);
  });

  it("enforces size limits and traversal on write", async () => {
    await expect(applyWrites(ws, [{ path: "big.txt", content: "x".repeat(MAX_FILE_BYTES + 1), expectedRev: 0 }], "u@test")).rejects.toThrow(/limit/);
    await expect(applyWrites(ws, [{ path: "../../escape.js", content: "x", expectedRev: 0 }], "u@test")).rejects.toThrow(PathError);
  });

  it("concurrent writers: exactly one wins", async () => {
    const cur = readFile(await getWorkspace(ws), "notes/a.md")!;
    const results = await Promise.allSettled([applyWrites(ws, [{ path: "notes/a.md", content: "x", expectedRev: cur.rev }], "a@test"), applyWrites(ws, [{ path: "notes/a.md", content: "y", expectedRev: cur.rev }], "b@test")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof ConflictError)).toHaveLength(1);
  });

  it("diff counts are correct", () => {
    const d = lineDiff(VALIDATION_FIXTURE.BUGGY, VALIDATION_FIXTURE.FIXED);
    expect([d.added, d.removed]).toEqual([1, 1]);
    expect(d.text).toContain("- " + VALIDATION_FIXTURE.BUGGY.split("\n").find((l) => l.includes("quantity < 0")));
  });
});

describe("sandbox checks", () => {
  it("runs the real test suite against the project revision and reports failing tests", async () => {
    await seedProjectFromFixture(ws, "checkout-validation", "u@test");
    const r = await runCheck(ws, "unit-tests", "u@test");
    if (!docker) {
      expect(r.status).toBe("ERROR");
      return;
    }
    expect(r.mode).toBe("docker");
    expect(r.status).toBe("FAILED");
    expect(r.exitCode).not.toBe(0);
    expect([r.passed, r.failed, r.total]).toEqual([4, 1, 5]);
    expect(JSON.parse(r.failedNames).join()).toMatch(/rejects a zero quantity/);
    expect(r.output).toMatch(/not ok/);
  }, 60_000);

  it("unsupported checks say so — never a pass", async () => {
    const r = await runCheck(ws, "lint", "u@test");
    expect(r.status).toBe("UNSUPPORTED");
    expect(r.exitCode).toBeNull();
  });

  it("bounds output size", async () => {
    if (!docker) return;
    const w = await getWorkspace(ws);
    const big = await applyWrites(ws, [{ path: "noisy.test.js", content: "const t=require('node:test');t('noisy',()=>{for(let i=0;i<20000;i++)console.log('x'.repeat(40))});", expectedRev: 0 }], "u@test");
    const r = await runCheck(ws, "unit-tests", "u@test");
    expect(r.output.length).toBeLessThan(MAX_OUTPUT + 200);
    expect(r.truncated).toBe(true);
    await applyWrites(ws, [{ path: "noisy.test.js", content: null, expectedRev: big.files[0].rev }], "u@test");
    void w;
  }, 60_000);

  it("cancels a running check", async () => {
    if (!docker) return;
    const s = await applyWrites(ws, [{ path: "slow.test.js", content: "const t=require('node:test');t('slow',async()=>{await new Promise(r=>setTimeout(r,20000))});", expectedRev: 0 }], "u@test");
    const p = runCheck(ws, "unit-tests", "u@test");
    let run = null;
    for (let i = 0; i < 40 && !run; i++) {
      await new Promise((r) => setTimeout(r, 250));
      run = await prisma.execRun.findFirst({ where: { companyId: ws, status: "RUNNING" } });
    }
    expect(run).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1500)); // let the container start
    await cancelCheck(ws, run!.id, "u@test");
    const done = await p;
    expect(done.status).toBe("CANCELLED");
    expect(done.completedAt!.getTime() - done.startedAt!.getTime()).toBeLessThan(15_000);
    await applyWrites(ws, [{ path: "slow.test.js", content: null, expectedRev: s.files[0].rev }], "u@test");
  }, 60_000);

  it("another workspace cannot cancel or read a run", async () => {
    const r = await prisma.execRun.findFirst({ where: { companyId: ws } });
    await expect(cancelCheck(otherWs, r!.id, "x")).rejects.toThrow(/not found/i);
  });
});

describe("mission change review lifecycle", () => {
  let missionId: string;
  let changeId: string;

  it("concurrent first syncs create exactly one review record", async () => {
    const r = await startProjectMission(ws, user, SCENARIO);
    await decidePlan(r.missionId, ws, "approve", "human@test");
    for (let i = 0; i < 4; i++) await (await import("@/lib/missions/engine")).advanceMission(r.missionId, ws); // through fix (writes FILE artifact)
    await prisma.fileChange.deleteMany({ where: { companyId: ws, missionId: r.missionId } }); // simulate "never synced yet"
    await Promise.all([1, 2, 3, 4].map(() => syncMissionChanges(ws, r.missionId)));
    const n = await prisma.fileChange.count({ where: { companyId: ws, missionId: r.missionId } });
    expect(n).toBe(docker ? 1 : 0);
    await prisma.mission.update({ where: { id: r.missionId }, data: { status: "CANCELLED" } });
    await prisma.fileChange.updateMany({ where: { companyId: ws, missionId: r.missionId }, data: { status: "REJECTED" } });
  }, 120_000);

  it("a project mission snapshots the project and its agents' patch becomes a proposed change", async () => {
    const r = await startProjectMission(ws, user, SCENARIO);
    missionId = r.missionId;
    expect(r.scoped).toBe(true);
    const m = await prisma.mission.findUnique({ where: { id: missionId } });
    expect(JSON.parse(m!.baseFiles)["src/checkout/validation.js"]).toBe(VALIDATION_FIXTURE.BUGGY);
    await decidePlan(missionId, ws, "approve", "human@test");
    const run = await runUntilBlocked(missionId, ws, 40);
    const changes = await syncMissionChanges(ws, missionId);
    if (!docker) {
      expect(run.status).toBe("FAILED");
      return;
    }
    expect(run.status).toBe("COMPLETED");
    expect(changes).toHaveLength(1);
    const c = changes[0];
    changeId = c.id;
    expect(c.path).toBe("src/checkout/validation.js");
    expect(c.author).toBe("backend-engineer");
    expect(c.taskKey).toBe("fix");
    expect(c.status).toBe("VERIFIED");
    expect([c.added, c.removed]).toEqual([1, 1]);
    // The project itself is untouched until a person accepts.
    expect(readFile(await getWorkspace(ws), "src/checkout/validation.js")!.content).toBe(VALIDATION_FIXTURE.BUGGY);
    // Re-sync is idempotent, including under concurrency (regression: duplicate review records).
    expect((await syncMissionChanges(ws, missionId)).map((x) => x.id)).toEqual([changeId]);
    await Promise.all([syncMissionChanges(ws, missionId), syncMissionChanges(ws, missionId), syncMissionChanges(ws, missionId)]);
    expect(await prisma.fileChange.count({ where: { companyId: ws, missionId } })).toBe(1);
  }, 240_000);

  it("a check can verify the proposed change before acceptance", async () => {
    if (!docker) return;
    const r = await runCheck(ws, "unit-tests", "u@test", { changeId });
    expect(r.status).toBe("PASSED");
    expect([r.passed, r.total]).toEqual([5, 5]);
  }, 60_000);

  it("accepting applies exactly the verified content as a new revision; recorded state matches the file", async () => {
    if (!docker) return;
    const c = (await prisma.fileChange.findUnique({ where: { id: changeId } }))!;
    expect(await acceptanceBlockers(c)).toEqual([]);
    await expect(acceptChange(ws, changeId, "owner@test")).rejects.toThrow(/higher-risk/); // checkout path → explicit confirmation
    const a = await acceptChange(ws, changeId, "owner@test", { confirmHighRisk: true });
    const f = readFile(await getWorkspace(ws), "src/checkout/validation.js")!;
    expect(f.content).toBe(VALIDATION_FIXTURE.FIXED);
    const after = (await prisma.fileChange.findUnique({ where: { id: changeId } }))!;
    expect(after.status).toBe("ACCEPTED");
    expect(after.appliedRevision).toBe(a.revision);
    expect(after.newSha256).toBe(f.sha256);
    expect(after.decidedBy).toBe("owner@test");
    const ver = await prisma.fileVersion.findFirst({ where: { companyId: ws, path: f.path, changeId } });
    expect(ver!.sha256).toBe(f.sha256);
    // The project's own test suite now passes.
    expect((await runCheck(ws, "unit-tests", "u@test")).status).toBe("PASSED");
  }, 60_000);

  it("revert restores the original as a new revision; history is kept", async () => {
    if (!docker) return;
    const r = await revertChange(ws, changeId, "owner@test");
    expect(readFile(await getWorkspace(ws), "src/checkout/validation.js")!.content).toBe(VALIDATION_FIXTURE.BUGGY);
    expect((await prisma.fileChange.findUnique({ where: { id: changeId } }))!.revertedRevision).toBe(r.revision);
    expect((await fileHistory(ws, "src/checkout/validation.js")).length).toBeGreaterThanOrEqual(3);
    await expect(revertChange(ws, changeId, "owner@test")).rejects.toThrow(/Only an accepted change/);
  });

  it("a user edit after the agent's base turns the change into a conflict; accepting it is refused and overwrites nothing", async () => {
    if (!docker) return;
    const r = await startProjectMission(ws, user, SCENARIO);
    await decidePlan(r.missionId, ws, "approve", "human@test");
    await runUntilBlocked(r.missionId, ws, 40);
    const [c] = await syncMissionChanges(ws, r.missionId);
    // Someone edits the file directly after the mission started.
    const cur = readFile(await getWorkspace(ws), "src/checkout/validation.js")!;
    const edit = await saveUserEdit(ws, "dev@test", cur.path, cur.content + "\n// hand edit\n", cur.rev);
    expect(edit.conflicted).toContain(c.id);
    // Independently of the edit hook, a change based on an old revision can never apply: re-open it and retry.
    await prisma.fileChange.update({ where: { id: c.id }, data: { status: "VERIFIED" } });
    await expect(acceptChange(ws, c.id, "owner@test", { confirmHighRisk: true })).rejects.toThrow(/changed since/);
    expect((await prisma.fileChange.findUnique({ where: { id: c.id } }))!.status).toBe("CONFLICT");
    await expect(acceptChange(ws, c.id, "owner@test", { confirmHighRisk: true })).rejects.toThrow(/conflict|already/i);
    expect(readFile(await getWorkspace(ws), cur.path)!.content).toContain("// hand edit"); // nothing overwritten
    expect((await rejectChange(ws, c.id, "owner@test", "superseded by hand edit")).status).toBe("REJECTED");
  }, 240_000);

  it("acceptance is refused when verification failed", async () => {
    const m = await prisma.mission.findFirst({ where: { companyId: ws } });
    const w = await getWorkspace(ws);
    const fake = await prisma.fileChange.create({ data: { workspaceId: w.id, companyId: ws, path: "src/checkout/validation.js", op: "modify", source: "agent", author: "backend-engineer", missionId: m!.id, baseRev: 1, baseSha256: "x", newSha256: "y", status: "VERIFICATION_FAILED", verification: JSON.stringify({ lastTest: { mode: "docker", failed: 1 }, openBlocking: ["F-1 broken"] }) } });
    await expect(acceptChange(ws, fake.id, "owner@test", { confirmHighRisk: true })).rejects.toThrow(/Cannot accept: .*verification failed.*F-1 broken/);
  });

  it("another workspace cannot read, accept or reject the change", async () => {
    const c = await prisma.fileChange.findFirst({ where: { companyId: ws } });
    await expect(acceptChange(otherWs, c!.id, "x", { confirmHighRisk: true })).rejects.toThrow(/not found/i);
    await expect(rejectChange(otherWs, c!.id, "x")).rejects.toThrow(/not found/i);
    expect(readFile(await getWorkspace(otherWs), "src/checkout/validation.js")).toBeNull();
  });
});
