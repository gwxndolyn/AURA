"use client";

import { CheckCircle2, Circle, Loader2, PauseCircle, XCircle, MinusCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MissionTask } from "./types";

const ICON: Record<string, { Icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  PENDING: { Icon: Circle, cls: "text-text-faint" },
  READY: { Icon: Circle, cls: "text-info" },
  RUNNING: { Icon: Loader2, cls: "animate-spin text-brand" },
  WAITING_APPROVAL: { Icon: PauseCircle, cls: "text-warning" },
  SUCCEEDED: { Icon: CheckCircle2, cls: "text-success" },
  FAILED: { Icon: XCircle, cls: "text-danger" },
  SKIPPED: { Icon: MinusCircle, cls: "text-text-faint" },
};

const VERIFY_LABEL: Record<string, string> = { PASSED: "verified", FAILED: "verification failed", UNVERIFIED: "unverified" };

/**
 * Dependency plan laid out in columns (levels): every task in a column only
 * depends on tasks in earlier columns, so tasks in one column could run in parallel.
 */
export function PlanGraph({ tasks, levels, selected, onSelect }: { tasks: MissionTask[]; levels: string[][]; selected: string | null; onSelect: (key: string) => void }) {
  const by = Object.fromEntries(tasks.map((t) => [t.key, t]));
  return (
    <div className="overflow-x-auto pb-1">
      <ol className="flex min-w-max gap-2" aria-label="Task plan by dependency level">
        {levels.map((col, i) => (
          <li key={i} className="flex w-44 flex-col gap-2">
            <span className="mono text-2xs text-text-faint">step {i + 1}</span>
            {col.map((k) => {
              const t = by[k];
              if (!t) return null;
              const { Icon, cls } = ICON[t.status] ?? ICON.PENDING;
              return (
                <button
                  key={k}
                  onClick={() => onSelect(k)}
                  aria-pressed={selected === k}
                  data-task={k}
                  data-status={t.status}
                  className={cn(
                    "rounded-md border bg-bg-raised px-2.5 py-2 text-left transition-colors hover:border-border-strong",
                    selected === k ? "border-brand/60" : "border-border",
                    t.status === "WAITING_APPROVAL" && "border-warning/50",
                    t.status === "FAILED" && "border-danger/40",
                  )}
                >
                  <span className="flex items-start gap-1.5">
                    <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", cls)} />
                    <span className="min-w-0 text-sm leading-snug text-text">{t.title}</span>
                  </span>
                  <span className="mono mt-1 flex flex-wrap gap-x-2 pl-5 text-2xs text-text-faint">
                    <span>{t.agentKey}</span>
                    <span>{t.status.replace(/_/g, " ").toLowerCase()}</span>
                    {t.attempts > 1 && <span>attempt {t.attempts}/{t.maxAttempts}</span>}
                    {VERIFY_LABEL[t.verification] && <span className={t.verification === "PASSED" ? "text-success" : t.verification === "FAILED" ? "text-danger" : "text-warning"}>{VERIFY_LABEL[t.verification]}</span>}
                  </span>
                  {t.dependsOn.length > 0 && <span className="mono mt-1 block pl-5 text-2xs text-text-faint">after {t.dependsOn.join(", ")}</span>}
                </button>
              );
            })}
          </li>
        ))}
      </ol>
    </div>
  );
}
