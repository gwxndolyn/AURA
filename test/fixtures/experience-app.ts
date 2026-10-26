/**
 * TEST FIXTURE (automated tests ONLY) — a tiny notes app on the node-web
 * starter with planted, documented experience defects, plus the corrected
 * version. Used by the experience audit tests to check the inspector finds
 * real problems in a real browser and stops reporting them once fixed.
 *
 * Planted in BUGGY (each maps to one rubric rule):
 *  - form:success_not_reflected  — after POST the list is not reloaded
 *  - form:no_validation_feedback — no `required`, no error message, novalidate
 *  - form:error_not_recoverable  — server error is ignored, input cleared
 *  - control:inert               — "Export" button with no handler
 *  - axe:label                   — the title input has no label
 *  - axe:color-contrast          — light-grey hint text on white
 *  - responsive:overflow         — fixed 900px wide banner on mobile
 *  - nav:broken_link             — link to /help.html which does not exist
 *  - a11y:reduced_motion_ignored — transition without prefers-reduced-motion
 */
import { stackFor } from "../../src/lib/builder/stacks";

const ROUTE = `const { json, readJson } = require("../http");
const store = require("../store");
async function create(req, res) {
  const b = await readJson(req);
  if (typeof b.title !== "string" || !b.title.trim()) return json(res, 400, { error: "title is required" });
  return json(res, 201, store.insert("notes", { title: b.title.trim().slice(0, 200) }));
}
module.exports.routes = [
  { method: "POST", pattern: /^\\/api\\/notes$/, handler: create },
  { method: "GET", pattern: /^\\/api\\/notes$/, handler: (req, res) => json(res, 200, store.all("notes")) },
];
`;
export const APP = stackFor("node-web").files["src/app.js"].replace('const health = require("./routes/health");', 'const health = require("./routes/health");\nconst notes = require("./routes/notes");').replace("const ROUTES = [...health.routes];", "const ROUTES = [...health.routes, ...notes.routes];");

const HTML_BUGGY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Notes</title><link rel="stylesheet" href="/styles.css"></head>
<body><main><h1>Notes</h1><div class="banner">Welcome to the notes app — keep your thoughts in one place</div>
<p class="hint">Write a short title and press add.</p>
<form id="f" novalidate><input id="t" name="title" placeholder="Title"><button type="submit">Add note</button></form>
<button type="button" class="export">Export</button>
<ul id="list"></ul><a href="/help.html">Help</a></main><script src="/app.js"></script></body></html>`;
const CSS_BUGGY = `body { margin: 0; font-family: system-ui; } main { padding: 16px; }
.banner { width: 900px; background: #eef; padding: 8px; }
.hint { color: #c8c8c8; }
button { transition: background 0.3s; }
`;
const JS_BUGGY = `async function load(){const r=await fetch("/api/notes");const rows=await r.json();document.getElementById("list").innerHTML=rows.map(n=>"<li>"+n.title.replace(/</g,"&lt;")+"</li>").join("");}
document.getElementById("f").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("t");await fetch("/api/notes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:t.value})});t.value="";});
load();`;

const HTML_FIXED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Notes</title><link rel="stylesheet" href="/styles.css"></head>
<body><main><h1>Notes</h1><div class="banner">Welcome to the notes app — keep your thoughts in one place</div>
<p class="hint">Write a short title and press add.</p>
<form id="f" novalidate><label for="t">Title</label><input id="t" name="title" aria-describedby="t-err"><p id="t-err" role="alert" class="error"></p><button type="submit">Add note</button></form>
<button type="button" class="export" id="export">Export</button>
<ul id="list"></ul><a href="/">Home</a></main><script src="/app.js"></script></body></html>`;
const CSS_FIXED = `body { margin: 0; font-family: system-ui; } main { padding: 16px; }
.banner { max-width: 100%; background: #eef; padding: 8px; box-sizing: border-box; }
.hint { color: #555; }
@media (prefers-reduced-motion: no-preference) { button { transition: background 0.3s; } }
`;
const JS_FIXED = `const err=document.getElementById("t-err");
async function load(){const r=await fetch("/api/notes");const rows=await r.json();const l=document.getElementById("list");l.innerHTML=rows.length?rows.map(n=>"<li>"+n.title.replace(/</g,"&lt;")+"</li>").join(""):"<li>No notes yet — add your first one above.</li>";}
document.getElementById("f").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("t");err.textContent="";
 if(!t.value.trim()){err.textContent="Enter a title for the note.";t.setAttribute("aria-invalid","true");return;}
 t.removeAttribute("aria-invalid");
 const r=await fetch("/api/notes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:t.value})}).catch(()=>null);
 if(!r||!r.ok){err.textContent="Could not save the note. Please try again.";return;}
 t.value="";await load();});
document.getElementById("export").addEventListener("click",async()=>{const r=await fetch("/api/notes");const rows=await r.json();const a=document.createElement("a");a.download="notes.json";a.href="data:application/json,"+encodeURIComponent(JSON.stringify(rows));a.textContent="Download";document.body.appendChild(a);});
load();`;

export function appFiles(fixed: boolean): Record<string, string> {
  return {
    ...stackFor("node-web").files,
    "src/app.js": APP,
    "src/routes/notes.js": ROUTE,
    "public/index.html": fixed ? HTML_FIXED : HTML_BUGGY,
    "public/styles.css": fixed ? CSS_FIXED : CSS_BUGGY,
    "public/app.js": fixed ? JS_FIXED : JS_BUGGY,
  };
}

export const BRIEF = {
  title: "Notes",
  functional: [{ id: "FR-1", text: "Users can add a note and see it in the list" }, { id: "FR-2", text: "Empty notes are rejected with an error" }],
  acceptance: [{ id: "AC-1", text: "A saved note is still listed after reloading" }],
  journeys: [{ name: "Add a note", steps: ["Type a title", "Press add", "See the note in the list"] }],
};
