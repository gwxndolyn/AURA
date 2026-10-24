"use client";

import { use, useState } from "react";
import { GitBranch, Loader2 } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { EmptyState, ErrorState, Skeleton, PageHeader } from "@/components/ui/primitives";
import { cn, timeAgo, parseJSON } from "@/lib/utils";
import { useApp } from "@/lib/store";

interface Decision {
  id: string;
  question: string;
  options: string;
  evidence: string;
  consulted: string;
  choice: string | null;
  rationale: string | null;
  status: string;
  createdAt: string;
}

/** Decision log: question, options considered, choice, rationale, evidence. */
export default function DecisionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, loading, error, refetch } = useQuery<Decision[]>(`/api/companies/${id}/decisions`, 6000);
  const { mutate, loading: deciding } = useMutation();
  const { toast } = useApp();
  const [q, setQ] = useState("");

  async function decide(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim().length < 3) return;
    try {
      await mutate(`/api/companies/${id}/decisions`, { question: q });
      setQ("");
      refetch();
      toast({ title: "Decision recorded", level: "success" });
    } catch (err) {
      toast({ title: "Decision failed", description: (err as Error).message, level: "danger" });
    }
  }

  return (
    <div className="page max-w-[1080px]">
      <PageHeader title="Decisions" description="Strategic questions resolved by the CEO agent from current company state. Each record keeps the options, evidence and agents consulted." />

      <form onSubmit={decide} className="mb-6 flex gap-2">
        <label htmlFor="q" className="sr-only">Question</label>
        <input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Question, e.g. “Delay launch to close the open high-severity finding?”" className="input h-9" />
        <button type="submit" disabled={deciding || q.trim().length < 3} className="btn-primary h-9 shrink-0">
          {deciding && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {deciding ? "Deciding…" : "Request decision"}
        </button>
      </form>

      {error && !data ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : loading && !data ? (
        <div className="space-y-3">{[...Array(2)].map((_, i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : !data || data.length === 0 ? (
        <EmptyState icon={GitBranch} title="No decisions recorded" description="Ask a question above; agent conflicts resolved during workflows are also recorded here." />
      ) : (
        <ol className="divide-y divide-border border-y border-border">
          {data.map((d) => {
            const options = parseJSON<{ label: string; pros?: string[]; cons?: string[] }[]>(d.options, []);
            const evidence = parseJSON<string[]>(d.evidence, []);
            const consulted = parseJSON<string[]>(d.consulted, []);
            return (
              <li key={d.id} className="grid gap-x-6 gap-y-3 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <div className="min-w-0">
                  <div className="mono text-2xs text-text-faint">{timeAgo(d.createdAt)} · {d.status.toLowerCase()}</div>
                  <h3 className="mt-1 text-base font-medium leading-snug">{d.question}</h3>
                  {d.choice && (
                    <div className="mt-2 text-sm">
                      <span className="text-text-faint">Decision </span>
                      <span className="text-text">{d.choice}</span>
                    </div>
                  )}
                  {d.rationale && <p className="mt-2 text-sm text-text-muted">{d.rationale}</p>}
                  {consulted.length > 0 && <div className="mt-2 text-xs text-text-faint">Consulted: {consulted.join(", ")}</div>}
                </div>
                <div className="min-w-0 space-y-2">
                  {options.map((o) => {
                    const chosen = d.choice === o.label;
                    return (
                      <div key={o.label} className={cn("rounded-md border px-3 py-2", chosen ? "border-border-strong bg-bg-elevated" : "border-border-subtle")}>
                        <div className="flex items-center gap-2 text-sm">
                          <span className={chosen ? "text-text" : "text-text-muted"}>{o.label}</span>
                          {chosen && <span className="chip border border-success/30 text-success">chosen</span>}
                        </div>
                        {(o.pros?.length || o.cons?.length) && (
                          <div className="mt-1 grid gap-0.5 text-xs">
                            {o.pros?.map((p) => <span key={p} className="text-text-muted"><span className="text-success">+</span> {p}</span>)}
                            {o.cons?.map((c) => <span key={c} className="text-text-muted"><span className="text-danger">−</span> {c}</span>)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {evidence.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {evidence.map((e, i) => <span key={i} className="chip border border-border text-text-muted">{e}</span>)}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
