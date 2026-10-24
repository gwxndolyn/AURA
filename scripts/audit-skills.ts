/**
 * CLI for the Claude Code skill/prompt audit (read-only; proposes, never rewrites).
 * Usage: npx tsx scripts/audit-skills.ts [--json]
 * Exit 1 when any skill requires manual review (errors), else 0.
 */
import { auditSkills } from "../src/lib/intelligence/skillAudit";

const report = auditSkills(process.cwd());
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...report, root: "." }, null, 2));
} else {
  console.log(`\nSkill audit — ${report.skillsValidated} skills: ${report.summary.valid} valid, ${report.summary.warnings} with warnings, ${report.summary.manualReview} need manual review\n`);
  for (const s of report.skills) {
    if (!s.findings.length) continue;
    console.log(`${s.status === "manual-review" ? "✗" : "⚠"} ${s.skill}`);
    for (const f of s.findings) console.log(`    [${f.severity}] ${f.code}: ${f.message}${f.proposal ? `  → proposal: ${f.proposal}` : ""}`);
  }
  if (report.docInconsistencies.length) {
    console.log("\nDocumentation inconsistencies:");
    for (const f of report.docInconsistencies) console.log(`    [${f.severity}] ${f.message}`);
  }
  if (report.staleReferences.length) {
    console.log("\nPotentially stale references:");
    for (const r of report.staleReferences) console.log(`    ${r.file}: ${r.ref}`);
  }
  if (report.missingTestInstructions.length) console.log(`\nMissing test/verification instructions: ${report.missingTestInstructions.join(", ")}`);
  console.log(`\nPrompt library: ${report.promptLibrary.prompts} prompts, ${report.promptLibrary.missingSections.length} missing standard sections`);
  for (const p of report.promptLibrary.missingSections) console.log(`    ${p.file}: missing ${p.missing.join(", ")}`);
  console.log("");
}
process.exit(report.summary.manualReview > 0 ? 1 : 0);
