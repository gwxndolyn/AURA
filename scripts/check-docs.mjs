#!/usr/bin/env node
// AURA documentation quality gate.
//
// Validates (non-brittle — structural, not prose):
//   1. Required docs exist.
//   2. Internal relative Markdown links resolve.
//   3. Every .claude/skills/<name>/SKILL.md has valid frontmatter (name + description)
//      and the name matches its directory.
//   4. Every variable in .env.example is documented in operations/environment-variables.md.
//   5. npm scripts referenced in operations/commands.md exist in package.json
//      (only lines explicitly marked as real commands).
//
// Usage:  node scripts/check-docs.mjs
// Exit 0 = pass, 1 = problems found. Prints a report either way.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warnings = [];
const fail = (m) => problems.push(m);
const warn = (m) => warnings.push(m);
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const has = (p) => existsSync(join(ROOT, p));

// ---------------------------------------------------------------------------
// 1. Required docs exist.
// ---------------------------------------------------------------------------
const REQUIRED = [
  "CLAUDE.md",
  "AGENTS.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  ".env.example",
  "docs/README.md",
  "docs/prompts/README.md",
  "docs/architecture/overview.md",
  "docs/architecture/repository-map.md",
  "docs/architecture/api-design.md",
  "docs/architecture/database.md",
  "docs/engineering/definition-of-done.md",
  "docs/ai-engineering/overview.md",
  "docs/security/threat-model.md",
  "docs/operations/commands.md",
  "docs/operations/environment-variables.md",
];
for (const f of REQUIRED) if (!has(f)) fail(`Missing required doc: ${f}`);

// ---------------------------------------------------------------------------
// Collect all markdown files under docs/ + root-level docs.
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  if (!existsSync(join(ROOT, dir))) return out;
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) out.push(...walk(rel));
    else if (e.endsWith(".md")) out.push(rel);
  }
  return out;
}
const mdFiles = [
  ...walk("docs"),
  "CLAUDE.md",
  "AGENTS.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
].filter(has);

// ---------------------------------------------------------------------------
// 2. Internal relative links resolve.
//    Matches [text](target). Skips http(s)://, mailto:, and pure #anchors.
// ---------------------------------------------------------------------------
const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
for (const f of mdFiles) {
  const body = read(f);
  const base = dirname(join(ROOT, f));
  let m;
  while ((m = LINK.exec(body))) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    target = target.split("#")[0]; // strip anchor
    if (!target) continue;
    const resolved = resolve(base, target);
    if (!existsSync(resolved)) {
      fail(`Broken link in ${f}: ${m[1]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Skills: valid frontmatter + name matches directory.
// ---------------------------------------------------------------------------
const skillsDir = ".claude/skills";
if (has(skillsDir)) {
  for (const name of readdirSync(join(ROOT, skillsDir))) {
    const skillPath = join(skillsDir, name, "SKILL.md");
    if (!has(skillPath)) {
      fail(`Skill ${name} has no SKILL.md`);
      continue;
    }
    const body = read(skillPath);
    const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      fail(`Skill ${name}: missing YAML frontmatter`);
      continue;
    }
    const fm = fmMatch[1];
    const nameLine = fm.match(/^name:\s*(.+)$/m);
    const descLine = fm.match(/^description:\s*(.+)$/m);
    if (!nameLine) fail(`Skill ${name}: frontmatter missing 'name'`);
    else if (nameLine[1].trim() !== name)
      fail(`Skill ${name}: frontmatter name '${nameLine[1].trim()}' != directory '${name}'`);
    if (!descLine) fail(`Skill ${name}: frontmatter missing 'description'`);
    else if (descLine[1].trim().length > 1024)
      warn(`Skill ${name}: description is long (${descLine[1].trim().length} chars)`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      fail(`Skill ${name}: directory name should be lowercase kebab-case`);
  }
}

// ---------------------------------------------------------------------------
// 4. Every .env.example var is documented in environment-variables.md.
// ---------------------------------------------------------------------------
if (has(".env.example") && has("docs/operations/environment-variables.md")) {
  const envVars = [];
  for (const line of read(".env.example").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=/);
    if (m) envVars.push(m[1]);
  }
  const envDoc = read("docs/operations/environment-variables.md");
  for (const v of envVars) {
    if (!envDoc.includes(v))
      fail(`Env var ${v} is in .env.example but not documented in environment-variables.md`);
  }
}

// ---------------------------------------------------------------------------
// 5. npm scripts referenced in commands.md exist (lines with `npm run <x>`).
// ---------------------------------------------------------------------------
if (has("package.json") && has("docs/operations/commands.md")) {
  const scripts = JSON.parse(read("package.json")).scripts ?? {};
  const cmdDoc = read("docs/operations/commands.md");
  const seen = new Set();
  const RUN = /`npm run ([a-z0-9:_-]+)`/g;
  let m;
  while ((m = RUN.exec(cmdDoc))) {
    const script = m[1];
    if (seen.has(script)) continue;
    seen.add(script);
    // Allow documented-as-unavailable section; those are not in backticks as `npm run`.
    if (!(script in scripts))
      warn(`commands.md references \`npm run ${script}\` which is not in package.json`);
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log(`\nAURA doc check — scanned ${mdFiles.length} markdown files.\n`);
if (warnings.length) {
  console.log(`Warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  console.log("");
}
if (problems.length) {
  console.log(`Problems (${problems.length}):`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log("\nFAIL\n");
  process.exit(1);
}
console.log("All documentation checks passed. ✓\n");
