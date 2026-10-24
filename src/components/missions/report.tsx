"use client";

import { CheckCircle2, XCircle, HelpCircle } from "lucide-react";
import { useQuery } from "@/hooks/useApi";
import { Badge, Section, Skeleton, StatusBadge } from "@/components/ui/primitives";
import { Term } from "@/components/ui/term";
import { ModeBadge } from "./evidence";
import { cn } from "@/lib/utils";

interface Report {
  mission: { status: string; statusReason: string; durationMs: number | null; source: string };
  tasks: { total: number; succeeded: number; failed: number; skipped: number; pending: number };
  agents: string[];
  usage: { costUsd: number; modelCalls: number; toolCalls: number; budgetUsd: number; costNote: string };
  repair: { fixAttempts: number; maxAttempts: number; testRuns: number; repairRounds?: number; maxRepairs?: number };
  finalTest: { name: string; mode: string; passed: number; failed: number; total: number } | null;
  files: { path: string; added?: number; removed?: number; author?: string }[];
  security: { check: string; pass: boolean }[];
  criteria: { text: string; status: "met" | "not met" | "unverified"; evidence: string }[];
  approvals: { id: string; action: string; status: string; decidedBy: string | null; decidedAt: string | null }[];
  ledger: { proposed: number; executed: number; verified: number; humanApproved: number; deployed: number; deployedNote: string };
  unresolved: string[];
}

const CRIT_ICON = {
  met: { Icon: CheckCircle2, cls: "text-success" },
  "not met": { Icon: XCircle, cls: "text-danger" },
  unverified: { Icon: HelpCircle, cls: "text-warning" },
};

/**
 * Completion report built server-side from persisted rows. The ledger keeps
 * five levels apart so "proposed" is never read as "deployed".
 */
export function MissionReport({ companyId, missionId, version }: { companyId: string; missionId: string; version: string }) {
  const { data: r } = useQuery<Report>(`/api/companies/${companyId}/missions/${missionId}/report?v=${version}`);
  if (!r) return <Skeleton className="h-64" />;
  const L = r.ledger;
  const ledger = [
    { label: "Proposed", value: L.proposed, hint: "tasks in the approved plan" },
    { label: "Executed", value: L.executed, hint: "tasks that actually ran" },
    { label: "Verified", value: L.verified, hint: "with recorded passing evidence", term: "verification" as const },
    { label: "Human-approved", value: L.humanApproved, hint: "gates approved by a person", term: "gate" as const },
    { label: "Deployed", value: L.deployed, hint: L.deployedNote },
  ];
  return (
    <div className="space-y-6" data-testid="mission-report">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={r.mission.status} />
        <span className="text-sm text-text-muted">{r.mission.statusReason}</span>
      </div>

      <ol className="grid grid-cols-2 overflow-hidden rounded-lg border border-border sm:grid-cols-5" aria-label="Outcome ledger">
        {ledger.map((x, i) => (
          <li key={x.label} className={cn("px-3 py-3", i > 0 && "border-l border-border")}>
            <div className="metric-label">{x.term ? <Term k={x.term}>{x.label}</Term> : x.label}</div>
            <div className="mono mt-1 text-xl" data-ledger={x.label}>{x.value}</div>
            <div className="mt-0.5 text-2xs leading-snug text-text-faint">{x.hint}</div>
          </li>
        ))}
      </ol>

      <Section title="Acceptance criteria">
        <ul className="divide-y divide-border-subtle rounded-lg border border-border">
          {r.criteria.map((c) => {
            const { Icon, cls } = CRIT_ICON[c.status];
            return (
              <li key={c.text} className="flex items-start gap-2.5 px-3 py-2.5" data-criterion={c.status}>
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", cls)} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text">{c.text}</div>
                  <div className="text-xs text-text-muted">{c.evidence}</div>
                </div>
                <span className={cn("mono text-2xs", cls)}>{c.status}</span>
              </li>
            );
          })}
        </ul>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Final test run">
          {r.finalTest ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <ModeBadge mode={r.finalTest.mode} />
              <span className={cn("mono", r.finalTest.failed ? "text-danger" : "text-success")}>{r.finalTest.passed}/{r.finalTest.total} passed</span>
              <span className="text-xs text-text-muted">after {r.repair.fixAttempts} change attempt{r.repair.fixAttempts === 1 ? "" : "s"} ({r.repair.repairRounds ?? 0} of {r.repair.maxRepairs ?? 0} repair rounds used), {r.repair.testRuns} test runs in total</span>
            </div>
          ) : (
            <p className="text-sm text-text-muted">No verification run was recorded for this mission.</p>
          )}
          {r.files.map((f) => (
            <div key={f.path} className="mono mt-2 text-xs text-text-muted">
              {f.path} <span className="text-success">+{f.added}</span> <span className="text-danger">−{f.removed}</span> · {f.author === "model-assisted" ? "model-assisted change" : "prepared repair candidate (simulator)"}
            </div>
          ))}
        </Section>
        <Section title="Usage">
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div><dt className="metric-label">Model calls</dt><dd className="mono mt-1">{r.usage.modelCalls}</dd></div>
            <div><dt className="metric-label">Tool calls</dt><dd className="mono mt-1">{r.usage.toolCalls}</dd></div>
            <div><dt className="metric-label">Est. cost</dt><dd className="mono mt-1">${r.usage.costUsd.toFixed(4)} <span className="text-2xs text-text-faint">/ ${r.usage.budgetUsd}</span></dd></div>
          </dl>
          <p className="mt-1 text-2xs text-text-faint">{r.usage.costNote} Agents involved: {r.agents.join(", ")}.</p>
        </Section>
      </div>

      {r.unresolved.length > 0 && (
        <Section title="Unresolved / not verified">
          <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
            {r.unresolved.map((u) => <li key={u}>{u}</li>)}
          </ul>
        </Section>
      )}
      {r.mission.source === "SEEDED" && <Badge>sample mission generated by the engine during demo setup</Badge>}
    </div>
  );
}
