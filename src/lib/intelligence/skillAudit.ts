/**
 * Claude Code skill & prompt-library quality audit (Phase 9).
 *
 * Read-only: produces a report + PROPOSED changes. It never rewrites a skill —
 * proposals are surfaced for human review (and can be captured as PROPOSED
 * knowledge entries). Complements scripts/check-docs.mjs (which gates structure
 * in CI) with content-level checks:
 *
 *  - directory structure + supported frontmatter (name/description; unknown keys warned)
 *  - required instruction sections (workflow, validation, definition of done, report)
 *  - broken relative links + references to nonexistent repo paths
 *  - `npm run <x>` commands that don't exist in package.json
 *  - missing verification requirements (no command to run)
 *  - missing security requirements in security-sensitive skills
 *  - duplicate descriptions / contradictory guidance (e.g. db:reset recommended)
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

/** Frontmatter keys supported by Claude Code skills (current docs). */
export const SUPPORTED_SKILL_KEYS = new Set([
  "name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation",
  "user-invocable", "allowed-tools", "disallowed-tools", "model", "effort", "context", "agent",
  "paths", "shell", "hooks", "license", "compatibility", "metadata",
]);

const SECURITY_SENSITIVE = /security|api|database|ai-agent|ai-integration|autonomous|incident|release|prompt/;

export interface SkillFinding {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  proposal?: string;
}

export interface SkillReport {
  skill: string;
  path: string;
  status: "valid" | "warnings" | "manual-review";
  findings: SkillFinding[];
}

export interface AuditReport {
  generatedAt: string;
  root: string;
  skillsValidated: number;
  skills: SkillReport[];
  summary: { valid: number; warnings: number; manualReview: number };
  docInconsistencies: SkillFinding[];
  missingTestInstructions: string[];
  staleReferences: { file: string; ref: string }[];
  promptLibrary: { prompts: number; missingSections: { file: string; missing: string[] }[] };
}

function parseFrontmatter(body: string): { fm: Record<string, string> | null; rest: string } {
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: null, rest: body };
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_-][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, rest: body.slice(m[0].length) };
}

/** Repo-relative paths referenced in backticks (src/…, prisma/…, docs/…, scripts/…, e2e/…). */
function referencedPaths(text: string): string[] {
  const out = new Set<string>();
  const re = /`((?:src|prisma|docs|scripts|e2e|\.claude)\/[A-Za-z0-9_./\-\[\]]+?)`/g;
  let m;
  while ((m = re.exec(text))) {
    let p = m[1].replace(/[.,;:]+$/, "");
    if (/[*{}<>]/.test(p)) continue; // globs / placeholders
    out.add(p);
  }
  return [...out];
}

function pathExists(root: string, p: string): boolean {
  if (existsSync(join(root, p))) return true;
  // Allow references to a directory written without trailing slash or a file without extension.
  return ["", ".ts", ".tsx", ".md", ".mjs"].some((ext) => existsSync(join(root, p + ext)));
}

function linkTargets(text: string, fileDir: string): { raw: string; resolved: string }[] {
  const out: { raw: string; resolved: string }[] = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = raw.split("#")[0];
    if (target) out.push({ raw, resolved: resolve(fileDir, target) });
  }
  return out;
}

export function auditSkills(root: string): AuditReport {
  const skillsDir = join(root, ".claude", "skills");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  const reports: SkillReport[] = [];
  const descriptions = new Map<string, string>();
  const stale: { file: string; ref: string }[] = [];
  const missingTests: string[] = [];

  const names = existsSync(skillsDir) ? readdirSync(skillsDir).filter((n) => statSync(join(skillsDir, n)).isDirectory()) : [];
  for (const name of names) {
    const rel = `.claude/skills/${name}/SKILL.md`;
    const file = join(root, rel);
    const findings: SkillFinding[] = [];
    if (!existsSync(file)) {
      reports.push({ skill: name, path: rel, status: "manual-review", findings: [{ severity: "error", code: "missing-skill-md", message: "Directory has no SKILL.md" }] });
      continue;
    }
    const body = readFileSync(file, "utf8");
    const { fm, rest } = parseFrontmatter(body);

    // Structure + frontmatter
    if (!fm) findings.push({ severity: "error", code: "no-frontmatter", message: "Missing YAML frontmatter" });
    else {
      if (!fm.name) findings.push({ severity: "error", code: "no-name", message: "Frontmatter missing `name`" });
      else if (fm.name !== name) findings.push({ severity: "error", code: "name-mismatch", message: `name "${fm.name}" ≠ directory "${name}"`, proposal: `Set name: ${name}` });
      if (!fm.description) findings.push({ severity: "error", code: "no-description", message: "Frontmatter missing `description` (needed for auto-invocation)" });
      else {
        if (fm.description.length > 1536) findings.push({ severity: "warning", code: "long-description", message: `description is ${fm.description.length} chars (truncated at 1536)` });
        if (!/use (when|for|to|before)/i.test(fm.description)) findings.push({ severity: "info", code: "no-trigger", message: "description doesn't say when to use the skill", proposal: "Append a 'Use when …' clause" });
        const dup = descriptions.get(fm.description);
        if (dup) findings.push({ severity: "warning", code: "duplicate-description", message: `Same description as ${dup}` });
        descriptions.set(fm.description, name);
      }
      for (const k of Object.keys(fm)) if (!SUPPORTED_SKILL_KEYS.has(k)) findings.push({ severity: "warning", code: "unsupported-key", message: `Unsupported frontmatter key \`${k}\`` });
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) findings.push({ severity: "error", code: "bad-dirname", message: "Directory must be lowercase kebab-case" });

    // Required instruction sections
    const lower = rest.toLowerCase();
    const sections: [string, RegExp][] = [
      ["when to use", /when to use/],
      ["workflow/steps", /workflow|review order|checklist|steps|requirements/],
      ["validation", /validation|verify|run /],
      ["definition of done", /definition of done/],
      ["final report", /final report|output/],
    ];
    for (const [label, re] of sections) if (!re.test(lower)) findings.push({ severity: "warning", code: "missing-section", message: `Missing "${label}" section`, proposal: `Add a "## ${label[0].toUpperCase() + label.slice(1)}" section` });

    // Verification requirements: must name at least one runnable command.
    const cmds = [...rest.matchAll(/`npm run ([a-z0-9:_-]+)[^`]*`/g)].map((m) => m[1]);
    const runsSomething = cmds.length > 0 || /`npm test`|`node scripts\/check-docs\.mjs`|`npx /.test(rest);
    if (!runsSomething) {
      findings.push({ severity: "warning", code: "no-verification-command", message: "No concrete verification command (npm run …/npm test)", proposal: "Add the exact command(s) to run in a Validation section" });
      missingTests.push(name);
    }
    for (const c of new Set(cmds)) if (!scripts.has(c)) findings.push({ severity: "error", code: "invalid-command", message: `\`npm run ${c}\` is not a package.json script` });

    // Security requirements for sensitive workflows
    if (SECURITY_SENSITIVE.test(name) && !/## security|security|hard rule|must not/i.test(rest))
      findings.push({ severity: "warning", code: "missing-security", message: "Security-sensitive skill has no security requirements", proposal: "Add a ## Security section (tenant scope, permissions, approval)" });

    // Contradictory guidance
    if (/run `?npm run db:reset`?(?! .*never)/i.test(rest) && !/never.*db:reset|db:reset.*(destroys|never)/i.test(rest))
      findings.push({ severity: "error", code: "contradiction", message: "Recommends db:reset, which CLAUDE.md forbids as a fix" });
    if (/rm -rf \.next/.test(rest) && !/never|do not|don't/i.test(rest))
      findings.push({ severity: "error", code: "contradiction", message: "Suggests rm -rf .next, which CLAUDE.md forbids on this repo" });

    // References to nonexistent paths + broken links
    for (const p of referencedPaths(rest)) if (!pathExists(root, p)) {
      findings.push({ severity: "warning", code: "stale-path", message: `References nonexistent path \`${p}\`` });
      stale.push({ file: rel, ref: p });
    }
    for (const l of linkTargets(rest, dirname(file))) if (!existsSync(l.resolved)) findings.push({ severity: "error", code: "broken-link", message: `Broken link ${l.raw}` });

    const hasError = findings.some((f) => f.severity === "error");
    const hasWarn = findings.some((f) => f.severity === "warning");
    reports.push({ skill: name, path: rel, status: hasError ? "manual-review" : hasWarn ? "warnings" : "valid", findings });
  }

  // Prompt library: every prompt must carry the standard sections.
  const promptsDir = join(root, "docs", "prompts");
  const promptFiles = existsSync(promptsDir) ? readdirSync(promptsDir).filter((f) => f.endsWith(".md") && f !== "README.md") : [];
  const missingSections: { file: string; missing: string[] }[] = [];
  for (const f of promptFiles) {
    const t = readFileSync(join(promptsDir, f), "utf8").toLowerCase();
    const req: [string, RegExp][] = [
      ["when to use", /when to use/],
      ["what to provide", /what to provide/],
      ["the prompt", /## the prompt/],
      ["expected deliverables", /expected deliverables/],
      ["verification", /## verification/],
      ["common failure modes", /common failure modes/],
    ];
    const missing = req.filter(([, re]) => !re.test(t)).map(([l]) => l);
    if (missing.length) missingSections.push({ file: `docs/prompts/${f}`, missing });
    for (const p of referencedPaths(readFileSync(join(promptsDir, f), "utf8"))) if (!pathExists(root, p)) stale.push({ file: `docs/prompts/${f}`, ref: p });
  }

  // Doc inconsistencies: skill catalog in docs/README.md vs actual skills.
  const docInconsistencies: SkillFinding[] = [];
  const indexPath = join(root, "docs", "README.md");
  if (existsSync(indexPath)) {
    const idx = readFileSync(indexPath, "utf8");
    const listed = new Set([...idx.matchAll(/\|\s*`(aura-[a-z0-9-]+)`\s*\|/g)].map((m) => m[1]));
    for (const n of names) if (!listed.has(n)) docInconsistencies.push({ severity: "warning", code: "uncatalogued-skill", message: `Skill ${n} is not listed in docs/README.md skill catalog` });
    for (const l of listed) if (!names.includes(l)) docInconsistencies.push({ severity: "error", code: "phantom-skill", message: `docs/README.md lists ${l}, which does not exist` });
  }

  return {
    generatedAt: new Date().toISOString(),
    root,
    skillsValidated: reports.length,
    skills: reports,
    summary: {
      valid: reports.filter((r) => r.status === "valid").length,
      warnings: reports.filter((r) => r.status === "warnings").length,
      manualReview: reports.filter((r) => r.status === "manual-review").length,
    },
    docInconsistencies,
    missingTestInstructions: missingTests,
    staleReferences: stale,
    promptLibrary: { prompts: promptFiles.length, missingSections },
  };
}
