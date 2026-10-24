"use client";

import { use, useEffect, useState } from "react";
import { FolderKanban, Loader2, Play, LayoutGrid, Rows3 } from "lucide-react";
import { useQuery, useMutation } from "@/hooks/useApi";
import { StatusBadge, StatusDot, AgentAvatar, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui/primitives";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { useApp } from "@/lib/store";
import { cn, timeAgo } from "@/lib/utils";

interface Task {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  estimate: number;
  attempts?: number;
  createdAt: string;
  assignee: { name: string; key: string; color: string; avatar: string } | null;
}

const COLUMNS = ["BACKLOG", "PLANNED", "IN_PROGRESS", "TESTING", "REVIEW", "BLOCKED", "DONE"] as const;
const RUNNABLE = ["BACKLOG", "PLANNED", "REVIEW"];
const PRIORITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export default function WorkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: tasks, loading, error, refetch } = useQuery<Task[]>(`/api/companies/${id}/tasks`, 5000);
  const { version } = useLiveEvents(id);
  const { mutate } = useMutation();
  const { toast } = useApp();
  const [goal, setGoal] = useState("");
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [view, setView] = useState<"board" | "list">("board");

  useEffect(() => {
    if (version > 0) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  async function plan(e?: React.FormEvent) {
    e?.preventDefault();
    if (goal.trim().length < 3) return;
    setPlanning(true);
    try {
      await mutate(`/api/companies/${id}/plan`, { goal });
      setGoal("");
      refetch();
      toast({ title: "Backlog created", description: "The product manager broke the goal into tasks.", level: "success" });
    } catch (err) {
      toast({ title: "Planning failed", description: (err as Error).message, level: "danger" });
    } finally {
      setPlanning(false);
    }
  }

  async function execute(t: Task) {
    setRunning(t.id);
    try {
      await mutate(`/api/companies/${id}/tasks/${t.id}/execute`);
      refetch();
      toast({ title: "Task run finished", description: t.title, level: "success" });
    } catch (err) {
      toast({ title: "Task run failed", description: (err as Error).message, level: "danger" });
    } finally {
      setRunning(null);
    }
  }

  const byStatus = (s: string) => (tasks ?? []).filter((t) => t.status === s).sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));
  const columns = COLUMNS.filter((c) => c !== "BLOCKED" || byStatus(c).length > 0);

  return (
    <div className="page">
      <PageHeader
        title="Work"
        description="Describe a goal; the product manager turns it into prioritized tasks that agents execute through the test gate."
        actions={
          <div className="segmented" role="group" aria-label="View">
            <button data-active={view === "board"} onClick={() => setView("board")} aria-label="Board view"><LayoutGrid className="h-3 w-3" /></button>
            <button data-active={view === "list"} onClick={() => setView("list")} aria-label="List view"><Rows3 className="h-3 w-3" /></button>
          </div>
        }
      />

      <form onSubmit={plan} className="mb-5 flex gap-2">
        <label htmlFor="goal" className="sr-only">Goal</label>
        <input id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Goal, e.g. “Add rate limiting to the public API”" className="input h-9" />
        <button type="submit" disabled={planning || goal.trim().length < 3} className="btn-primary h-9 shrink-0">
          {planning && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {planning ? "Planning…" : "Create plan"}
        </button>
      </form>

      {error && !tasks ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : loading && !tasks ? (
        <Skeleton className="h-80" />
      ) : !tasks || tasks.length === 0 ? (
        <EmptyState icon={FolderKanban} title="No tasks yet" description="Enter a goal above. Each task gets an owner, priority and acceptance criteria; coding tasks are verified by running their tests." />
      ) : view === "board" ? (
        <div className="-mx-4 overflow-x-auto px-4 md:-mx-6 md:px-6">
          <div className="grid min-w-[1080px] gap-3" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
            {columns.map((col) => {
              const list = byStatus(col);
              return (
                <section key={col} aria-label={col} className="min-w-0">
                  <div className="mb-2 flex h-6 items-center justify-between border-b border-border pb-1.5">
                    <StatusDot status={col} />
                    <span className="mono text-2xs text-text-faint">{list.length}</span>
                  </div>
                  <ul className="space-y-1.5">
                    {list.map((t) => (
                      <li key={t.id} className="group rounded-md border border-border bg-bg-raised p-2.5 transition-colors hover:border-border-strong">
                        <p className="text-sm leading-snug text-text">{t.title}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <StatusBadge status={t.priority} />
                          {(t.attempts ?? 0) > 1 && <span className="mono text-2xs text-warning" title="Repair attempts">×{t.attempts}</span>}
                          <span className="ml-auto flex min-w-0 items-center gap-1.5">
                            {t.assignee ? (
                              <>
                                <AgentAvatar avatar={t.assignee.avatar} color={t.assignee.color} size={16} />
                                <span className="truncate text-xs text-text-muted">{t.assignee.name}</span>
                              </>
                            ) : (
                              <span className="text-xs text-text-faint">unassigned</span>
                            )}
                          </span>
                        </div>
                        {RUNNABLE.includes(t.status) && (
                          <button onClick={() => execute(t)} disabled={running !== null} className="btn-secondary btn-sm mt-2 w-full opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                            {running === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                            {running === t.id ? "Running…" : "Run task"}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="table min-w-[760px]">
            <thead className="bg-bg-raised">
              <tr><th>Task</th><th>Status</th><th>Priority</th><th>Owner</th><th className="text-right">Est.</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {[...tasks].sort((a, b) => COLUMNS.indexOf(a.status as (typeof COLUMNS)[number]) - COLUMNS.indexOf(b.status as (typeof COLUMNS)[number]) || (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)).map((t) => (
                <tr key={t.id}>
                  <td className="max-w-[360px]"><div className="truncate">{t.title}</div><div className="truncate text-xs text-text-faint">{t.description}</div></td>
                  <td><StatusDot status={t.status} /></td>
                  <td><StatusBadge status={t.priority} /></td>
                  <td className="text-xs text-text-muted">{t.assignee?.name ?? "—"}</td>
                  <td className="mono text-right text-text-muted">{t.estimate}</td>
                  <td className="mono text-xs text-text-faint">{timeAgo(t.createdAt)}</td>
                  <td className="text-right">
                    {RUNNABLE.includes(t.status) && (
                      <button onClick={() => execute(t)} disabled={running !== null} className={cn("btn-ghost btn-sm")}>
                        {running === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
