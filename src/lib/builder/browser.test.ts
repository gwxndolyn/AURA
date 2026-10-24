/**
 * Browser verification on REAL infrastructure: the app runs in an isolated
 * Docker container, real Chromium (Playwright) drives it. Skipped — not faked —
 * when Docker or Chromium is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { stackFor } from "./stacks";
import { verifyInBrowser, browserAvailable, collectionRoutes, routesFrom, browserBrief } from "./browser";

let ok = false;
const dirs: string[] = [];
beforeAll(async () => {
  ok = (await browserAvailable()).ok;
}, 30_000);
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tree(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "aura-browser-"));
  dirs.push(d);
  for (const [p, c] of Object.entries({ ...stackFor("node-web").files, ...files })) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  chmodSync(d, 0o755);
  return d;
}

const ROUTE = (persist: boolean) => `const { json, readJson } = require("../http");
const store = require("../store");
const mem = [];
async function create(req, res) {
  const b = await readJson(req);
  if (typeof b.title !== "string" || !b.title.trim()) return json(res, 400, { error: "title is required" });
  const row = ${persist ? 'store.insert("notes", { title: b.title.trim() })' : '(mem.push({ id: String(mem.length), title: b.title.trim() }), mem[mem.length - 1])'};
  return json(res, 201, row);
}
module.exports.routes = [
  { method: "POST", pattern: /^\\/api\\/notes$/, handler: create },
  { method: "GET", pattern: /^\\/api\\/notes$/, handler: (req, res) => json(res, 200, ${persist ? 'store.all("notes")' : "[]"}) },
];
`;
const APP = stackFor("node-web").files["src/app.js"].replace('const health = require("./routes/health");', 'const health = require("./routes/health");\nconst notes = require("./routes/notes");').replace("const ROUTES = [...health.routes];", "const ROUTES = [...health.routes, ...notes.routes];");
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Notes</title><link rel="stylesheet" href="/styles.css"></head>
<body><main><h1>Notes</h1><form id="f"><label for="t">Title</label><input id="t" name="title" required><button type="submit">Add note</button></form><ul id="list" data-testid="list"></ul></main><script src="/app.js"></script></body></html>`;
const JS = `async function load(){const r=await fetch("/api/notes");const rows=await r.json();document.getElementById("list").innerHTML=rows.map(n=>"<li>"+n.title.replace(/</g,"&lt;")+"</li>").join("");}
document.getElementById("f").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("t");const r=await fetch("/api/notes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:t.value})});if(r.ok){t.value="";await load();}});
load();`;
const API = [{ method: "GET", path: "/api/health" }, { method: "POST", path: "/api/notes" }, { method: "GET", path: "/api/notes" }];

describe("browser verification helpers", () => {
  it("finds pages and collection APIs from the code index", () => {
    expect(routesFrom(["public/index.html", "public/about.html", "src/app.js"])).toEqual(["/", "/about.html"]);
    expect(collectionRoutes(API)).toEqual(["/api/notes"]);
  });
});

describe("browser verification (real Docker + Chromium)", () => {
  it("a working app passes: pages load at both viewports, controls are labeled, create → reload persists", async (t) => {
    if (!ok) return t.skip();
    const dir = tree({ "src/routes/notes.js": ROUTE(true), "src/app.js": APP, "public/index.html": HTML, "public/app.js": JS });
    const r = await verifyInBrowser({ treeDir: dir, buildId: "browsertestgood1", files: ["package.json", "src/server.js", "public/index.html"], apiRoutes: API, evidenceDir: join(dir, ".evidence") });
    if (r.status !== "passed") console.log(JSON.stringify(r, null, 2));
    expect(r.status).toBe("passed");
    expect(r.routes.map((x) => x.viewport).sort()).toEqual(["desktop", "mobile"]);
    expect(r.routes.every((x) => x.httpStatus === 200 && x.screenshot)).toBe(true);
    expect(r.journeys).toEqual([expect.objectContaining({ status: "passed" })]);
  }, 120_000);

  it("a persistence bug, an unlabeled field and mobile overflow are found and described for the engineer", async (t) => {
    if (!ok) return t.skip();
    const bad = HTML.replace('<label for="t">Title</label>', "").replace("</main>", '<div style="width:900px">wide banner</div></main>');
    const dir = tree({ "src/routes/notes.js": ROUTE(false), "src/app.js": APP, "public/index.html": bad, "public/app.js": JS });
    const r = await verifyInBrowser({ treeDir: dir, buildId: "browsertestbad01", files: ["package.json", "src/server.js", "public/index.html"], apiRoutes: API, evidenceDir: join(dir, ".evidence") });
    expect(r.status).toBe("failed");
    const kinds = new Set(r.findings.map((f) => f.kind));
    expect(kinds.has("unlabeled_control")).toBe(true);
    expect(r.findings.some((f) => f.kind === "overflow" && f.viewport === "mobile" && f.blocking)).toBe(true);
    expect(r.journeys[0]).toMatchObject({ status: "failed" });
    expect(browserBrief(r)).toMatch(/journey "create → reload → persists": failed/);
  }, 120_000);

  it("an app that never starts is reported as failed with its log, not as passed", async (t) => {
    if (!ok) return t.skip();
    const dir = tree({ "src/server.js": "throw new Error('boom at startup');" });
    const r = await verifyInBrowser({ treeDir: dir, buildId: "browsertestdead1", files: ["package.json", "src/server.js", "public/index.html"], apiRoutes: [], evidenceDir: join(dir, ".evidence"), startTimeoutMs: 6000 });
    expect(r.status).toBe("failed");
    expect(r.findings[0]).toMatchObject({ kind: "load_failed", blocking: true });
    expect(r.findings[0].detail).toMatch(/boom at startup/);
  }, 60_000);
});
