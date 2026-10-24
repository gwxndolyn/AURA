"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Target, PlayCircle, Plus, Loader2, Lock } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { PageHeader, StatusBadge, EmptyState, ErrorState, Skeleton, Badge } from "@/components/ui/primitives";
import { Term, ActionFacts } from "@/components/ui/term";
import { markTourStep } from "@/components/onboarding/tour";
import { MissionScorecards } from "@/components/missions/collaboration";
import { useApp } from "@/lib/store";
import { timeAgo } from "@/lib/utils";

interface MissionRow {
  id: string;
  title: string;
  objective: string;
  status: string;
  statusHelp: string;
  statusReason: string;
  source: "USER" | "EXAMPLE" | "SEEDED";
  createdAt: string;
  costUsd: number;
  progress: { done: number; total: number; failed: number };
  pendingApprovals: number;
}

const SOURCE_LABEL = { USER: "yours", EXAMPLE: "example", SEEDED: "sample · read-only" } as const;

export default function MissionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const search = useSearchParams();
  const { toast } = useApp();
  const { data, loading, error, refetch } = useQuery<MissionRow[]>(`/api/companies/${id}/missions`, 5000);
  const { mutate, loading: busy } = useMutation<unknown, { id: string }>();
  const [composing, setComposing] = useState(false);
  const [objective, setObjective] = useState("");
  const autoRan = useRef(false);

  useEffect(() => {
    markTourStep("view-missions", id);
  }, [id]);

  async function runExample() {
    try {
      const r = await mutate(`/api/companies/${id}/missions/example`);
      markTourStep("run-example", id);
      router.push(`/app/${id}/missions/${r.id}`);
    } catch (e) {
      toast({ title: "Couldn't start the example mission", description: (e as Error).message, level: "danger" });
    }
  }

  useEffect(() => {
    if (search.get("example") === "1" && !autoRan.current) {
      autoRan.current = true;
      runExample();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await mutate(`/api/companies/${id}/missions`, { objective });
      router.push(`/app/${id}/missions/${r.id}`);
    } catch (err) {
      toast({ title: "Couldn't create the mission", description: (err as Error).message, level: "danger" });
    }
  }

  const needsYou = data?.filter((m) => m.source !== "SEEDED" && (m.status === "AWAITING_APPROVAL" || m.pendingApprovals > 0)) ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Missions"
        description={
          <>
            A <Term k="mission">mission</Term> is a goal the agent team plans, executes and verifies. Every <Term k="plan">plan</Term> and every release-ready change waits at an <Term k="gate">approval gate</Term> for you.
          </>
        }
        actions={
          <>
            <button onClick={() => setComposing((v) => !v)} className="btn-secondary">
              <Plus className="h-3.5 w-3.5" /> New mission
            </button>
            <button onClick={runExample} disabled={busy} className="btn-primary" data-tour="run-example">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
              Run example mission
            </button>
          </>
        }
      />

      <p className="-mt-2 mb-4 text-xs text-text-muted">
        The example investigates a one-cent checkout undercharge, fixes it, runs the tests in the Docker sandbox and stops for your approval.{" "}
        <ActionFacts reversible model approval />
      </p>

      {composing && (
        <form onSubmit={create} className="card mb-5 p-4">
          <label htmlFor="objective" className="label">Objective</label>
          <textarea id="objective" className="input" rows={3} maxLength={2000} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="e.g. Review the invoices API for missing input validation and propose fixes" />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy || objective.trim().length < 10} className="btn-primary">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Create and plan
            </button>
            <button type="button" onClick={() => setComposing(false)} className="btn-ghost">Cancel</button>
            <span className="text-xs text-text-muted">
              Planning makes one model call. AURA only has an executable codebase for the checkout scenario; other objectives get an analysis plan with no code changes. <ActionFacts model approval />
            </span>
          </div>
        </form>
      )}

      {needsYou.length > 0 && (
        <section aria-label="Needs your decision" className="mb-5 rounded-lg border border-warning/35 bg-warning/[0.04]">
          <div className="border-b border-warning/20 px-4 py-2 text-sm font-medium text-warning">Waiting on you</div>
          <ul className="divide-y divide-warning/15">
            {needsYou.map((m) => (
              <li key={m.id}>
                <Link href={`/app/${id}/missions/${m.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-bg-hover">
                  <span className="min-w-0 flex-1 truncate">{m.title}</span>
                  <span className="text-xs text-text-muted">{m.status === "AWAITING_APPROVAL" ? "Plan needs review" : "Change needs approval"}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && !data ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : loading && !data ? (
        <div className="space-y-1">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No missions yet"
          description="Start with the example mission: it runs the real engine end to end against a small checkout module and stops for your approval. Or describe your own objective."
          action={<button onClick={runExample} disabled={busy} className="btn-primary"><PlayCircle className="h-3.5 w-3.5" /> Run example mission</button>}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="table min-w-[760px]">
            <thead className="bg-bg-raised">
              <tr><th>Mission</th><th>Status</th><th>Tasks</th><th>Origin</th><th className="text-right">Est. cost</th><th>Created</th></tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id} data-interactive="true" onClick={() => router.push(`/app/${id}/missions/${m.id}`)}>
                  <td className="max-w-[420px]">
                    <Link href={`/app/${id}/missions/${m.id}`} className="block truncate font-medium text-text" onClick={(e) => e.stopPropagation()}>{m.title}</Link>
                    <span className="block truncate text-xs text-text-muted" title={m.statusReason}>{m.statusReason || m.statusHelp}</span>
                  </td>
                  <td><span title={m.statusHelp}><StatusBadge status={m.status} /></span></td>
                  <td className="mono text-xs text-text-muted">
                    {m.progress.total ? `${m.progress.done}/${m.progress.total}` : "—"}
                    {m.progress.failed > 0 && <span className="ml-1 text-danger">· {m.progress.failed} failed</span>}
                  </td>
                  <td>
                    <Badge>{m.source === "SEEDED" && <Lock className="h-2.5 w-2.5" />}{SOURCE_LABEL[m.source]}</Badge>
                  </td>
                  <td className="mono text-right text-xs text-text-muted">${m.costUsd.toFixed(4)}</td>
                  <td className="mono text-xs text-text-faint">{timeAgo(m.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="mt-8" aria-label="Agent scorecards">
        <h2 className="section-title mb-1">Agent scorecards — mission evidence</h2>
        <p className="mb-3 max-w-2xl text-xs text-text-muted">Computed from recorded task attempts in your missions. Hover a metric for its definition and denominator. Running, cancelled and abandoned attempts are excluded.</p>
        <MissionScorecards companyId={id} />
      </section>
    </div>
  );
}
