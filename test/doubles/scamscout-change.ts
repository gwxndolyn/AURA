/**
 * TEST SCENARIO (automated tests only): a follow-up change request on the
 * deployed ScamScout app — "add a GET /api/assessments/:id endpoint". The PM
 * plans ONE targeted task on existing files; the engineer reads the CURRENT
 * route file from the release branch and adds the endpoint + a test without
 * touching anything else. Existing tests must still pass (regression).
 */
import { text, tool, lastUserText } from "./anthropic";

export const CHANGE_REQUEST = "Customers need to open a single past assessment: add GET /api/assessments/:id that returns one assessment, or 404 if it does not exist.";

export const CHANGE_PLAN = {
  summary: "Add GET /api/assessments/:id to fetch a single assessment",
  kind: "feature",
  tasks: [{ title: "Single-assessment endpoint", description: "Add GET /api/assessments/:id to the existing assessments route table, returning 404 for unknown ids, with tests.", kind: "BACKEND", acceptance: ["GET /api/assessments/:id returns the stored assessment", "Unknown ids return 404"], files: ["src/routes/assessments.js", "src/routes/assessment-get.test.js"], dependsOnIndex: [], risk: "LOW" }],
  preserves: ["POST /api/assessments scoring and validation", "GET /api/assessments listing", "health endpoint and frontend"],
};

const GET_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { start } = require("../testing");
test("fetches one assessment by id", async () => {
  const app = await start();
  try {
    const c = await fetch(app.url + "/api/assessments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing: "Wire transfer needed" }) });
    const created = await c.json();
    const r = await fetch(app.url + "/api/assessments/" + created.id);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).id, created.id);
  } finally { await app.close(); }
});
test("unknown id is 404", async () => {
  const app = await start();
  try { const r = await fetch(app.url + "/api/assessments/does-not-exist"); assert.strictEqual(r.status, 404); } finally { await app.close(); }
});
`;

/** Responder for the change phase; delegates everything else to `base`. */
export function changeScripted(base: (req: { system: string; messages: { role: string; content: unknown }[]; tools: { name: string }[] }) => unknown) {
  let step = 0;
  return (req: { system: string; messages: { role: string; content: unknown }[]; tools: { name: string }[] }) => {
    const u = lastUserText(req.messages);
    if (/maintaining an EXISTING application/.test(req.system)) return [text(JSON.stringify(CHANGE_PLAN))];
    if ((/You are Atlas/.test(req.system) || /Backend Engineer/.test(req.system)) && /Single-assessment endpoint/.test(JSON.stringify(req.messages[0] ?? ""))) {
      if (req.messages.length === 1) step = 0;
      step++;
      if (step === 1) return [tool("fs_read", { path: "src/routes/assessments.js" })];
      if (step === 2) {
        const src = (JSON.parse(u) as { content: string }).content;
        if (!src.includes("toLowerCase")) throw new Error("change started from a base without the released fix");
        const next = src
          .replace("module.exports.routes = [", 'function getOne(req, res, ctx) { const a = store.get("assessments", ctx.params.id); return a ? json(res, 200, a) : json(res, 404, { error: "not found" }); }\nmodule.exports.routes = [{ method: "GET", pattern: /^\\/api\\/assessments\\/(?<id>[\\w-]+)$/, handler: getOne }, ');
        return [tool("fs_write", { path: "src/routes/assessments.js", content: next }), tool("fs_write", { path: "src/routes/assessment-get.test.js", content: GET_TEST })];
      }
      if (step === 3) return [tool("cmd_run", { command: "npm test", purpose: "test" })];
      return [text("Added GET /api/assessments/:id with tests; existing routes unchanged.")];
    }
    if (!/You are Atlas|Backend Engineer|Product Manager/.test(req.system) && /Single-assessment endpoint|GET \/api\/assessments\/:id/.test(u)) {
      const passed = /^[#ℹ] fail 0$/m.test(u);
      return [text(JSON.stringify({ criteria: CHANGE_PLAN.tasks[0].acceptance.map((t) => ({ text: t, status: passed ? "met" : "not_met", evidence: passed ? "src/routes/assessment-get.test.js passes in the sandbox; existing tests also pass" : "tests failed" })), findings: [] }))];
    }
    return base(req);
  };
}
