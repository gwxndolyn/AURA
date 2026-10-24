/**
 * Stack templates a new product starts from. Each is a minimal, real,
 * runnable project with a working test command; agents build the product on
 * top of it. Existing repositories (imported from GitHub) are detected
 * instead (see detect.ts).
 *
 * node-web: dependency-free Node 20 HTTP server + static frontend, tests with
 * the built-in `node --test` runner, so verification needs no package
 * installation. Agents may add dependencies; installs run in a separate
 * sandbox step with registry network access.
 */

export interface Stack {
  id: string;
  label: string;
  description: string;
  files: Record<string, string>;
  conventions: string;
}

const PKG = (name: string) => JSON.stringify({
  name,
  version: "0.1.0",
  private: true,
  type: "commonjs",
  engines: { node: ">=20" },
  scripts: { start: "node src/server.js", test: "node --test", check: "node scripts/check.js" },
}, null, 2) + "\n";

export const STACKS: Record<string, Stack> = {
  "node-web": {
    id: "node-web",
    label: "Node.js web app",
    description: "Node 20 HTTP server with a JSON API, a static HTML/CSS/JS frontend and node:test tests. No build step.",
    conventions: [
      "CommonJS modules, Node 20, no framework.",
      "src/server.js exports createServer() (does not listen on import) and starts listening only when run directly.",
      "API routes live in src/routes/*.js and are registered in src/app.js; each exports handle(req, res, ctx) or a route table.",
      "Data is stored through src/store.js (JSON file under DATA_DIR, default ./data). Validate all input; never trust the client.",
      "Frontend lives in public/ (index.html, styles.css, app.js) and calls the JSON API with fetch.",
      "Tests live next to the code as *.test.js using node:test + node:assert, and exercise the real HTTP API via createServer() on an ephemeral port.",
      "npm test must pass; scripts/check.js runs node --check on every source file.",
    ].join("\n"),
    files: {
      "package.json": PKG("app"),
      ".gitignore": "node_modules/\ndata/\n",
      "README.md": "# App\n\nRun: `npm start` (http://localhost:3000). Test: `npm test`.\n",
      "scripts/check.js": `// Syntax-checks every .js file (no dependencies).
const { execFileSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    if (e === "node_modules" || e.startsWith(".") || e === "data") continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) files.push(p);
  }
})(".");
for (const f of files) execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
console.log(\`checked \${files.length} files\`);
`,
      "src/store.js": `// Minimal JSON-file store. One file per collection under DATA_DIR.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const DIR = () => process.env.DATA_DIR || path.join(process.cwd(), "data");
function file(c) { return path.join(DIR(), c + ".json"); }
function all(c) { try { return JSON.parse(fs.readFileSync(file(c), "utf8")); } catch { return []; } }
function save(c, rows) { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(file(c), JSON.stringify(rows, null, 2)); }
function insert(c, row) { const r = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...row }; save(c, [...all(c), r]); return r; }
function get(c, id) { return all(c).find((r) => r.id === id) || null; }
function update(c, id, patch) { const rows = all(c); const i = rows.findIndex((r) => r.id === id); if (i < 0) return null; rows[i] = { ...rows[i], ...patch }; save(c, rows); return rows[i]; }
function remove(c, id) { const rows = all(c); const next = rows.filter((r) => r.id !== id); save(c, next); return next.length !== rows.length; }
module.exports = { all, insert, get, update, remove };
`,
      "src/http.js": `// Small helpers: JSON responses, body parsing with a size limit, static files.
const fs = require("node:fs");
const path = require("node:path");
function json(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("payload too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("invalid JSON"), { status: 400 })); } });
  });
}
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json" };
function serveStatic(req, res, root) {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const p = path.normalize(path.join(root, rel === "/" ? "index.html" : rel));
  if (!p.startsWith(root)) return json(res, 403, { error: "forbidden" });
  fs.readFile(p, (err, data) => { if (err) return json(res, 404, { error: "not found" }); res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" }); res.end(data); });
}
module.exports = { json, readJson, serveStatic };
`,
      "src/app.js": `// Request router: /api/* → route handlers, everything else → static frontend.
const path = require("node:path");
const { json, serveStatic } = require("./http");
const health = require("./routes/health");
const ROUTES = [...health.routes];
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    for (const r of ROUTES) {
      const m = r.method === req.method && url.pathname.match(r.pattern);
      if (m) {
        try { return await r.handler(req, res, { params: m.groups || {}, query: url.searchParams }); }
        catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "internal error" }); }
      }
    }
    return json(res, 404, { error: "not found" });
  }
  return serveStatic(req, res, path.join(__dirname, "..", "public"));
}
module.exports = { handle, ROUTES };
`,
      "src/routes/health.js": `const { json } = require("../http");
module.exports.routes = [{ method: "GET", pattern: /^\\/api\\/health$/, handler: (req, res) => json(res, 200, { ok: true }) }];
`,
      "src/server.js": `const http = require("node:http");
const { handle } = require("./app");
function createServer() { return http.createServer((req, res) => handle(req, res)); }
if (require.main === module) { const port = Number(process.env.PORT || 3000); createServer().listen(port, () => console.log("listening on " + port)); }
module.exports = { createServer };
`,
      "src/testing.js": `// Start the app on an ephemeral port with an isolated data dir; returns { url, close }.
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./server");
async function start() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "app-data-"));
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + s.address().port;
  return { url, close: () => new Promise((r) => s.close(r)) };
}
module.exports = { start };
`,
      "src/server.test.js": `const test = require("node:test");
const assert = require("node:assert");
const { start } = require("./testing");
test("health endpoint responds", async () => {
  const app = await start();
  try {
    const r = await fetch(app.url + "/api/health");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true });
  } finally { await app.close(); }
});
test("frontend is served", async () => {
  const app = await start();
  try {
    const r = await fetch(app.url + "/");
    assert.strictEqual(r.status, 200);
    assert.match(await r.text(), /<html/i);
  } finally { await app.close(); }
});
`,
      "public/index.html": `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>App</title><link rel="stylesheet" href="/styles.css"></head>
<body><main id="app"><h1>App</h1><p>Starting point. AURA's agents build the product here.</p></main><script src="/app.js"></script></body>
</html>
`,
      "public/styles.css": `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; } main { max-width: 960px; margin: 0 auto; padding: 24px; }
`,
      "public/app.js": `// Frontend entry point.
`,
    },
  },
};

export function stackFor(id: string | null | undefined): Stack {
  return STACKS[id ?? ""] ?? STACKS["node-web"];
}
