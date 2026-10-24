/**
 * Engineering lab CLI — drives AURA's improvement loop outside any chat
 * session or web request. Every step persists to the database; re-running a
 * command after a crash is safe.
 *
 *   npm run lab -- status                         verify + print loop state
 *   npm run lab -- run [config] [split]           run the suite (default config, all)
 *   npm run lab -- backlog                        evidence-ranked weaknesses from the latest run
 *   npm run lab -- propose <file.json>            create an experiment from a JSON spec
 *   npm run lab -- experiment <id>                run baseline vs candidate and decide
 *   npm run lab -- show <experimentId|runId>      print a decision or run summary
 *
 * Workspace: AURA_LAB_COMPANY_ID (a dedicated, OWNER-controlled workspace;
 * the lab never touches customer workspaces). Executor: Docker if
 * available; otherwise host execution of the bundled fixtures only when
 * AURA_LAB_HOST_EXECUTION=1.
 */
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/db";
import { runSuite, proposeBacklog, proposeExperiment, runExperiment, verifyState, labOverview } from "@/lib/lab/lab";

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const companyId = process.env.AURA_LAB_COMPANY_ID;
  if (!companyId) throw new Error("Set AURA_LAB_COMPANY_ID to the lab workspace id");
  if (!(await prisma.company.findUnique({ where: { id: companyId } }))) throw new Error(`Workspace ${companyId} not found`);
  const actor = process.env.AURA_LAB_ACTOR || "lab-cli";
  const v = await verifyState(companyId);
  if (v.fixes.length) console.log("state verified; fixed:", v.fixes.join("; "));
  if (cmd === "status") {
    const o = await labOverview(companyId);
    console.log(JSON.stringify({ state: o.state, executor: o.executor, suite: o.suiteVersion, lastRuns: o.runs.slice(0, 5).map((r) => `${r.id} ${r.configKey} ${r.split} ${r.status} ${r.passed}/${r.total}`), experiments: o.experiments.slice(0, 10).map((e) => `${e.id} ${e.key} ${e.status}`) }, null, 2));
  } else if (cmd === "run") {
    const r = await runSuite({ companyId, configKey: a || "default", split: (b as "train" | "heldout" | "all") || "all", actor });
    console.log(`run ${r.run.id}: ${r.run.passed}/${r.run.total} passed, ${r.run.errored} errored, executor ${r.run.executor}, ${r.run.durationMs} ms`);
    for (const o of r.outcomes.filter((x) => x.status !== "PASSED")) console.log(`  ${o.status} ${o.benchmarkId} (${o.split}): ${o.error || o.criteria.filter((c) => !c.passed).map((c) => c.evidence).join(" | ")}`);
    console.log(JSON.stringify({ heldout: r.card.heldout.dimensions, train: r.card.train.dimensions, criticalFailures: r.card.all.criticalFailures }, null, 1));
  } else if (cmd === "backlog") {
    console.log(JSON.stringify(await proposeBacklog(companyId), null, 2));
  } else if (cmd === "propose") {
    const spec = JSON.parse(readFileSync(a, "utf8"));
    const e = await proposeExperiment({ ...spec, companyId, actor });
    console.log(`proposed ${e.id} (${e.key})`);
  } else if (cmd === "experiment") {
    const r = await runExperiment(companyId, a, actor);
    console.log(`${r.experiment.key}: ${r.decision.outcome}`);
    for (const x of r.decision.reasons) console.log(`  - ${x}`);
    for (const c of r.changedCases) console.log(`  case ${c.id} (${c.split}): ${c.baseline} → ${c.candidate}`);
  } else if (cmd === "show") {
    const e = await prisma.labExperiment.findFirst({ where: { id: a, companyId } });
    if (e) console.log(JSON.stringify({ ...e, decision: JSON.parse(e.decision) }, null, 2));
    else {
      const r = await prisma.labRun.findFirst({ where: { id: a, companyId }, include: { cases: true } });
      console.log(JSON.stringify(r, null, 2));
    }
  } else {
    console.log("usage: status | run [config] [split] | backlog | propose <file> | experiment <id> | show <id>");
  }
  void b;
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
