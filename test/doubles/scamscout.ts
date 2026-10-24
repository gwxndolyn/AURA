/**
 * TEST SCENARIO — what a model would answer for the "ScamScout" product, used
 * by automated tests ONLY (vitest and the e2e model double). Plans are JSON;
 * the engineer answers with tool_use blocks that AURA then REALLY executes
 * (files written to the working tree, npm test run in the Docker sandbox).
 * Attempt 1 contains a real bug that the real test catches; the repair fixes it.
 */
import { text, tool, lastUserText } from "./anthropic";

export const BRIEF = {
  title: "ScamScout",
  problem: "Job seekers cannot tell whether a listing is a scam.",
  personas: [{ name: "Job seeker", needs: ["Check a listing quickly"] }],
  outcomes: ["A user gets a risk score for a listing in under a minute"],
  functional: [{ id: "FR-1", text: "Users can submit a job listing and get a risk assessment" }],
  nonFunctional: [{ id: "NFR-1", text: "Input is validated server-side" }],
  mvp: ["Submit listing", "Risk score"],
  outOfScope: ["Payments"],
  journeys: [{ name: "Check a listing", steps: ["Paste listing", "See risk score"] }],
  acceptance: [{ id: "AC-1", text: "Listings asking for upfront payment are rated high risk", measurable: true }],
  assumptions: [{ id: "A-1", text: "English listings only", editable: true }],
  risks: ["False positives"],
  questions: [],
  milestones: [{ id: "M1", name: "MVP", goal: "Submit and assess listings" }],
};
export const BACKLOG = {
  epics: [{ key: "E1", title: "MVP", stories: [{ key: "E1.S1", title: "Assess a listing", acceptance: ["Risk is computed"], milestone: "M1", tasks: [
    { key: "E1.S1.T1", title: "Risk scoring API", description: "POST /api/assessments scores a listing for scam indicators and stores it.", kind: "BACKEND", acceptance: ["POST /api/assessments returns a risk level", "Listings asking for upfront payment are rated high risk", "Empty listings are rejected with 400"], dependsOn: [], effort: 3, risk: "MEDIUM", files: ["src/routes/assessments.js"], requirements: ["FR-1", "AC-1"] },
  ] }] }],
};

// Code the scripted "engineer" writes. Attempt 1 has a real bug (payment keyword check is case-sensitive) that the real test catches.
export const ROUTE_BUGGY = `const { json, readJson } = require("../http");
const store = require("../store");
const SIGNALS = [["upfront payment", 50], ["wire transfer", 30], ["no experience", 10], ["whatsapp", 20]];
function score(text) {
  let s = 0; const hits = [];
  for (const [k, w] of SIGNALS) if (text.includes(k)) { s += w; hits.push(k); }
  return { score: s, level: s >= 50 ? "high" : s >= 20 ? "medium" : "low", indicators: hits };
}
async function create(req, res) {
  const body = await readJson(req);
  if (typeof body.listing !== "string" || !body.listing.trim()) return json(res, 400, { error: "listing is required" });
  const a = store.insert("assessments", { listing: body.listing.slice(0, 5000), ...score(body.listing) });
  return json(res, 201, a);
}
module.exports.routes = [{ method: "POST", pattern: /^\\/api\\/assessments$/, handler: create }, { method: "GET", pattern: /^\\/api\\/assessments$/, handler: (req, res) => json(res, 200, store.all("assessments")) }];
module.exports.score = score;
`;
export const ROUTE_FIXED = ROUTE_BUGGY.replace("if (text.includes(k))", "if (text.toLowerCase().includes(k))");
export const ROUTE_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { start } = require("../testing");
async function post(app, body) { const r = await fetch(app.url + "/api/assessments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }
test("returns a risk level", async () => { const app = await start(); try { const r = await post(app, { listing: "Junior developer role" }); assert.strictEqual(r.status, 201); assert.ok(["low", "medium", "high"].includes(r.body.level)); } finally { await app.close(); } });
test("upfront payment is high risk", async () => { const app = await start(); try { const r = await post(app, { listing: "Great job! Upfront Payment of $200 required for training." }); assert.strictEqual(r.body.level, "high"); } finally { await app.close(); } });
test("empty listing is rejected", async () => { const app = await start(); try { const r = await post(app, { listing: "  " }); assert.strictEqual(r.status, 400); } finally { await app.close(); } });
`;
export const APP_PATCH = (src: string) => src.includes("./routes/assessments") ? src : src.replace('const health = require("./routes/health");', 'const health = require("./routes/health");\nconst assessments = require("./routes/assessments");').replace("const ROUTES = [...health.routes];", "const ROUTES = [...health.routes, ...assessments.routes];");


/** Scripted model: plans as JSON; the engineer issues REAL tool calls; reviewers answer from what they are shown. */
export function scripted(opts: { fixOnRepair: boolean }) {
  let engineerStep = 0;
  let attempt = 0;
  return (req: { system: string; messages: { role: string; content: unknown }[]; tools: { name: string }[] }) => {
    const u = lastUserText(req.messages);
    if (/Product Manager/.test(req.system) && /backlog/i.test(req.system)) return [text(JSON.stringify(BACKLOG))];
    if (/Product Manager/.test(req.system)) return [text(JSON.stringify(BRIEF))];
    if (/You are Atlas/.test(req.system) || /Backend Engineer/.test(req.system)) {
      if (req.messages.length === 1) {
        engineerStep = 0;
        if (/What failed last time/.test(u)) attempt++;
      }
      engineerStep++;
      const repairing = attempt > 0;
      if (engineerStep === 1) return [tool("fs_read", { path: "src/app.js" })];
      if (engineerStep === 2) {
        const appSrc = (JSON.parse(u) as { content: string }).content;
        return [tool("fs_write", { path: "src/routes/assessments.js", content: repairing && opts.fixOnRepair ? ROUTE_FIXED : ROUTE_BUGGY }), tool("fs_write", { path: "src/routes/assessments.test.js", content: ROUTE_TEST }), tool("fs_write", { path: "src/app.js", content: APP_PATCH(appSrc) })];
      }
      if (engineerStep === 3) return [tool("cmd_run", { command: "npm test", purpose: "test" })];
      return [text(repairing ? "Fixed case-insensitive matching." : "Implemented the assessment API with tests.")];
    }
    // QA / security / reviewer: judge from the recorded verification output they are given.
    const passed = /^[#ℹ] fail 0$/m.test(u);
    const crit = BACKLOG.epics[0].stories[0].tasks[0].acceptance.map((t) => ({ text: t, status: passed ? "met" : "not_met", evidence: passed ? "covered by src/routes/assessments.test.js, passing in the sandbox run" : "test run failed" }));
    return [text(JSON.stringify({ criteria: crit, findings: [] }))];
  };
}

