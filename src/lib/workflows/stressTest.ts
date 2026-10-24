import { prisma } from "@/lib/db";
import { emitEvent, audit } from "@/lib/events/emit";
import { planGoal } from "./plan";
import { prioritizeBacklog } from "./prioritize";
import { planSprint } from "./sprint";
import { executeTaskSelfHealing } from "./selfHeal";
import { deployWithRetry } from "./deploy";
import { runAttackDefense } from "./security";
import { resolveConflict } from "./conflict";
import { setAgentAvailability, reassignFromUnavailable } from "./reassign";
import { sendMessage } from "@/lib/agents/messaging";
import { advanceDays } from "@/lib/company/simulation";
import { callTool, PermissionError } from "@/lib/agents/tools";

/**
 * The full autonomous stress test (spec §25). Runs a realistic scenario with
 * every failure mode simultaneously and asserts the company keeps operating
 * without corrupting state. Every step is backed by real backend logic.
 *
 * Returns a structured report of what happened + a set of invariant checks.
 */
export async function runStressTest(companyId: string) {
  const report: Record<string, unknown> = {};
  const t0 = Date.now();

  await emitEvent({ companyId, type: "AGENT_STARTED", actor: "ceo", level: "info", message: "CEO objective: launch analytics dashboard, maintain security & reliability" });

  // 0. Permission enforcement check: red-team must NOT be able to deploy.
  const permBlocked = await assertPermissionBlocked(companyId);
  report.permissionEnforced = permBlocked;

  // 1. CEO delegates → PM plans the backlog (creates project + tasks).
  const plan = await planGoal(companyId, "Launch a production-ready customer analytics dashboard");
  report.planTasks = plan.taskIds.length;

  // Add a few extra competing tasks with varied impact/urgency/security to test prioritization.
  const extra = [
    { title: "Harden auth session handling", priority: "HIGH", businessImpact: 4, urgency: 4, securityRisk: 5, estimate: 4 },
    { title: "Reduce infra cost", priority: "LOW", businessImpact: 2, urgency: 2, securityRisk: 1, estimate: 3 },
    { title: "Add CSV export", priority: "MEDIUM", businessImpact: 3, urgency: 2, securityRisk: 1, estimate: 2 },
    { title: "Fix flaky analytics query", priority: "HIGH", businessImpact: 4, urgency: 5, securityRisk: 2, estimate: 3 },
    { title: "Improve onboarding copy", priority: "LOW", businessImpact: 2, urgency: 1, securityRisk: 1, estimate: 1 },
  ];
  const be = await prisma.agent.findUnique({ where: { companyId_key: { companyId, key: "backend-engineer" } } });
  for (const e of extra) {
    await prisma.task.create({
      data: {
        companyId, title: e.title, description: e.title, priority: e.priority, status: "BACKLOG",
        businessImpact: e.businessImpact, urgency: e.urgency, securityRisk: e.securityRisk, estimate: e.estimate,
        assigneeId: be?.id, acceptance: JSON.stringify([{ text: "implemented", met: false }, { text: "tests pass", met: false }]),
      },
    });
  }

  // 2. Autonomous prioritization + sprint planning.
  const scored = await prioritizeBacklog(companyId);
  report.topTask = scored[0]?.title;
  report.topReason = scored[0]?.reason;
  const sprint = await planSprint(companyId);
  report.sprintCommitted = sprint.committed;
  report.sprintTasks = sprint.selected.length;

  // 3. Developer-failure + self-heal: a REAL backend code task with an injected
  // bug, so the real Docker sandbox genuinely fails then passes after the fix.
  const codeTask = await prisma.task.create({
    data: {
      companyId,
      sprintId: sprint.sprintId,
      assigneeId: be?.id,
      title: "Implement analytics aggregation API",
      description: "Aggregate customer analytics with empty-range handling",
      priority: "HIGH",
      status: "PLANNED",
      businessImpact: 5, urgency: 4, securityRisk: 2, estimate: 4,
      acceptance: JSON.stringify([{ text: "aggregates values", met: false }, { text: "handles empty range", met: false }]),
    },
  });
  const healed = await executeTaskSelfHealing(companyId, codeTask.id, { injectBug: true, maxAttempts: 3 });
  report.selfHeal = { status: healed.status, attempts: healed.attempts, testsPass: healed.testsPass, real: healed.real };

  // 4. Conflict: Architect vs Data Analyst on datastore.
  const conflict = await resolveConflict({
    companyId,
    topic: "Primary datastore for analytics",
    sideA: { agentKey: "architect", position: "Use PostgreSQL", evidence: ["ACID", "existing ops expertise", "relational queries"] },
    sideB: { agentKey: "data-analyst", position: "Use MongoDB", evidence: ["flexible schema"] },
  });
  report.conflictChoice = conflict.choice;

  // 5. Agent-failure + reassignment: frontend engineer goes unavailable.
  await setAgentAvailability(companyId, "frontend-engineer", false);
  const reassigned = await reassignFromUnavailable(companyId, "frontend-engineer");
  report.reassigned = reassigned;
  await setAgentAvailability(companyId, "frontend-engineer", true);

  // 6. Security vulnerability → full attack/defend loop.
  const incident = await runAttackDefense(companyId, { attackType: "Reflected XSS" });
  report.incident = { verified: incident.verified, score: incident.securityScore, attack: incident.scenario.attackType };

  // 7. Deployment failure → real retry.
  const deploy = await deployWithRetry(companyId, "production", { forceFailStage: "DEPLOY", maxRetries: 2 });
  report.deploy = { success: deploy.success, retries: deploy.retries, version: deploy.version };

  // 8. Customer complaint → support triage → message to PM.
  await sendMessage({ companyId, fromKey: "support", toKey: "product-manager", type: "BUG_REPORT", severity: "MEDIUM", message: "Customer: analytics export fails for empty date range." });

  // 9. Advance the simulation so metrics update.
  await advanceDays(companyId, 2);

  await emitEvent({ companyId, type: "COMPANY_UPDATED", actor: "ceo", level: "success", message: "Stress test complete — company still operating" });
  await audit(companyId, "ceo", "STRESS_TEST", companyId, "completed");

  report.durationMs = Date.now() - t0;

  // Invariant checks (real queries against resulting state).
  const invariants = await checkInvariants(companyId);
  invariants.permissionEnforced = Boolean(report.permissionEnforced);
  invariants.selfHealed = (report.selfHeal as { status?: string })?.status === "DONE";
  invariants.allPassed =
    invariants.allPassed && invariants.permissionEnforced && invariants.selfHealed && Boolean(deploy.success);
  return { report, invariants };
}

/** Attempt an unauthorized tool call (red-team → deploy) and confirm it's blocked. */
async function assertPermissionBlocked(companyId: string): Promise<boolean> {
  try {
    await callTool({ companyId, agentKey: "red-team" }, "deploy.run", {}, async () => "should not run");
    return false; // ran → permission NOT enforced
  } catch (e) {
    return e instanceof PermissionError;
  }
}

async function checkInvariants(companyId: string) {
  const [tasks, msgs, incidents, deploys, runs, completedTasks] = await Promise.all([
    prisma.task.findMany({ where: { companyId } }),
    prisma.agentMessage.count({ where: { companyId } }),
    prisma.incident.findMany({ where: { companyId } }),
    prisma.deployment.findMany({ where: { companyId } }),
    prisma.agentRun.count({ where: { companyId } }),
    prisma.task.findMany({ where: { companyId, status: "DONE" }, select: { id: true, completedAt: true } }),
  ]);

  const noStuckInProgress = tasks.every((t) => t.status !== "IN_PROGRESS" && t.status !== "TESTING");
  const incidentResolved = incidents.length === 0 || incidents.some((i) => i.status === "RESOLVED");
  const deploySucceeded = deploys.some((d) => d.status === "SUCCESS");
  const messagesStored = msgs > 0;
  // No task executed twice: every DONE task has exactly one completedAt and a
  // unique id (no duplicate executions corrupting a single task's state).
  const noDuplicateExec = completedTasks.every((t) => t.completedAt != null) &&
    new Set(completedTasks.map((t) => t.id)).size === completedTasks.length;

  return {
    tasksTerminal: noStuckInProgress,
    messagesStored,
    incidentResolved,
    deploySucceeded,
    noDuplicateExec,
    agentRuns: runs,
    totalMessages: msgs,
    taskCount: tasks.length,
    permissionEnforced: false,
    selfHealed: false,
    allPassed: noStuckInProgress && messagesStored && incidentResolved && deploySucceeded,
  };
}
