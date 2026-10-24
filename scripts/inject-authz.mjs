/**
 * One-off codemod: insert a workspace-authorization guard into every
 * /api/companies/[id]/** route. Idempotent — skips files already guarded.
 *
 * Strategy: after each `const { id ... } = await ctx.params;` line, insert
 *   await requireWorkspaceAccess(id, "<ROLE>");
 * where ROLE is VIEWER inside a GET export and MEMBER otherwise. We detect which
 * exported method a destructuring belongs to by scanning backwards for the
 * nearest `export const <METHOD> =`.
 */
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const files = execSync('find "src/app/api/companies/[id]" -name route.ts', { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

let changed = 0;
for (const file of files) {
  let src = readFileSync(file, "utf8");
  if (src.includes("requireWorkspaceAccess(")) continue; // already guarded

  const lines = src.split("\n");
  const out = [];
  // Track the nearest preceding exported method.
  let currentMethod = "GET";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/export const (GET|POST|PUT|PATCH|DELETE)\s*=/);
    if (m) currentMethod = m[1];
    out.push(line);

    const destructure = line.match(/const \{\s*id\b[^}]*\}\s*=\s*await ctx\.params;/);
    if (destructure) {
      const role = currentMethod === "GET" ? "VIEWER" : "MEMBER";
      const indent = line.match(/^\s*/)[0];
      out.push(`${indent}await requireWorkspaceAccess(id, "${role}");`);
    }
  }
  let next = out.join("\n");

  // Ensure the import is present.
  if (!next.includes('from "@/lib/auth/authz"')) {
    next = next.replace(
      /(import .*? from "@\/lib\/api";\n)/,
      `$1import { requireWorkspaceAccess } from "@/lib/auth/authz";\n`,
    );
    // Fallback: if no api import line matched, add after first import.
    if (!next.includes('from "@/lib/auth/authz"')) {
      next = next.replace(/(^import .*?\n)/, `$1import { requireWorkspaceAccess } from "@/lib/auth/authz";\n`);
    }
  }

  if (next !== src) {
    writeFileSync(file, next);
    changed++;
    console.log("guarded:", file);
  }
}
console.log(`\n${changed} route file(s) updated.`);
