/**
 * Office pure modules: layout invariants, deterministic A*, state mapping
 * (only data-backed activities), and that the landing demo replays the real
 * planner output, real fixtures and recorded sandbox evidence.
 */
import { describe, it, expect } from "vitest";
import { findPath, pathLength, nearestWalkable } from "./pathfinding";
import { LOCATIONS, SEAT_BY_ID, HOME, walkableGrid, validateLayout, OBSTACLES, locationForTaskKind } from "./layout";
import { mapOfficeState, type OfficeTaskInput } from "./state";
import { DEMO_PLAN, DEMO_STEPS, DEMO_PROJECT, demoTasksAt, demoInteractionsAt, recordedRun, DEMO_AGENTS } from "./demo-script";
import { DEMO_RECORDING } from "./recording";
import { CHARACTERS, pixelSprite } from "./characters";
import { engineeringPlan } from "@/lib/missions/planner";
import { REPOS, VALIDATION_FIXTURE } from "@/lib/missions/repos";
import { AGENT_DEFS } from "@/lib/agents/definitions";
import { CAPABILITIES } from "@/lib/agents/capabilities";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const iso = (dMs: number) => new Date(NOW + dMs).toISOString();
const agent = (key: string, over = {}) => ({ key, name: key, role: key, status: "IDLE", available: true, ...over });
const task = (over: Partial<OfficeTaskInput>): OfficeTaskInput => ({ id: "t1", key: "fix", title: "Fix it", kind: "CODE_CHANGE", agentKey: "backend-engineer", status: "RUNNING", missionId: "m1", missionTitle: "M", missionStatus: "RUNNING", startedAt: iso(-1000), ...over });

describe("layout", () => {
  it("has valid seats, homes for every real agent and locations mapped to real task kinds", () => {
    expect(validateLayout()).toEqual([]);
    for (const d of AGENT_DEFS) expect(HOME[d.key], d.key).toBeTruthy();
    const kinds = new Set(Object.values(CAPABILITIES).flatMap((c) => c.taskKinds));
    for (const k of kinds) expect(locationForTaskKind(k), k).not.toBeNull();
    for (const l of LOCATIONS) for (const k of l.taskKinds) expect(kinds.has(k), `${l.id}:${k}`).toBe(true);
  });

  it("every seat is reachable from every other seat", () => {
    const g = walkableGrid();
    const seats = Object.values(SEAT_BY_ID);
    for (const a of seats) expect(findPath(g, seats[0].cell, a.cell), `${seats[0].id}→${a.id}`).not.toBeNull();
  });
});

describe("pathfinding", () => {
  const g = walkableGrid();
  it("is deterministic and never enters an obstacle or cuts a corner", () => {
    const a = findPath(g, SEAT_BY_ID["desk-1"].cell, SEAT_BY_ID["sec-desk-2"].cell)!;
    const b = findPath(g, SEAT_BY_ID["desk-1"].cell, SEAT_BY_ID["sec-desk-2"].cell)!;
    expect(a).toEqual(b);
    for (const [x, z] of a.slice(1)) expect(g[z][x], `${x},${z}`).toBe(true);
    for (let i = 1; i < a.length; i++) {
      const [px, pz] = a[i - 1];
      const [x, z] = a[i];
      expect(Math.max(Math.abs(x - px), Math.abs(z - pz))).toBe(1);
      if (x !== px && z !== pz) expect(g[pz][x] && g[z][px]).toBe(true);
    }
  });

  it("routes around the collaboration table instead of through it", () => {
    const p = findPath(g, [11, 10], [15, 10])!;
    const [x0, z0, x1, z1] = OBSTACLES.find((o) => o[0] === 12 && o[1] === 9)!;
    expect(p.some(([x, z]) => x >= x0 && x <= x1 && z >= z0 && z <= z1)).toBe(false);
    expect(pathLength(p)).toBeGreaterThan(4);
  });

  it("returns null for unreachable or blocked goals and recovers to the nearest walkable cell", () => {
    const tiny = [[true, false, true], [true, false, true], [true, false, true]];
    expect(findPath(tiny, [0, 0], [2, 2])).toBeNull();
    expect(findPath(tiny, [0, 0], [1, 1])).toBeNull();
    expect(findPath(tiny, [0, 0], [0, 2])).toEqual([[0, 0], [0, 1], [0, 2]]);
    const near = nearestWalkable(g, 13, 10); // inside the table
    expect(g[near[1]][near[0]]).toBe(true);
  });
});

describe("state mapper", () => {
  it("derives activity and location only from task records", () => {
    const v = mapOfficeState({
      agents: [agent("backend-engineer"), agent("qa-engineer"), agent("reviewer"), agent("devops"), agent("architect")],
      tasks: [
        task({}),
        task({ id: "t2", key: "verify", kind: "TEST", agentKey: "qa-engineer" }),
        task({ id: "t3", key: "review", kind: "REVIEW", agentKey: "reviewer", status: "READY" }),
        task({ id: "t4", key: "approve", kind: "APPROVAL", agentKey: "devops", status: "WAITING_APPROVAL" }),
      ],
      now: NOW,
    });
    const by = Object.fromEntries(v.map((x) => [x.key, x]));
    expect(by["backend-engineer"]).toMatchObject({ activity: "coding", location: "engineering" });
    expect(by["qa-engineer"]).toMatchObject({ activity: "testing", location: "qa" });
    expect(by.reviewer).toMatchObject({ activity: "idle", queued: 1 }); // READY is not "reviewing"
    expect(by.devops).toMatchObject({ activity: "awaiting_approval", location: "deploy" });
    expect(by.architect).toMatchObject({ activity: "idle", label: "No assigned work", location: "planning" });
  });

  it("shows failures as blocked, never as completed; ignores finished missions and unknown agents", () => {
    const v = mapOfficeState({
      agents: [agent("backend-engineer"), agent("qa-engineer"), agent("support", { available: false })],
      tasks: [
        task({ status: "FAILED" }),
        task({ id: "x", agentKey: "qa-engineer", kind: "TEST", missionStatus: "COMPLETED" }), // stale RUNNING row of a finished mission
        task({ id: "y", agentKey: "ghost-agent" }),
      ],
      now: NOW,
    });
    const by = Object.fromEntries(v.map((x) => [x.key, x]));
    expect(by["backend-engineer"].activity).toBe("blocked");
    expect(by["qa-engineer"].activity).toBe("idle");
    expect(by.support).toMatchObject({ activity: "blocked", label: "Agent unavailable" });
    expect(v.find((x) => x.key === "ghost-agent")).toBeUndefined();
  });

  it("completed is shown only briefly after a real success; expired leases are flagged stale", () => {
    const recent = mapOfficeState({ agents: [agent("qa-engineer")], tasks: [task({ agentKey: "qa-engineer", kind: "TEST", status: "SUCCEEDED", completedAt: iso(-60_000) })], now: NOW })[0];
    const old = mapOfficeState({ agents: [agent("qa-engineer")], tasks: [task({ agentKey: "qa-engineer", kind: "TEST", status: "SUCCEEDED", completedAt: iso(-3_600_000) })], now: NOW })[0];
    expect(recent.activity).toBe("completed");
    expect(old.activity).toBe("idle");
    const stale = mapOfficeState({ agents: [agent("backend-engineer")], tasks: [task({ leaseExpiresAt: iso(-5000) })], now: NOW })[0];
    expect(stale).toMatchObject({ activity: "coding", stale: true });
    expect(stale.label).toMatch(/lease expired/);
  });

  it("allocates distinct seats deterministically and pairs agents in recent interactions only", () => {
    const agents = ["backend-engineer", "frontend-engineer", "reviewer"].map((k) => agent(k));
    const tasks = agents.map((a, i) => task({ id: `c${i}`, agentKey: a.key }));
    const a = mapOfficeState({ agents, tasks, now: NOW, interactions: [{ id: "h", kind: "finding", from: "reviewer", to: ["backend-engineer"], text: "F-1", at: iso(-1000) }, { id: "old", kind: "handoff", from: "frontend-engineer", to: ["reviewer"], text: "x", at: iso(-3_600_000) }] });
    const b = mapOfficeState({ agents: [...agents].reverse(), tasks, now: NOW });
    expect(new Set(a.map((x) => x.seatId)).size).toBe(3);
    expect(a.map((x) => x.seatId)).toEqual(b.map((x) => x.seatId));
    expect(a.find((x) => x.key === "reviewer")!.interactionWith).toEqual(["backend-engineer"]);
    expect(a.find((x) => x.key === "frontend-engineer")!.interactionWith).toEqual([]);
  });
});

describe("product lifecycle work", () => {
  it("design/architecture items and proposed artifacts place agents; running mission tasks take precedence", () => {
    const work = [
      { id: "w1", agentKey: "designer", kind: "item" as const, title: "Design the signup flow", status: "IN_PROGRESS", itemKind: "DESIGN", productId: "p", productTitle: "P" },
      { id: "w2", agentKey: "architect", kind: "artifact" as const, title: "Architecture v1", status: "PROPOSED", itemKind: "ARCHITECTURE", productId: "p", productTitle: "P" },
      { id: "w3", agentKey: "backend-engineer", kind: "item" as const, title: "API", status: "BLOCKED", itemKind: "BACKEND", productId: "p", productTitle: "P", blockedReason: "depends on E1.S1.T1" },
      { id: "w4", agentKey: "frontend-engineer", kind: "item" as const, title: "UI", status: "IN_PROGRESS", itemKind: "FRONTEND", productId: "p", productTitle: "P" },
    ];
    const v = mapOfficeState({ agents: ["designer", "architect", "backend-engineer", "frontend-engineer", "qa-engineer"].map((k) => agent(k)), tasks: [task({ agentKey: "qa-engineer", kind: "TEST" })], work: [...work, { ...work[0], id: "w5", agentKey: "qa-engineer" }], now: NOW });
    const by = Object.fromEntries(v.map((x) => [x.key, x]));
    expect(by.designer).toMatchObject({ activity: "designing", location: "design" });
    expect(by.architect).toMatchObject({ activity: "awaiting_approval", location: "planning" });
    expect(by.architect.label).toMatch(/waiting for your review/);
    expect(by["backend-engineer"]).toMatchObject({ activity: "blocked" });
    expect(by["backend-engineer"].label).toMatch(/E1\.S1\.T1/);
    expect(by["frontend-engineer"].activity).toBe("idle"); // code items run through missions; no mission task → not "coding"
    expect(by["qa-engineer"]).toMatchObject({ activity: "testing", location: "qa" });
  });
});

describe("landing demo script", () => {
  it("replays the real planner output for the checkout-validation template", () => {
    const real = engineeringPlan("checkout-validation");
    expect(DEMO_PLAN.map((t) => [t.key, t.kind, t.agentKey, [...t.dependsOn]])).toEqual(real.tasks.map((t) => [t.key, t.kind, t.agentKey, t.dependsOn]));
  });

  it("shows the real fixture files and the engine's own repair candidates", () => {
    const repo = REPOS["checkout-validation"];
    expect(DEMO_PROJECT.files[0].content).toBe(repo.files["src/checkout/validation.js"]);
    const diffs = DEMO_STEPS.flatMap((s) => (s.panel.type === "diff" ? [s.panel.after] : []));
    expect(diffs).toEqual(repo.candidates.map((c) => c.code));
  });

  it("uses recorded Docker sandbox results with the expected fail → pass shape", () => {
    expect(DEMO_RECORDING.runs.every((r) => r.mode === "docker")).toBe(true);
    expect(recordedRun("reproduce")).toMatchObject({ failed: 1, total: 5 });
    expect(recordedRun("verify-1")).toMatchObject({ failed: 0, total: 5 });
    expect(recordedRun("review-1")).toMatchObject({ passed: 0, total: 3 });
    expect(recordedRun("review-2")).toMatchObject({ passed: 3, failed: 0 });
    expect(recordedRun("reproduce").cases.find((c) => !c.ok)!.name).toMatch(/zero quantity/);
    expect(VALIDATION_FIXTURE.FIXED).toMatch(/Number\.isInteger\(item\.quantity\)/);
  });

  it("every step maps to coherent office state; interactions are flagged as demo", () => {
    const agents = DEMO_AGENTS.map((a) => ({ ...a, status: "IDLE", available: true }));
    for (const s of DEMO_STEPS) {
      const v = mapOfficeState({ agents, tasks: demoTasksAt(s), interactions: demoInteractionsAt(s), now: Date.parse("2026-10-20T08:00:00Z") });
      expect(v).toHaveLength(agents.length);
      for (const i of demoInteractionsAt(s)) expect(i.demo).toBe(true);
      for (const [k, st] of Object.entries(s.tasks)) {
        const t = DEMO_PLAN.find((p) => p.key === k)!;
        if (st === "RUNNING") expect(v.find((x) => x.key === t.agentKey)!.activity, `${s.id}:${k}`).not.toBe("idle");
      }
    }
    expect(DEMO_AGENTS.find((a) => a.key === "frontend-engineer")).toBeTruthy(); // stays idle in this workflow — honestly
  });
});

describe("display names", () => {
  it("disambiguates agents that share a name", () => {
    const v = mapOfficeState({ agents: [agent("qa-engineer", { name: "Iris", role: "QA Engineer" }), agent("reviewer", { name: "Iris", role: "Code Reviewer" }), agent("devops", { name: "Forge", role: "DevOps / SRE" })], tasks: [], now: NOW });
    expect(v.map((x) => x.name).sort()).toEqual(["Forge", "Iris · QA", "Iris · Reviewer"]);
  });
});

describe("characters", () => {
  it("every real agent has a distinct character and a 10×10 sprite", () => {
    for (const d of AGENT_DEFS) expect(CHARACTERS[d.key], d.key).toBeTruthy();
    const looks = new Set(Object.values(CHARACTERS).map((c) => `${c.top}|${c.hairStyle}|${c.accessories.join()}`));
    expect(looks.size).toBe(Object.keys(CHARACTERS).length);
    const sp = pixelSprite(CHARACTERS.devops);
    expect(sp).toHaveLength(10);
    expect(sp.every((r) => r.length === 10)).toBe(true);
  });
});
