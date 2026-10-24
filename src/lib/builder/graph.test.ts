/** V13: dependency graph, impact, integration contracts, diagnosis, test selection (pure, real code index). */
import { describe, it, expect } from "vitest";
import { buildIndex } from "./intel";
import { buildGraph, graphImpact, integrationFindings, envUses, persistenceCalls } from "./graph";
import { diagnose } from "./diagnose";
import { selectTests } from "./integration";
import { stackFor } from "./stacks";

const APP = stackFor("node-web").files["src/app.js"].replace('const health = require("./routes/health");', 'const health = require("./routes/health");\nconst notes = require("./routes/notes");').replace("const ROUTES = [...health.routes];", "const ROUTES = [...health.routes, ...notes.routes];");
const ROUTE = `const { json, readJson } = require("../http");
const store = require("../store");
const KEY = process.env.NOTES_API_KEY;
async function create(req, res) { const body = await readJson(req); if (!body.title) return json(res, 400, { error: "title is required" }); return json(res, 201, store.insert("notes", { title: body.title })); }
module.exports.routes = [{ method: "POST", pattern: /^\\/api\\/notes$/, handler: create }, { method: "GET", pattern: /^\\/api\\/notes$/, handler: (req, res) => json(res, 200, store.all("notes")) }];
`;
const PAGE = (path: string, field = "title") => `document.querySelector("form").onsubmit = async () => { await fetch("${path}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ${field} }) }); };`;
const TEST = `const test = require("node:test"); const { start } = require("./testing"); test("notes", async () => { const a = await start(); await fetch(a.url + "/api/notes"); await a.close(); });`;
const files = (over: Record<string, string> = {}) => ({ ...stackFor("node-web").files, "src/app.js": APP, "src/routes/notes.js": ROUTE, "public/app.js": PAGE("/api/notes"), "src/notes.test.js": TEST, ...over });

describe("system dependency graph", () => {
  it("extracts pages, routes, entities, env, tests and requirement links with basis + source", async () => {
    const f = files();
    const idx = await buildIndex(f);
    const g = buildGraph({ sha: "s1", index: idx, files: f, items: [{ key: "T1", title: "notes", requirements: ["FR-1"], plannedFiles: ["src/routes/notes.js"], verifiedFiles: ["src/routes/notes.js"] }] });
    const has = (from: string, kind: string, to: string) => g.edges.some((e) => e.from === from && e.kind === kind && e.to === to);
    expect(has("file:src/routes/notes.js", "handles", "route:POST /api/notes")).toBe(true);
    expect(has("file:public/app.js", "calls", "route:POST /api/notes")).toBe(true);
    expect(has("file:src/routes/notes.js", "persists", "entity:notes")).toBe(true);
    expect(has("file:src/routes/notes.js", "reads_env", "env:NOTES_API_KEY")).toBe(true);
    expect(has("req:FR-1", "implements", "file:src/routes/notes.js")).toBe(true);
    expect(g.edges.find((e) => e.from === "req:FR-1")!.basis).toBe("static");
    expect(g.edges.find((e) => e.kind === "verifies")!.basis).toBe("inferred");
    expect(g.limitations.join(" ")).toMatch(/No runtime evidence/);
    // Runtime evidence adds verified page→route edges and a journey.
    const g2 = buildGraph({ sha: "s1", index: idx, files: f, observed: [{ route: "/", requests: [{ method: "POST", path: "/api/notes", status: 201 }], journeys: [{ name: "create → reload → persists", status: "passed" }] }] });
    expect(g2.edges.some((e) => e.basis === "runtime" && e.to === "route:POST /api/notes")).toBe(true);
    expect(g2.nodes.some((n) => n.kind === "journey")).toBe(true);
    expect(envUses("x", "const a = process.env.A || 'x'; process.env.B")).toEqual([{ name: "A", file: "x", optional: true }, { name: "B", file: "x", optional: false }]);
    expect(persistenceCalls('store.insert("orders", x); prisma.invoice.findMany()')).toEqual(["orders", "invoice"]);
  });

  it("change impact reaches dependents, the routes they handle, calling pages, tests and requirements", async () => {
    const f = files();
    const idx = await buildIndex(f);
    const g = buildGraph({ index: idx, files: f, items: [{ key: "T1", title: "n", requirements: ["FR-1"], plannedFiles: [], verifiedFiles: ["src/routes/notes.js"] }] });
    const imp = graphImpact(g, idx, ["src/store.js"]);
    expect(imp.components.map((c) => c.id)).toEqual(expect.arrayContaining(["file:src/routes/notes.js", "file:public/app.js"]));
    expect(imp.routes).toContain("route:POST /api/notes");
    expect(imp.tests).toContain("src/notes.test.js");
    expect(imp.requirements).toContain("FR-1");
    const sel = selectTests(g, idx, ["src/store.js"], "LOW");
    expect(sel.fullSuite).toBe(true); // the full suite always remains the gate
    expect(selectTests(g, idx, ["package.json"], "LOW").confidence).toBe("low"); // conservative fallback
    expect(selectTests(g, idx, ["src/routes/notes.js"], "HIGH").why.join(" ")).toMatch(/high-risk/);
  });

  it("finds API contract mismatches: wrong path (with suggestion), wrong method, wrong body fields, missing env", async () => {
    const f = files({ "public/app.js": `${PAGE("/api/note")}\nfetch("/api/notes", { method: "DELETE" });\n${PAGE("/api/notes", "name")}` });
    const idx = await buildIndex(f);
    const g = buildGraph({ index: idx, files: f });
    const fs = integrationFindings(g, idx, f, { provided: [] });
    const kinds = fs.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["missing_route", "method_mismatch", "missing_env"]));
    expect(fs.find((x) => x.kind === "missing_route")!.suggestion).toMatch(/POST \/api\/notes/);
    expect(fs.find((x) => x.kind === "body_field_mismatch")?.detail).toMatch(/title never sent/);
    expect(integrationFindings(g, idx, f, {}).some((x) => x.kind === "missing_env")).toBe(false); // no target → env not checked (not "passed" either)
  });
});

describe("cross-component diagnosis", () => {
  it("a missing env var is the root cause of the backend 500, the frontend error and failing tests — reported as infrastructure, no code fix", async () => {
    const f = files();
    const idx = await buildIndex(f);
    const g = buildGraph({ index: idx, files: f });
    const d = diagnose({ graph: g, contracts: integrationFindings(g, idx, f, { provided: [] }), changed: ["src/routes/notes.js"], defects: [{ signature: "s", category: "code", title: "1 failing test(s): notes", files: ["src/routes/notes.js"], failingTests: ["notes"], output: "Error: NOTES_API_KEY is undefined" }], browser: { findings: [{ kind: "request_failed", route: "/", detail: "500 /api/notes" }], requests: [{ method: "POST", path: "/api/notes", status: 500 }] } });
    expect(d.rootCause?.category).toBe("configuration");
    expect(d.rootCause?.origin).toBe("env:NOTES_API_KEY");
    expect(d.infrastructure).toBe(true);
    expect(d.rootCause?.fix.kind).toBe("config");
    expect(d.rootCause!.explains.length).toBeGreaterThan(1); // one cause, several symptoms
  });

  it("a frontend path typo is a contract mismatch fixed in the changed client file, not the server", async () => {
    const f = files({ "public/app.js": PAGE("/api/note") });
    const idx = await buildIndex(f);
    const g = buildGraph({ index: idx, files: f });
    const d = diagnose({ graph: g, contracts: integrationFindings(g, idx, f), changed: ["public/app.js"], defects: [], browser: { findings: [{ kind: "journey_failed", route: "/", detail: "submitting the form did not call /api/notes" }], requests: [{ method: "POST", path: "/api/note", status: 404 }] } });
    expect(d.rootCause?.category).toBe("contract_mismatch");
    expect(d.rootCause?.fix.files).toEqual(["public/app.js"]);
    expect(d.infrastructure).toBe(false);
  });

  it("an unreachable external service is an external limitation; with no evidence the cause is unknown; ties are ambiguous", async () => {
    const f = files({ "src/routes/rates.js": 'module.exports = () => fetch("https://api.rates.example.org/v1");' });
    const idx = await buildIndex(f);
    const g = buildGraph({ index: idx, files: f });
    const ext = diagnose({ graph: g, contracts: [], changed: [], defects: [{ signature: "x", category: "code", title: "rates test", files: [], failingTests: ["rates"], output: "TypeError: fetch failed\n getaddrinfo ENOTFOUND api.rates.example.org" }] });
    expect(ext.rootCause?.category).toBe("external_service");
    expect(ext.infrastructure).toBe(true);
    expect(diagnose({ graph: g, contracts: [], changed: [], defects: [] }).rootCause).toBeNull();
    const tie = diagnose({ graph: g, contracts: [], changed: ["src/a.js", "src/b.js"], defects: [{ signature: "1", category: "code", title: "t1", files: ["src/a.js"], failingTests: ["t1"], output: "" }, { signature: "2", category: "code", title: "t2", files: ["src/b.js"], failingTests: ["t2"], output: "" }] });
    expect(tie.ambiguous).toBe(true);
    expect(tie.rootCause).toBeNull();
  });
});

describe("operational readiness from evidence", () => {
  it("distinguishes passed, failed, warning and not_run; never passes monitoring it cannot observe", async () => {
    const { operationalChecks } = await import("@/lib/factory/operations");
    const f = files({ "src/routes/rates.js": 'module.exports = () => fetch("https://api.x.example.org/v1");' });
    const idx = await buildIndex(f);
    const g = buildGraph({ index: idx, files: f });
    const c = operationalChecks(f, g, null, { required: ["NOTES_API_KEY"], provided: null });
    const st = Object.fromEntries(c.map((x) => [x.id, x.status]));
    expect(st.health).toBe("warning"); // route exists, not observed on a deployment
    expect(st.timeouts).toBe("failed"); // outbound call without a timeout
    expect(st.config).toBe("not_run"); // no target → cannot compare
    expect(st.monitoring).toBe("not_run");
    expect(st.backups).toBe("not_run");
    const live = operationalChecks(files(), buildGraph({ index: await buildIndex(files()), files: files() }), { health: [{ path: "/api/health", ok: true }], restartVerified: true }, { required: ["NOTES_API_KEY"], provided: [] });
    const s2 = Object.fromEntries(live.map((x) => [x.id, x.status]));
    expect([s2.health, s2.restart, s2.config]).toEqual(["passed", "passed", "failed"]);
  });
});
