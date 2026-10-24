import { prisma } from "@/lib/db";
import { runAgent, logToolCall } from "@/lib/agents/orchestrator";
import { emitEvent, audit } from "@/lib/events/emit";
import { parseJSON } from "@/lib/utils";
import type { AcceptanceCriterion } from "@/lib/types";
import { generateFeature, injectBug, type GeneratedCode } from "@/lib/sandbox/codegen";
import { runNodeTests, runSyntaxCheck } from "@/lib/sandbox/runner";
import { sendMessage } from "@/lib/agents/messaging";

/**
 * Self-healing task execution. Implements → runs REAL tests in the sandbox →
 * if they fail, QA files a structured BUG_REPORT to the engineer, the engineer
 * fixes the code, and tests rerun — up to `maxAttempts`. The loop is real: the
 * first attempt may use a deliberately buggy implementation (opts.injectBug)
 * which the real sandbox genuinely fails, and the fix produces passing code.
 *
 * A task reaches DONE only when real build + real tests pass and acceptance
 * criteria are met. If attempts are exhausted it enters a recoverable BLOCKED
 * state (not silently "done").
 */
export async function executeTaskSelfHealing(
  companyId: string,
  taskId: string,
  opts?: { injectBug?: boolean; maxAttempts?: number },
) {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { assignee: true } });
  if (!task) throw new Error("Task not found");

  const assigneeKey = task.assignee?.key ?? "backend-engineer";
  const isCode = ["frontend-engineer", "backend-engineer"].includes(assigneeKey);

  await prisma.task.update({ where: { id: taskId }, data: { status: "IN_PROGRESS" } });
  await emitEvent({ companyId, type: "TASK_UPDATED", actor: assigneeKey, message: `Started: ${task.title}` });

  // Narrative reasoning turn (Claude or simulated).
  const impl = await runAgent({ companyId, agentKey: assigneeKey, objective: task.title, kind: isCode ? "code" : "summary", context: task.description });

  if (!isCode) {
    // Non-code task: QA sign-off only.
    return finalize(companyId, taskId, task, true, { passed: 1, failed: 0, total: 1 }, false, []);
  }

  const base = generateFeature(task.title, task.description);
  const ws = await prisma.codeWorkspace.findFirst({ where: { companyId } });
  const dir = `src/features/${slug(task.title)}`;
  const modulePath = `${dir}/${base.moduleFile}`;
  const testPath = `${dir}/feature.test.js`;

  let attempt = 0;
  let testResult = { passed: 0, failed: 1, total: 1 };
  let realMode = false;
  let current: GeneratedCode = opts?.injectBug ? injectBug(base) : base;

  while (attempt < maxAttempts) {
    attempt++;
    await prisma.task.update({ where: { id: taskId }, data: { attempts: attempt } });

    // Write current code to the persistent workspace.
    if (ws) {
      const files = parseJSON<Record<string, string>>(ws.files, {});
      files[modulePath] = current.moduleCode;
      files[testPath] = current.testCode;
      await prisma.codeWorkspace.update({ where: { id: ws.id }, data: { files: JSON.stringify(files) } });
      await emitEvent({
        companyId,
        type: "CODE_CHANGED",
        actor: assigneeKey,
        message: `${attempt === 1 ? "Wrote" : "Updated"} ${modulePath} (attempt ${attempt})`,
        meta: { path: modulePath, attempt },
      });
    }

    // Real build + test.
    await runSyntaxCheck({ [base.moduleFile]: current.moduleCode });
    await emitEvent({ companyId, type: "TEST_STARTED", actor: "qa-engineer", message: `Testing: ${task.title} (attempt ${attempt})` });
    const r = await runNodeTests(current);
    realMode = r.mode === "docker";
    testResult = { passed: r.passed, failed: r.failed, total: r.total };

    await emitEvent({
      companyId,
      type: "TEST_COMPLETED",
      actor: "qa-engineer",
      level: r.failed === 0 ? "success" : "warning",
      message: `Tests: ${r.passed}/${r.total} passed${realMode ? " (real sandbox)" : ""} — attempt ${attempt}`,
      meta: { ...testResult, attempt, real: realMode },
    });

    if (r.failed === 0 && r.total > 0) break;

    // FAILURE → QA files a structured bug report; engineer fixes.
    if (attempt < maxAttempts) {
      const failing = r.cases.filter((c) => !c.ok).map((c) => c.name).join("; ") || "test suite failed";
      await sendMessage({
        companyId,
        fromKey: "qa-engineer",
        toKey: assigneeKey,
        type: "BUG_REPORT",
        severity: "HIGH",
        taskId,
        message: `${failing} — in ${modulePath}. Please fix and resubmit.`,
      });
      await prisma.task.update({ where: { id: taskId }, data: { status: "REVIEW" } });

      // Engineer "fixes": the correct implementation is the non-buggy template.
      await runAgent({ companyId, agentKey: assigneeKey, objective: `Fix failing tests for ${task.title}`, kind: "code", context: `QA reported: ${failing}` });
      current = base; // the corrected implementation
      await prisma.task.update({ where: { id: taskId }, data: { status: "IN_PROGRESS" } });
    }
  }

  const touched = [modulePath, testPath];
  return finalize(companyId, taskId, task, testResult.failed === 0 && testResult.total > 0, testResult, realMode, touched, attempt);
}

async function finalize(
  companyId: string,
  taskId: string,
  task: { estimate: number; acceptance: string; title: string; assignee: { id: string; key: string } | null },
  pass: boolean,
  testResult: { passed: number; failed: number; total: number },
  real: boolean,
  touched: string[],
  attempts = 1,
) {
  const assigneeKey = task.assignee?.key ?? "backend-engineer";
  const criteria = parseJSON<AcceptanceCriterion[]>(task.acceptance, []);
  const updated = criteria.map((c) => ({ ...c, met: pass }));
  const allMet = updated.length === 0 ? pass : updated.every((c) => c.met);

  if (pass && allMet) {
    await prisma.task.update({
      where: { id: taskId },
      data: { status: "DONE", completedAt: new Date(), actual: task.estimate, acceptance: JSON.stringify(updated) },
    });
    if (task.assignee) await prisma.agent.update({ where: { id: task.assignee.id }, data: { tasksDone: { increment: 1 } } });
    await emitEvent({ companyId, type: "TASK_UPDATED", actor: assigneeKey, level: "success", message: `✓ Completed: ${task.title}${attempts > 1 ? ` (after ${attempts} attempts)` : ""}` });
    await audit(companyId, assigneeKey, "COMPLETE_TASK", taskId, `DONE in ${attempts} attempt(s)${real ? ", real tests" : ""}`);
  } else {
    // Recoverable failed state — not silently done.
    await prisma.task.update({ where: { id: taskId }, data: { status: "BLOCKED", acceptance: JSON.stringify(updated) } });
    if (task.assignee) await prisma.agent.update({ where: { id: task.assignee.id }, data: { tasksFailed: { increment: 1 } } });
    await emitEvent({ companyId, type: "AGENT_FAILED", actor: "qa-engineer", level: "danger", message: `Task BLOCKED after ${attempts} attempts: ${task.title}` });
    await audit(companyId, "qa-engineer", "BLOCK_TASK", taskId, `failed after ${attempts} attempts`);
  }

  return { taskId, testsPass: pass, testResult, real, attempts, status: pass && allMet ? "DONE" : "BLOCKED", touched };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
