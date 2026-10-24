"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, XCircle, Loader2, Ban, Lock, RefreshCw } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { PageHeader, StatusBadge, ErrorState, Skeleton, Badge, Section } from "@/components/ui/primitives";
import { Term, ActionFacts } from "@/components/ui/term";
import { PlanGraph } from "@/components/missions/plan-graph";
import { ArtifactView } from "@/components/missions/evidence";
import { MissionReport } from "@/components/missions/report";
import { CollaborationTimeline, FindingsList } from "@/components/missions/collaboration";
import { markTourStep } from "@/components/onboarding/tour";
import type { MissionDetail, MissionApproval } from "@/components/missions/types";
import { useApp } from "@/lib/store";
import { cn, timeAgo } from "@/lib/utils";

type Tab = "plan" | "collaboration" | "evidence" | "report";
const ACTIVE = ["READY", "RUNNING"];
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];

export default function MissionPage({ params }: { params: Promise<{ id: string; missionId: string }> }) {
  const { id, missionId } = use(params);
  const base = `/api/companies/${id}/missions/${missionId}`;
  const { data: m, error, refetch } = useQuery<MissionDetail>(base, 4000);
  const { version } = useLiveEvents(id);
  const { mutate, loading: busy } = useMutation<Record<string, unknown>, any>();
  const { toast } = useApp();
  const [tab, setTab] = useState<Tab>("plan");
  const [selected, setSelected] = useState<string | null>(null);
  const [stepping, setStepping] = useState(false);
  const [note, setNote] = useState("");
  const driving = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    if (version > 0) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Default the tab to the report once a mission has finished.
  const finished = m ? TERMINAL.includes(m.status) : false;
  useEffect(() => {
    if (finished) setTab((t) => (t === "plan" ? "report" : t));
  }, [finished]);

  useEffect(() => {
    if (tab === "evidence") markTourStep("inspect-evidence", id);
    if (tab === "report") markTourStep("read-report", id);
  }, [tab, id]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Drive the engine while this page is open: one bounded step per request.
   * All state is persisted, so a refresh simply resumes from the database.
   * If another worker (tab, or a request still finishing) holds the task
   * lease, wait and retry rather than stopping.
   */
  const drive = useCallback(async () => {
    if (driving.current) return;
    driving.current = true;
    setStepping(true);
    try {
      for (let i = 0; i < 60 && mounted.current; i++) {
        const r = await mutate(`${base}/advance`, { steps: 1 });
        refetch();
        if (TERMINAL.includes(r.status) || r.status === "PAUSED" || r.waitingOn) break;
        if (!r.progressed) {
          if (/another worker|claimed by another/.test(r.note ?? "")) {
            await new Promise((res) => setTimeout(res, 1500));
            continue;
          }
          break;
        }
      }
    } catch (e) {
      if (mounted.current) toast({ title: "Execution step failed", description: (e as Error).message, level: "danger" });
    } finally {
      driving.current = false;
      if (mounted.current) {
        setStepping(false);
        refetch();
      }
    }
  }, [base, mutate, refetch, toast]);

  const status = m?.status;
  const source = m?.source;
  useEffect(() => {
    if (source && source !== "SEEDED" && status && ACTIVE.includes(status)) drive();
  }, [status, source, drive]);

  async function act(url: string, body: Record<string, unknown>, success: string, after?: () => void) {
    try {
      await mutate(url, body);
      toast({ title: success, level: "success" });
      setNote("");
      after?.();
      refetch();
    } catch (e) {
      toast({ title: "Action failed", description: (e as Error).message, level: "danger" });
      refetch();
    }
  }

  if (error && !m) return <div className="page"><ErrorState message={error} onRetry={refetch} /></div>;
  if (!m) return <div className="page space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;

  const readOnly = m.source === "SEEDED";
  const plan = m.plans[0];
  const gate = m.approvals.find((a) => a.status === "PENDING");
  const sel = m.tasks.find((t) => t.key === selected) ?? null;
  const selArtifacts = sel ? m.artifacts.filter((a) => a.taskKey === sel.key) : [];
  const evidence = m.artifacts.filter((a) => a.kind !== "FILE");
  const finalFile = [...m.artifacts].reverse().find((a) => a.kind === "FILE");

  return (
    <div className="page">
      <Link href={`/app/${id}/missions`} className="mb-3 inline-flex items-center gap-1 text-xs text-text-muted hover:text-text">
        <ArrowLeft className="h-3 w-3" /> Missions
      </Link>
      <PageHeader
        title={m.title}
        meta={
          <>
            <span title={m.statusHelp} data-testid="mission-status"><StatusBadge status={m.status} /></span>
            {readOnly && <Badge><Lock className="h-2.5 w-2.5" /> sample · read-only</Badge>}
            {m.source === "EXAMPLE" && <Badge>example</Badge>}
          </>
        }
        description={<>{m.statusHelp}{m.statusReason && <span className="text-text-faint"> — {m.statusReason}</span>}</>}
        actions={
          !readOnly && !TERMINAL.includes(m.status) ? (
            <button onClick={() => act(`${base}/cancel`, {}, "Mission cancelled")} disabled={busy} className="btn-ghost" title="Stops scheduling. Not reversible.">
              <Ban className="h-3.5 w-3.5" /> Cancel mission
            </button>
          ) : undefined
        }
      />

      <dl className="mb-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
        <div className="col-span-2"><dt className="metric-label">Objective</dt><dd className="mt-1 text-text-muted">{m.objective}</dd></div>
        <div><dt className="metric-label">Progress</dt><dd className="mono mt-1">{m.tasks.filter((t) => t.status === "SUCCEEDED").length}/{m.tasks.length} tasks</dd></div>
        <div><dt className="metric-label">Calls</dt><dd className="mono mt-1">{m.modelCalls} model · {m.toolCalls} tool</dd></div>
        <div><dt className="metric-label">Est. cost / budget</dt><dd className="mono mt-1">${m.costUsd.toFixed(4)} / ${m.budgetUsd}</dd></div>
      </dl>

      {stepping && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-bg-raised px-3 py-2 text-sm text-text-muted" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
          Agents are executing tasks. Each step is saved; execution advances while this page is open and resumes when you return.
        </div>
      )}
      {!stepping && !readOnly && ACTIVE.includes(m.status) && (
        <div className="mb-4 flex items-center gap-2 text-sm text-text-muted">
          <button onClick={drive} className="btn-secondary btn-sm"><RefreshCw className="h-3 w-3" /> Resume execution</button>
        </div>
      )}

      {m.status === "AWAITING_APPROVAL" && plan && (
        <section className="mb-5 rounded-lg border border-warning/35 bg-warning/[0.04]" aria-label="Plan approval" data-testid="plan-approval">
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/20 px-4 py-2.5">
            <span className="text-sm font-medium text-warning"><Term k="plan">Plan</Term> v{plan.version} needs your review</span>
            <span className="text-xs text-text-muted">{m.tasks.length} tasks · ~{plan.estimatedMinutes} min · est. ${plan.estimatedCostUsd.toFixed(2)}</span>
          </div>
          <div className="px-4 py-3 text-sm text-text-muted">
            <p>{plan.summary}</p>
            {plan.risks.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs">{plan.risks.map((r) => <li key={r}>{r}</li>)}</ul>}
          </div>
          {!readOnly ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-warning/20 px-4 py-2.5">
              <span className="mr-auto text-xs text-text-muted">Approving lets agents run the tasks below with only the listed tools. <ActionFacts model reversible={false} /></span>
              <button onClick={() => act(`${base}/plan`, { action: "reject" }, "Plan rejected")} disabled={busy} className="btn-ghost"><XCircle className="h-3.5 w-3.5" /> Reject</button>
              <button onClick={() => act(`${base}/plan`, { action: "approve" }, "Plan approved — execution starting", () => markTourStep("approve-plan", id))} disabled={busy} className="btn-primary" data-tour="approve-plan">
                <CheckCircle2 className="h-3.5 w-3.5" /> Approve plan
              </button>
            </div>
          ) : (
            <p className="border-t border-warning/20 px-4 py-2.5 text-xs text-text-muted">Sample missions are read-only. Use <Link className="underline" href={`/app/${id}/missions?example=1`}>Run example mission</Link> to make your own copy.</p>
          )}
        </section>
      )}

      {gate && <GateCard gate={gate} readOnly={readOnly} busy={busy} note={note} setNote={setNote} finalLines={finalFile?.content.split("\n").length}
        onDecide={(decision) => act(`${base}/approvals/${gate.id}`, { decision, note }, decision === "approve" ? "Change approved" : "Change rejected", () => markTourStep("decide-gate", id))}
        onEvidence={() => setTab("evidence")} />}

      <div className="tabs mb-4" role="tablist">
        {(["plan", "collaboration", "evidence", "report"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} data-active={tab === t} onClick={() => setTab(t)} className="tab">
            {t === "plan" ? "Plan & tasks" : t === "collaboration" ? "Collaboration" : t === "evidence" ? `Evidence (${evidence.length})` : "Report"}
          </button>
        ))}
      </div>

      {tab === "plan" && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Section title={<>Tasks by <Term k="dependency">dependency</Term></>}>
            <PlanGraph tasks={m.tasks} levels={m.levels} selected={selected} onSelect={setSelected} />
          </Section>
          <Section title="Task detail">
            {sel ? (
              <div className="space-y-3 rounded-lg border border-border p-3 text-sm" data-testid="task-detail">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{sel.title}</span><StatusBadge status={sel.status} /></div>
                <p className="text-text-muted">{sel.description}</p>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="metric-label"><Term k="agent" /></dt><dd className="mono mt-0.5">{sel.agentKey}</dd></div>
                  <div><dt className="metric-label">Attempts</dt><dd className="mono mt-0.5">{sel.attempts}/{sel.maxAttempts}</dd></div>
                  <div className="col-span-2"><dt className="metric-label"><Term k="tool">Allowed tools</Term></dt><dd className="mono mt-0.5">{sel.tools.join(", ") || "none — human decision"}</dd></div>
                  {sel.files && sel.files.length > 0 && <div className="col-span-2"><dt className="metric-label">Write scope (enforced)</dt><dd className="mono mt-0.5">{sel.files.join(", ")}</dd></div>}
                  {sel.assignmentReason && <div className="col-span-2"><dt className="metric-label">Why this agent</dt><dd className="mt-0.5 text-text-muted">{sel.assignmentReason}</dd></div>}
                </dl>
                {sel.output && <pre className="well mono whitespace-pre-wrap p-2 text-2xs text-text-muted">{sel.output}</pre>}
                {sel.errorCategory && <Badge tone="danger">{sel.errorCategory.replace(/_/g, " ")}</Badge>}
                {selArtifacts.filter((a) => a.kind !== "FILE").map((a) => <ArtifactView key={a.id} a={a} />)}
              </div>
            ) : (
              <p className="text-sm text-text-muted">Select a task to see its agent, allowed tools, output and evidence.</p>
            )}
          </Section>
        </div>
      )}

      {tab === "evidence" && (
        <div className="space-y-3">
          {evidence.length === 0 ? (
            <p className="text-sm text-text-muted">No <Term k="artifact">artifacts</Term> yet. They appear as tasks run: analyses, test reports from the sandbox, diffs and the security review.</p>
          ) : (
            evidence.map((a) => <ArtifactView key={a.id} a={a} />)
          )}
          {finalFile && (
            <details className="rounded-md border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm">Final file — {finalFile.name} v{finalFile.version}</summary>
              <ArtifactView a={finalFile} />
            </details>
          )}
        </div>
      )}

      {tab === "collaboration" && (
        <div className="space-y-6">
          <CollaborationTimeline companyId={id} missionId={missionId} version={`${m.status}-${m.tasks.map((t) => t.status[0]).join("")}-${m.artifacts.length}`} />
          <FindingsList findings={m.findings ?? []} />
        </div>
      )}

      {tab === "report" && <MissionReport companyId={id} missionId={missionId} version={`${m.status}-${m.approvals.length}-${m.artifacts.length}`} />}

      <p className="mono mt-8 text-2xs text-text-faint">created {timeAgo(m.createdAt)} · plan v{m.planVersion}</p>
    </div>
  );
}

function GateCard({ gate, readOnly, busy, note, setNote, onDecide, onEvidence, finalLines }: {
  gate: MissionApproval; readOnly: boolean; busy: boolean; note: string; setNote: (s: string) => void;
  onDecide: (d: "approve" | "reject") => void; onEvidence: () => void; finalLines?: number;
}) {
  return (
    <section className="mb-5 rounded-lg border border-warning/35 bg-warning/[0.04]" aria-label="Approval gate" data-testid="approval-gate">
      <div className="flex flex-wrap items-center gap-2 border-b border-warning/20 px-4 py-2.5">
        <span className="text-sm font-medium text-warning"><Term k="gate">Approval gate</Term>: a person must decide</span>
        <StatusBadge status={gate.risk} />
        <span className="ml-auto text-2xs text-text-faint">requested {timeAgo(gate.createdAt)}</span>
      </div>
      <dl className="grid gap-3 px-4 py-3 text-sm sm:grid-cols-2">
        <div><dt className="metric-label">Action</dt><dd className="mt-1">{gate.action}</dd></div>
        <div><dt className="metric-label">Why approval is needed</dt><dd className="mt-1 text-text-muted">{gate.reason}</dd></div>
        <div><dt className="metric-label">Change</dt><dd className="mono mt-1 text-text-muted">{gate.impact}{finalLines ? ` · ${finalLines} lines in final file` : ""}</dd></div>
        <div><dt className="metric-label">If approved / rejected</dt><dd className="mt-1 text-text-muted">{gate.onApprove} {gate.onReject}</dd></div>
      </dl>
      {readOnly ? (
        <p className="border-t border-warning/20 px-4 py-2.5 text-xs text-text-muted">This is a sample run and stays at the gate. Run the example mission to decide one yourself.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-t border-warning/20 px-4 py-2.5">
          <button onClick={onEvidence} className="btn-ghost btn-sm">Review evidence first</button>
          <input aria-label="Decision note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)" className={cn("input h-7 max-w-xs flex-1 text-xs")} />
          <span className="flex-1" />
          <ActionFacts reversible={false} />
          <button onClick={() => onDecide("reject")} disabled={busy} className="btn-ghost"><XCircle className="h-3.5 w-3.5" /> Reject</button>
          <button onClick={() => onDecide("approve")} disabled={busy} className="btn-primary" data-tour="decide-gate"><CheckCircle2 className="h-3.5 w-3.5" /> Approve change</button>
        </div>
      )}
    </section>
  );
}
