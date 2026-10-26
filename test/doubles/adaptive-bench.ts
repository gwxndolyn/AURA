/**
 * TEST SCENARIO (automated tests ONLY) — V16 strategy benchmark: 8 small,
 * different engineering tasks on the node-web starter.
 *
 * This double plays the MODEL only; every tool call it returns is executed for
 * real by AURA (files written to the working tree, npm test run, git commits).
 * Its behaviour model is deliberately simple and stated here so results are
 * interpretable — it does NOT measure live model quality:
 *
 *  - The engineer follows the instructions it is given. When its objective
 *    tells it to investigate / reproduce first (strategy or feedback
 *    controller), it spends one extra turn reading code.
 *  - "trap" tasks: the correct implementation depends on code the agent only
 *    sees if it investigated; without that it writes a plausible but wrong
 *    version (attempt 1). With real failure feedback (a repair attempt) it
 *    writes the correct version — as a capable agent would.
 *  - "stuck" task: the agent never finds the fix (always the same wrong code).
 *  - Tests it writes are named after the acceptance criteria. QA (scripted)
 *    marks a criterion met only when a test with that name is in the diff AND
 *    the engine's test run shows `fail 0` — no evidence, no "met".
 */
import { text, tool, lastUserText, type Responder } from "./anthropic";
import { STACKS } from "../../src/lib/builder/stacks";

export const IDEA = "Build a small notes service API (V16 strategy benchmark).";

export const BRIEF = {
  title: "Notes API",
  problem: "A team needs a tiny notes service with a few operational endpoints.",
  personas: [{ name: "Developer", needs: ["Simple JSON endpoints"] }],
  outcomes: ["Endpoints respond with correct JSON"],
  functional: [{ id: "FR-1", text: "The service exposes small JSON endpoints" }],
  nonFunctional: [{ id: "NFR-1", text: "Input is validated server-side" }],
  mvp: ["Endpoints"],
  outOfScope: ["UI"],
  journeys: [{ name: "Call the API", steps: ["Request", "Read JSON"] }],
  acceptance: [{ id: "AC-1", text: "Each endpoint returns the documented JSON", measurable: true }],
  assumptions: [{ id: "A-1", text: "Single tenant", editable: true }],
  risks: ["None"],
  questions: [],
  milestones: [{ id: "M1", name: "MVP", goal: "Endpoints" }],
};

interface Spec {
  key: string; title: string; description: string; acceptance: string[]; files: string[]; risk: "LOW" | "MEDIUM" | "HIGH";
  /** Route file + test file content; `ok` = correct implementation. */
  route: (ok: boolean) => string;
  tests: (complete: boolean) => string;
  trap?: boolean; stuck?: boolean; name: string;
}

const get = (name: string, body: string) => `const { json } = require("../http");\nmodule.exports.routes = [{ method: "GET", pattern: /^\\/api\\/${name}$/, handler: (req, res) => json(res, 200, ${body}) }];\n`;
const T = (title: string, path: string, check: string, init = "") => `test(${JSON.stringify(title)}, async () => { const app = await start(); try { ${init}const r = await fetch(app.url + ${JSON.stringify(path)}); const body = await r.json(); ${check} } finally { await app.close(); } });\n`;
const HEAD = `const test = require("node:test");\nconst assert = require("node:assert");\nconst { start } = require("../testing");\n`;

export const SPECS: Spec[] = [
  { key: "E1.S1.T1", name: "version", title: "Add a version endpoint", description: "GET /api/version returns the service version.", acceptance: ["GET /api/version returns version 1.0.0"], files: ["src/routes/version.js"], risk: "LOW",
    route: () => get("version", `{ version: "1.0.0" }`), tests: () => HEAD + T("GET /api/version returns version 1.0.0", "/api/version", `assert.strictEqual(r.status, 200); assert.strictEqual(body.version, "1.0.0");`) },
  { key: "E1.S1.T2", name: "ping", title: "Add a ping endpoint", description: "GET /api/ping answers pong.", acceptance: ["GET /api/ping returns pong"], files: ["src/routes/ping.js"], risk: "LOW",
    route: () => get("ping", `{ pong: true }`), tests: () => HEAD + T("GET /api/ping returns pong", "/api/ping", `assert.strictEqual(body.pong, true);`) },
  { key: "E1.S1.T3", name: "notecount", title: "Fix the note count endpoint returning a string", description: "GET /api/notecount returns the count as a string; clients expect a number.", acceptance: ["GET /api/notecount returns the count as a number"], files: ["src/routes/notecount.js"], risk: "LOW", trap: true,
    route: (ok) => get("notecount", ok ? `{ count: 0 }` : `{ count: String(0) }`), tests: () => HEAD + T("GET /api/notecount returns the count as a number", "/api/notecount", `assert.strictEqual(typeof body.count, "number");`) },
  { key: "E1.S1.T4", name: "stats", title: "Expose route statistics", description: "Add an endpoint that reports how many API routes the service registers (find where routes are registered).", acceptance: ["GET /api/stats returns the number of registered API routes"], files: [], risk: "LOW", trap: true,
    // Correct: count from the router table (health + stats = 2). Without reading src/app.js the agent guesses 1.
    route: (ok) => `const { json } = require("../http");\nmodule.exports.routes = [{ method: "GET", pattern: /^\\/api\\/stats$/, handler: (req, res) => json(res, 200, { routes: ${ok ? `require("../app").ROUTES.length` : "1"} }) }];\n`,
    tests: () => HEAD + T("GET /api/stats returns the number of registered API routes", "/api/stats", `assert.strictEqual(body.routes, require("../app").ROUTES.length);`) },
  { key: "E1.S1.T5", name: "info", title: "Add a service info endpoint", description: "GET /api/info returns name, version, uptime and node version.", acceptance: ["GET /api/info returns the service name", "GET /api/info returns the version", "GET /api/info returns uptime in seconds"], files: ["src/routes/info.js", "src/routes/info.test.js", "src/info-data.js"], risk: "LOW",
    route: () => get("info", `{ name: "notes", version: "1.0.0", uptime: Math.round(process.uptime()) }`),
    tests: () => HEAD + T("GET /api/info returns the service name", "/api/info", `assert.strictEqual(body.name, "notes");`) + T("GET /api/info returns the version", "/api/info", `assert.strictEqual(body.version, "1.0.0");`) + T("GET /api/info returns uptime in seconds", "/api/info", `assert.strictEqual(typeof body.uptime, "number");`) },
  { key: "E1.S1.T6", name: "notes", title: "Only admins may delete notes", description: "DELETE /api/notes/:id must check the caller's role (x-role header): admins may delete, everyone else is refused.", acceptance: ["Admins can delete a note", "Non-admins get 403"], files: ["src/routes/notes.js"], risk: "MEDIUM", trap: true,
    route: (ok) => `const { json } = require("../http");\nmodule.exports.routes = [{ method: "DELETE", pattern: /^\\/api\\/notes\\/(?<id>\\w+)$/, handler: (req, res) => ${ok ? `req.headers["x-role"] === "admin" ? json(res, 200, { deleted: true }) : json(res, 403, { error: "forbidden" })` : `json(res, 200, { deleted: true })`} }];\n`,
    tests: (complete) => HEAD
      + `test("Admins can delete a note", async () => { const app = await start(); try { const r = await fetch(app.url + "/api/notes/1", { method: "DELETE", headers: { "x-role": "admin" } }); assert.strictEqual(r.status, 200); } finally { await app.close(); } });\n`
      + (complete ? `test("Non-admins get 403", async () => { const app = await start(); try { const r = await fetch(app.url + "/api/notes/1", { method: "DELETE", headers: { "x-role": "viewer" } }); assert.strictEqual(r.status, 403); } finally { await app.close(); } });\n` : "") },
  { key: "E1.S2.T1", name: "sum", title: "Add a sum endpoint", description: "GET /api/sum returns 2 + 3.", acceptance: ["GET /api/sum returns 5"], files: ["src/routes/sum.js"], risk: "LOW", stuck: true,
    route: () => get("sum", `{ sum: 2 + 4 }`), tests: () => HEAD + T("GET /api/sum returns 5", "/api/sum", `assert.strictEqual(body.sum, 5);`) },
  { key: "E1.S2.T2", name: "dashboard", title: "Improve the admin dashboard", description: "Make the admin dashboard better.", acceptance: ["The admin dashboard feels nicer"], files: ["src/routes/dashboard.js"], risk: "MEDIUM",
    route: () => get("dashboard", `{ widgets: [] }`), tests: () => HEAD + T("The admin dashboard feels nicer", "/api/dashboard", `assert.strictEqual(r.status, 200);`) },
];

export const BACKLOG = {
  epics: [{ key: "E1", title: "Endpoints", stories: [
    { key: "E1.S1", title: "Core endpoints", acceptance: ["Endpoints respond"], milestone: "M1", tasks: SPECS.filter((s) => s.key.startsWith("E1.S1.")).map(task) },
    { key: "E1.S2", title: "More endpoints", acceptance: ["Endpoints respond"], milestone: "M1", tasks: SPECS.filter((s) => s.key.startsWith("E1.S2.")).map(task) },
  ] }],
};
function task(s: Spec) {
  return { key: s.key, title: s.title, description: s.description, kind: "BACKEND", acceptance: s.acceptance, dependsOn: [], effort: 1, risk: s.risk, files: s.files, requirements: ["FR-1"] };
}

const STARTER_APP = STACKS["node-web"].files["src/app.js"];
const appWith = (name: string) => STARTER_APP.replace('const health = require("./routes/health");', `const health = require("./routes/health");\nconst ${name} = require("./routes/${name}");`).replace("const ROUTES = [...health.routes];", `const ROUTES = [...health.routes, ...${name}.routes];`);

/** Did the instructions this agent received tell it to investigate / reproduce before editing? */
const INVESTIGATE = /First reproduce the defect|Before editing anything, investigate|investigate first|Strategy change \(feedback controller\)/;

export function benchScripted(): Responder & { engineerTurns: Record<string, number> } {
  const engineerTurns: Record<string, number> = {};
  const fn = ((req) => {
    const u = lastUserText(req.messages);
    if (/Product Manager/.test(req.system) && /backlog/i.test(req.system)) return [text(JSON.stringify(BACKLOG))];
    if (/Product Manager/.test(req.system)) return [text(JSON.stringify(BRIEF))];
    const first = typeof req.messages[0]?.content === "string" ? (req.messages[0].content as string) : "";
    const key = first.match(/# Task (E\d+\.S\d+\.T\d+)/)?.[1] ?? first.match(/Task (E\d+\.S\d+\.T\d+):/)?.[1];
    const spec = SPECS.find((s) => s.key === key);
    if (spec && /You are Atlas|Backend Engineer/.test(req.system)) {
      const objective = first.split("# Your objective")[1] ?? "";
      const investigated = INVESTIGATE.test(objective);
      const repairing = /What failed last time/.test(first);
      const turn = (req.messages.length - 1) / 2; // assistant turns so far in this conversation
      if (turn === 0) engineerTurns[spec.key] = (engineerTurns[spec.key] ?? 0) + 1;
      const steps = [...(investigated ? ["read"] : []), "write", "run", "done"];
      const step = steps[Math.min(turn, steps.length - 1)];
      const correct = spec.stuck ? false : !spec.trap || investigated || repairing;
      if (step === "read") return [tool("fs_read", { path: "src/app.js" })];
      if (step === "write") return [
        tool("fs_write", { path: `src/routes/${spec.name}.js`, content: spec.route(correct) }),
        tool("fs_write", { path: `src/routes/${spec.name}.test.js`, content: spec.tests(correct) }),
        tool("fs_write", { path: "src/app.js", content: appWith(spec.name) }),
      ];
      if (step === "run") return [tool("cmd_run", { command: "npm test", purpose: "test" })];
      return [text(`Implemented ${spec.title}.`)];
    }
    // QA / security / reviewer: evidence-only judgement from what the engine shows them.
    const passed = /^[#ℹ] fail 0$/m.test(u);
    const crits = [...(u.split("# Acceptance criteria\n")[1] ?? "").split("\n\n")[0].matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
    const criteria = crits.map((t) => {
      const tested = u.includes(`test(${JSON.stringify(t)}`);
      return { text: t, status: passed && tested ? "met" : passed ? "unverified" : "not_met", evidence: passed && tested ? `test "${t}" passes in the engine's run` : passed ? "no test exercises this criterion" : "test run failed" };
    });
    const ok = passed && criteria.every((c) => c.status === "met");
    return [text(JSON.stringify({ verdict: ok ? "approve" : "request_changes", criteria, findings: [], confidence: "medium", notVerified: [] }))];
  }) as Responder & { engineerTurns: Record<string, number> };
  fn.engineerTurns = engineerTurns;
  return fn;
}
