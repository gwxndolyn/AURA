/**
 * Product scheduler: one bounded, idempotent tick per call.
 *
 *  - Executes nothing until the scope is approved, the product is ACTIVE and
 *    the autonomy level allows dispatch (SUGGEST never auto-dispatches).
 *  - Ready = dependencies VERIFIED (or accepted unverified, non-executable only).
 *  - Executable tasks dispatch a real engineering run (src/lib/builder) on
 *    the product's git repository, executed by the durable job worker:
 *    agents edit files with tools, the engine runs install/test/lint/build in
 *    the sandbox, QA/security/review judge the recorded output, bounded
 *    repairs follow. Two tasks that share a file never run at the same time.
 *  - Non-executable DESIGN / ARCHITECTURE tasks produce artifacts that a
 *    person reviews; other non-executable tasks are BLOCKED with the reason
 *    ("no executable codebase") rather than pretending to be done.
 *  - Mission outcomes are mapped to backlog status from persisted evidence
 *    only. A failed verification creates a REPAIR item linked to the finding;
 *    repeated failure beyond the product's limits BLOCKS the task for a person.
 *  - A product-level lease prevents overlapping ticks; an expired lease (crash
 *    / restart) is taken over, and in-flight missions are simply re-read —
 *    the mission engine's own leases recover abandoned task runs.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { parseJSON } from "@/lib/utils";
import { startBuild, cancelBuild, recoverOrphanedBuilds } from "@/lib/builder/service";
import { BUDGET_ALERT_RATIO } from "./policy";
import { readyKeys, derivePhase, rollUp, type ItemStatus } from "./lifecycle";
import { mayAutoDispatch, needsApproval, type Autonomy } from "./policy";
import { loadProduct, limitsOf, setItemStatus, appendItemHistory, movePhase, productEvent, requestApproval, type Evidence, type ProductRow } from "./store";
import { missingInputs } from "@/lib/builder/orchestrator";
import { syncFeatureContracts } from "./contract";
import { settleProposals } from "./maintenance";
import { produceDesign, produceArchitecture } from "./artifacts";

const LEASE_MS = 60_000;
const ENGINE = { kind: "engine" as const, id: "scheduler" };

export interface TickResult {
  productId: string;
  phase: string;
  dispatched: string[];
  advanced: string[];
  settled: { key: string; status: string }[];
  blocked: { key: string; reason: string }[];
  waitingOn: string[];
  note?: string;
}

async function takeLease(p: ProductRow): Promise<boolean> {
  const now = new Date();
  const r = await prisma.product.updateMany({ where: { id: p.id, OR: [{ tickLeaseUntil: null }, { tickLeaseUntil: { lt: now } }] }, data: { tickLeaseUntil: new Date(now.getTime() + LEASE_MS) } });
  return r.count === 1;
}
async function releaseLease(id: string) {
  await prisma.product.update({ where: { id }, data: { tickLeaseUntil: null } });
}

type Item = Awaited<ReturnType<typeof prisma.backlogItem.findMany>>[number];
const filesOf = (i: Item) => parseJSON<string[]>(i.files, []);
const depsOf = (i: Item) => parseJSON<string[]>(i.dependsOn, []);

/** Build → evidence-backed backlog outcome (persisted state only). */
async function evaluateBuild(companyId: string, item: Item) {
  const b = await prisma.build.findFirst({ where: { id: item.buildId!, companyId }, include: { commands: { orderBy: { createdAt: "asc" } } } });
  if (!b) return { kind: "missing" as const };
  const tests = b.commands.filter((c) => c.purpose === "test" && c.actor === "engine");
  const lastTest = tests[tests.length - 1];
  const evidence: Evidence[] = [
    ...(lastTest ? [{ kind: "test_run", ref: lastTest.id, detail: `${lastTest.command} → exit ${lastTest.exitCode}${lastTest.timedOut ? " (timed out)" : ""} in the sandbox` }] : []),
    ...b.commands.filter((c) => c.actor === "engine" && c.purpose !== "test").map((c) => ({ kind: c.purpose, ref: c.id, detail: `${c.command} → exit ${c.exitCode}` })),
    ...parseJSON<{ text: string; status: string; evidence: string }[]>(b.criteria, []).map((c) => ({ kind: "criterion", ref: c.status, detail: `${c.text} — ${c.status}: ${c.evidence}` })),
    ...parseJSON<{ source: string; title: string; blocking: boolean }[]>(b.findings, []).map((f) => ({ kind: "finding", ref: f.source, detail: `${f.title}${f.blocking ? " (blocking)" : ""}` })),
    ...(b.headSha ? [{ kind: "commit", ref: b.headSha, detail: `${b.branch}${b.status === "VERIFIED" ? "" : " (not verified)"}` }] : []),
    { kind: "build", ref: b.id, detail: `${b.status.toLowerCase()} after ${b.attempt + 1} attempt(s)` },
  ];
  if (b.status === "VERIFIED") {
    // Re-check from the records, not the label: the last engine test run must have exited 0.
    const ok = lastTest?.exitCode === 0 && !lastTest.timedOut && parseJSON<{ status: string }[]>(b.criteria, []).every((c) => c.status === "met");
    return ok ? { kind: "verified" as const, evidence, b } : { kind: "inconclusive" as const, evidence, b, reason: "the run is marked verified but its recorded evidence does not support it" };
  }
  if (b.status === "FAILED") return { kind: "failed" as const, evidence, b, reason: b.failure.split("\n")[0] || "verification failed" };
  if (b.status === "BLOCKED") return { kind: "blocked" as const, evidence, b, reason: b.failure || "blocked" };
  if (b.status === "CANCELLED") return { kind: "cancelled" as const, evidence, b };
  return { kind: "running" as const, evidence, b };
}

async function dispatch(p: ProductRow, item: Item, actor: string) {
  const limits = limitsOf(p);
  const b = await startBuild({ companyId: p.companyId, productId: p.id, itemKey: item.key, actor, budgetUsd: limits.budgetUsd, maxRepairs: item.level === "REPAIR" ? Math.max(1, limits.maxRepairs) : limits.maxRepairs });
  await setItemStatus(item, "IN_PROGRESS", ENGINE, `engineering run ${b.id.slice(-6)} queued`, { buildId: b.id, attempts: { increment: 1 }, verification: "RUNNING", blockedReason: "" });
  await productEvent(p.companyId, p.id, `${item.key} assigned to ${parseJSON<string[]>(item.capabilities, [])[0] ?? "engineering"} — engineering run queued`, { actor: parseJSON<string[]>(item.capabilities, [])[0] });
  return b.id;
}

/** Estimated model spend of all runs of a product (from recorded provider usage). */
export async function productSpend(companyId: string, productId: string) {
  const r = await prisma.build.aggregate({ where: { companyId, productId }, _sum: { costUsd: true } });
  return r._sum.costUsd ?? 0;
}

/** One scheduler tick for a product. Safe to call repeatedly and concurrently. */
export async function tickProduct(companyId: string, productId: string, opts: { actor?: string; steps?: number } = {}): Promise<TickResult> {
  let p = await loadProduct(companyId, productId);
  const out: TickResult = { productId, phase: p.phase, dispatched: [], advanced: [], settled: [], blocked: [], waitingOn: [] };
  if (p.status !== "ACTIVE") return { ...out, note: `Product is ${p.status.toLowerCase()}; nothing runs` };
  if (!p.scopeApproved) return { ...out, waitingOn: ["scope approval"], note: "Waiting for a person to approve the scope" };
  if (!(await takeLease(p))) return { ...out, note: "Another tick is in progress" };
  try {
    const limits = limitsOf(p);
    const steps = Math.min(Math.max(opts.steps ?? 6, 1), 20);
    // 0) Recover runs left "running" by a crashed worker whose job is gone, so their items can settle.
    await recoverOrphanedBuilds(companyId, productId);
    let items = await prisma.backlogItem.findMany({ where: { productId } });

    // 1) Settle finished engineering runs from their persisted evidence (runs execute in the job worker).
    for (const item of items.filter((i) => i.status === "IN_PROGRESS" && i.buildId)) {
      const ev = await evaluateBuild(companyId, item);
      if (ev.kind === "running" || ev.kind === "missing") {
        if (ev.kind === "running") out.waitingOn.push(`${item.key}: engineering run in progress`);
        continue;
      }
      const fresh = (await prisma.backlogItem.findUnique({ where: { id: item.id } }))!;
      if (ev.kind === "blocked") {
        await setItemStatus(fresh, "BLOCKED", ENGINE, ev.reason.slice(0, 300), { verification: "BLOCKED", evidence: JSON.stringify(ev.evidence), blockedReason: ev.reason.slice(0, 800) });
        out.blocked.push({ key: item.key, reason: ev.reason });
        continue;
      }
      if (ev.kind === "verified") {
        await setItemStatus(fresh, "VERIFIED", ENGINE, "verified: sandbox tests passed, review passed, acceptance met", { verification: "PASSED", evidence: JSON.stringify(ev.evidence) }, { verified: true });
        out.settled.push({ key: item.key, status: "VERIFIED" });
        await productEvent(companyId, p.id, `${item.key} verified with sandbox evidence`, { level: "success", actor: "qa-engineer" });
        await prisma.gitOperation.create({ data: { repoId: p.repoId!, companyId, productId: p.id, itemKey: item.key, op: "commit", branch: ev.b.branch, sha: ev.b.headSha, status: "SUCCEEDED", detail: `verified build ${ev.b.id.slice(-6)}`, idempotencyKey: `commit:${ev.b.id}` } }).catch(() => null);
        // A verified repair also settles the task it repaired.
        if (fresh.level === "REPAIR" && fresh.parentKey) {
          const parent = await prisma.backlogItem.findFirst({ where: { productId, key: fresh.parentKey } });
          if (parent && parent.status !== "VERIFIED") {
            if (parent.status !== "IN_PROGRESS" && parent.status !== "IN_REVIEW") await setItemStatus(parent, "IN_PROGRESS", ENGINE, `repair ${fresh.key} verified`);
            const again = (await prisma.backlogItem.findUnique({ where: { id: parent.id } }))!;
            await setItemStatus(again, "VERIFIED", ENGINE, `verified via repair ${fresh.key}`, { verification: "PASSED", evidence: JSON.stringify(ev.evidence) }, { verified: true });
            out.settled.push({ key: parent.key, status: "VERIFIED" });
          }
        }
      } else if (ev.kind === "inconclusive") {
        await setItemStatus(fresh, "BLOCKED", ENGINE, ev.reason, { verification: "INCONCLUSIVE", evidence: JSON.stringify(ev.evidence), blockedReason: ev.reason });
        out.blocked.push({ key: item.key, reason: ev.reason });
      } else if (ev.kind === "cancelled") {
        await setItemStatus(fresh, "FAILED", ENGINE, "execution cancelled", { verification: "NOT_RUN", evidence: JSON.stringify(ev.evidence) });
        out.settled.push({ key: item.key, status: "FAILED" });
      } else {
        await setItemStatus(fresh, "FAILED", ENGINE, ev.reason, { verification: "FAILED", evidence: JSON.stringify(ev.evidence) });
        out.settled.push({ key: item.key, status: "FAILED" });
        await productEvent(companyId, p.id, `${item.key} failed verification: ${ev.reason}`, { level: "warning" });
        await routeFailure(p, (await prisma.backlogItem.findUnique({ where: { id: item.id } }))!, ev.b, out);
      }
    }

    // 2) Dispatch ready work within the parallelism limit, never overlapping files.
    items = await prisma.backlogItem.findMany({ where: { productId } });
    const running = items.filter((i) => (i.level === "TASK" || i.level === "REPAIR") && i.status === "IN_PROGRESS");
    const busyFiles = new Set(running.flatMap(filesOf));
    const ready = readyKeys(items.map((i) => ({ key: i.key, level: i.level, status: i.status, dependsOn: depsOf(i) })));
    const byKey = new Map(items.map((i) => [i.key, i]));
    const ordered = ready.map((k) => byKey.get(k)!).sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
    let slots = Math.max(0, limits.maxParallel - running.length);
    // Product budget: estimated spend so far vs the configured limit. At the limit nothing new is dispatched.
    const spend = await productSpend(companyId, productId);
    const overBudget = spend >= limits.projectBudgetUsd;
    if (spend >= limits.projectBudgetUsd * BUDGET_ALERT_RATIO) {
      await prisma.notification.upsert({ where: { companyId_dedupeKey: { companyId, dedupeKey: `product-budget:${productId}:${overBudget ? "exhausted" : "warning"}` } }, create: { companyId, dedupeKey: `product-budget:${productId}:${overBudget ? "exhausted" : "warning"}`, kind: "budget", severity: overBudget ? "high" : "medium", title: overBudget ? `${p.title}: product budget reached — new work paused` : `${p.title}: ${Math.round((spend / limits.projectBudgetUsd) * 100)}% of the product budget used`, body: `Estimated model spend $${spend.toFixed(2)} of $${limits.projectBudgetUsd.toFixed(2)}. Raise the limit in product settings to continue.`, href: `/products/${productId}?tab=usage` }, update: {} });
    }
    const designTaskKeys = items.filter((i) => i.kind === "DESIGN" && i.status !== "CANCELLED").map((i) => i.key);
    const archTaskKeys = items.filter((i) => i.kind === "ARCHITECTURE" && i.status !== "CANCELLED").map((i) => i.key);
    const approved = await prisma.productArtifact.findMany({ where: { productId, companyId, status: "APPROVED", kind: { in: ["HANDOFF", "ARCHITECTURE"] } }, select: { kind: true } });
    const upstream = { designTaskKeys, archTaskKeys, hasApprovedHandoff: approved.some((a) => a.kind === "HANDOFF"), hasApprovedArchitecture: approved.some((a) => a.kind === "ARCHITECTURE") };
    for (const item of ordered) {
      if (item.status === "TODO") await setItemStatus(item, "READY", ENGINE, "dependencies satisfied");
      const cur = (await prisma.backlogItem.findUnique({ where: { id: item.id } }))!;
      if (!mayAutoDispatch(p.autonomy as Autonomy)) {
        out.waitingOn.push(`${item.key}: autonomy is SUGGEST — dispatch manually`);
        continue;
      }
      if (cur.kind === "DESIGN" || cur.kind === "ARCHITECTURE") {
        const marker = JSON.stringify(cur.key);
        const existingArtifact = await prisma.productArtifact.findFirst({ where: { productId, kind: cur.kind, consumedBy: { contains: marker }, status: { in: ["PROPOSED", "APPROVED"] } } });
        if (!existingArtifact) {
          await setItemStatus(cur, "IN_PROGRESS", ENGINE, `${cur.kind.toLowerCase()} drafting`, { verification: "RUNNING" });
          const a = cur.kind === "DESIGN" ? await produceDesign(p, cur) : await produceArchitecture(p, cur);
          const after = (await prisma.backlogItem.findUnique({ where: { id: cur.id } }))!;
          await setItemStatus(after, "IN_REVIEW", ENGINE, `artifact v${a.version} awaiting review`, { evidence: JSON.stringify([{ kind: "artifact", ref: a.id, detail: `${a.kind} v${a.version} (${a.source})` }]) });
          out.dispatched.push(cur.key);
        }
        continue;
      }
      if (!cur.executable) {
        const reason = "No executable codebase/test suite covers this task's files, so AURA cannot run or verify it. Attach a repository with tests or accept it manually as unverified.";
        await setItemStatus(cur, "BLOCKED", ENGINE, reason, { verification: "BLOCKED", blockedReason: reason });
        out.blocked.push({ key: cur.key, reason });
        continue;
      }
      if (overBudget) {
        out.waitingOn.push(`${cur.key}: product budget reached (est. $${spend.toFixed(2)} of $${limits.projectBudgetUsd.toFixed(2)})`);
        continue;
      }
      if (slots <= 0) {
        out.waitingOn.push(`${cur.key}: parallel limit (${limits.maxParallel}) reached`);
        continue;
      }
      if (filesOf(cur).some((f) => busyFiles.has(f))) {
        out.waitingOn.push(`${cur.key}: shares files with running work`);
        continue;
      }
      // Handoff validation: downstream work never starts with a mandatory upstream artifact missing.
      const missing = missingInputs({ kind: cur.kind, dependsOn: parseJSON<string[]>(cur.dependsOn, []) }, upstream);
      if (missing.length) {
        out.waitingOn.push(`${cur.key}: waiting for ${missing.join(" and ")}`);
        continue;
      }
      if (cur.attempts >= limits.maxAttempts) {
        const reason = `Reached the dispatch limit (${limits.maxAttempts}); needs a person to narrow the task or raise the limit`;
        await setItemStatus(cur, "BLOCKED", ENGINE, reason, { verification: "BLOCKED", blockedReason: reason });
        out.blocked.push({ key: cur.key, reason });
        continue;
      }
      if (needsApproval(p.autonomy as Autonomy, "local_execution")) {
        out.waitingOn.push(`${cur.key}: needs approval to execute`);
        continue;
      }
      await dispatch(p, cur, opts.actor ?? "scheduler");
      filesOf(cur).forEach((f) => busyFiles.add(f));
      out.dispatched.push(cur.key);
      slots--;
    }

    // Maintenance proposals follow their tasks' verified outcomes.
    await settleProposals(companyId, productId).catch(() => null);
    // Feature contracts: one shared definition per story; a changed definition flags already-verified tasks.
    const contractChanges = await syncFeatureContracts(companyId, productId).catch(() => []);
    for (const c of contractChanges) if (c.affected.length) await productEvent(companyId, productId, `Feature contract ${c.story} changed (v${c.version}); verified work to re-check: ${c.affected.join(", ")}`, { level: "warning", actor: "product-manager" });

    // 3) Roll up stories/epics and derive the phase from the backlog.
    items = await prisma.backlogItem.findMany({ where: { productId } });
    for (const level of ["STORY", "EPIC"] as const) {
      for (const parent of items.filter((i) => i.level === level)) {
        const kids = items.filter((i) => i.parentKey === parent.key && i.level !== "REPAIR");
        const next = rollUp(kids);
        if (next !== parent.status) {
          await prisma.backlogItem.update({ where: { id: parent.id }, data: { status: next, verification: next === "VERIFIED" ? "PASSED" : parent.verification } });
          parent.status = next;
        }
      }
    }
    p = await loadProduct(companyId, productId);
    const verifying = await missionsVerifying(items);
    const target = derivePhase(p.phase, items, { verifying, scopeApproved: p.scopeApproved });
    if (target !== p.phase) {
      const reason = out.settled.find((s) => s.status === "FAILED") ? `${out.settled.find((s) => s.status === "FAILED")!.key} failed verification` : out.dispatched.length ? `${out.dispatched.join(", ")} started` : out.settled.length ? `${out.settled.map((s) => `${s.key} ${s.status.toLowerCase()}`).join(", ")}` : "backlog state changed";
      p = await movePhase(p, target, "scheduler", reason, out.settled.map((s) => ({ kind: "item", ref: s.key, detail: s.status })));
    }
    out.phase = p.phase;
    return out;
  } finally {
    await releaseLease(productId);
  }
}

/** True when an in-flight run is currently verifying or reviewing (persisted build phase). */
async function missionsVerifying(items: Item[]) {
  const ids = items.filter((i) => i.status === "IN_PROGRESS" && i.buildId).map((i) => i.buildId!);
  if (!ids.length) return false;
  return (await prisma.build.count({ where: { id: { in: ids }, status: "RUNNING", phase: { in: ["verify", "review"] } } })) > 0;
}

/**
 * A failed run → a REPAIR item routed back to the same capability with the
 * real failure output, within limits; beyond them the task is BLOCKED for a
 * person with the evidence summary.
 */
async function routeFailure(p: ProductRow, item: Item, b: { id: string; failure: string; findings: string; attempt: number; branch: string }, out: TickResult) {
  const limits = limitsOf(p);
  const repairs = await prisma.backlogItem.count({ where: { productId: p.id, level: "REPAIR", parentKey: item.key } });
  const blocking = parseJSON<{ source: string; title: string; detail: string; blocking: boolean }[]>(b.findings, []).filter((f) => f.blocking);
  if (repairs >= limits.maxAttempts - 1 || item.level === "REPAIR") {
    const reason = `Not verified after ${item.attempts} run(s) and ${b.attempt + 1} attempt(s) in the last run. ${blocking.map((f) => `[${f.source}] ${f.title}`).join("; ") || b.failure.split("\n")[0]}. Work in progress is on ${b.branch}. Narrow the task or intervene.`;
    const target = item.level === "REPAIR" && item.parentKey ? await prisma.backlogItem.findFirst({ where: { productId: p.id, key: item.parentKey } }) : item;
    if (target && target.status !== "BLOCKED") {
      await setItemStatus(target, "BLOCKED", ENGINE, reason.slice(0, 380), { verification: "FAILED", blockedReason: reason.slice(0, 800) });
      out.blocked.push({ key: target.key, reason });
    }
    await prisma.notification.upsert({ where: { companyId_dedupeKey: { companyId: p.companyId, dedupeKey: `product-blocked:${p.id}:${item.key}` } }, create: { companyId: p.companyId, dedupeKey: `product-blocked:${p.id}:${item.key}`, kind: "intervention", severity: "high", title: `${item.key} needs a person: verification keeps failing`, body: reason.slice(0, 400), href: `/products/${p.id}?item=${item.key}` }, update: {} });
    return;
  }
  const key = `${item.key}.R${repairs + 1}`;
  const desc = `Repair ${item.key} (${item.title}). The previous run did not pass verification:\n${b.failure.slice(0, 600)}`;
  await prisma.backlogItem.create({
    data: {
      productId: p.id, companyId: p.companyId, key, level: "REPAIR", kind: item.kind, parentKey: item.key, title: `Repair: ${item.title}`.slice(0, 160), description: `${item.description}\n\n${desc}`.slice(0, 1800),
      acceptance: item.acceptance, requirements: item.requirements, dependsOn: "[]", effort: Math.max(1, Math.ceil(item.effort / 2)), capabilities: item.capabilities, files: item.files, verifyBy: item.verifyBy, risk: item.risk,
      executable: item.executable, milestone: item.milestone, priority: Math.max(0, item.priority - 1), status: "READY",
      evidence: JSON.stringify([{ kind: "failed_build", ref: b.id, detail: b.failure.split("\n")[0].slice(0, 200) }, ...blocking.slice(0, 5).map((f) => ({ kind: "finding", ref: f.source, detail: f.title }))]),
      history: JSON.stringify([{ at: new Date().toISOString(), actor: "scheduler", change: `created from failed verification of ${item.key}` }]),
    },
  });
  await appendItemHistory(item.id, "scheduler", `repair ${key} created and routed to ${parseJSON<string[]>(item.capabilities, [])[0] ?? "engineering"}`);
  await productEvent(p.companyId, p.id, `Repair ${key} created from ${item.key}'s failed verification`, { level: "warning", actor: "qa-engineer" });
}

/** Pause / resume / cancel a product: propagates to in-flight missions and reports what could not stop. */
export async function controlProduct(companyId: string, productId: string, action: "pause" | "resume" | "cancel", actor: string) {
  const p = await loadProduct(companyId, productId);
  const inflight = await prisma.backlogItem.findMany({ where: { productId, status: "IN_PROGRESS", buildId: { not: null } } });
  const notes: string[] = [];
  if (action === "pause") {
    if (p.status !== "ACTIVE") throw new ApiError(`Product is ${p.status.toLowerCase()}`, 409);
    await prisma.product.update({ where: { id: p.id }, data: { status: "PAUSED" } });
    // Pausing stops NEW dispatch; runs already executing finish (their results are settled on resume).
    if (inflight.length) notes.push(`${inflight.length} run(s) already executing will finish: ${inflight.map((i) => i.key).join(", ")}`);
  } else if (action === "resume") {
    if (p.status !== "PAUSED") throw new ApiError("Product is not paused", 409);
    await prisma.product.update({ where: { id: p.id }, data: { status: "ACTIVE" } });
  } else {
    if (p.status === "CANCELLED") throw new ApiError("Product already cancelled", 409);
    await prisma.product.update({ where: { id: p.id }, data: { status: "CANCELLED" } });
    for (const i of inflight) {
      try {
        const r = await cancelBuild(companyId, i.buildId!);
        if (r.note) notes.push(`${i.key}: ${r.note}`);
      } catch (e) {
        notes.push(`${i.key}: ${(e as Error).message}`);
      }
      await setItemStatus(i, "CANCELLED", { kind: "user", id: actor }, "product cancelled");
    }
    await prisma.backlogItem.updateMany({ where: { productId, status: { in: ["TODO", "READY", "BLOCKED", "FAILED"] } }, data: { status: "CANCELLED" } });
    await prisma.productApproval.updateMany({ where: { productId, status: "PENDING" }, data: { status: "CANCELLED", decidedBy: actor, decidedAt: new Date() } });
  }
  await productEvent(companyId, productId, `Product ${action}d by ${actor}${notes.length ? ` — could not ${action} immediately: ${notes.join("; ")}` : ""}`, { level: action === "cancel" ? "warning" : "info" });
  return { status: action === "pause" ? "PAUSED" : action === "resume" ? "ACTIVE" : "CANCELLED", inflight: inflight.map((i) => i.key), notes };
}

export { requestApproval };
export type { ItemStatus };
