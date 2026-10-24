"use client";

import { useState } from "react";
import type { LiveEvent } from "@/lib/types";
import { getAgentDef } from "@/lib/agents/definitions";
import { cn } from "@/lib/utils";

const LEVEL_DOT: Record<string, string> = {
  info: "bg-text-faint",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};
const LEVEL_TEXT: Record<string, string> = {
  info: "text-text-muted",
  success: "text-text",
  warning: "text-warning",
  danger: "text-danger",
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * Event log. Monospaced timestamps, actor, event type, message. Rows expand in
 * place to show metadata. Data comes from the persisted event stream (SSE).
 */
export function ActivityFeed({
  events,
  connected,
  max = 60,
  title = "Event log",
  filterable = true,
  className,
}: {
  events: LiveEvent[];
  connected?: boolean;
  max?: number;
  title?: string;
  filterable?: boolean;
  className?: string;
  onSelect?: (e: LiveEvent) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [level, setLevel] = useState<"all" | "warning" | "danger">("all");
  const shown = events.filter((e) => level === "all" || (level === "danger" ? e.level === "danger" : e.level === "warning" || e.level === "danger")).slice(0, max);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex items-center gap-2">
          <h3 className="section-title">{title}</h3>
          <span className="inline-flex items-center gap-1 text-2xs text-text-faint" title={connected ? "Connected to the live event stream" : "Not connected"}>
            <span className={cn("dot", connected ? "animate-live-dot bg-success" : "bg-text-faint")} />
            <span className="mono">{connected ? "live" : "offline"}</span>
          </span>
        </div>
        {filterable && (
          <div className="segmented" role="group" aria-label="Filter by severity">
            {(["all", "warning", "danger"] as const).map((l) => (
              <button key={l} data-active={level === l} onClick={() => setLevel(l)}>
                {l === "all" ? "all" : l === "warning" ? "warn+" : "errors"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-sm text-text-muted">
            {events.length === 0 ? "No events yet. Events appear here as agents plan, build, test and deploy." : "No events at this severity."}
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {shown.map((e) => {
              const def = e.actor ? getAgentDef(e.actor) : undefined;
              const expanded = open === e.id;
              return (
                <li key={e.id}>
                  <button
                    onClick={() => setOpen(expanded ? null : e.id)}
                    aria-expanded={expanded}
                    className="grid w-full grid-cols-[64px_8px_minmax(0,88px)_1fr] items-baseline gap-x-2 px-3 py-1.5 text-left transition-colors hover:bg-bg-elevated"
                  >
                    <span className="mono text-2xs text-text-faint">{fmtTime(e.createdAt)}</span>
                    <span className={cn("dot translate-y-[-1px]", LEVEL_DOT[e.level])} aria-label={e.level} />
                    <span className="truncate text-xs text-text-muted">{e.actorName ?? def?.name ?? "system"}</span>
                    <span className={cn("truncate text-xs", LEVEL_TEXT[e.level])}>{e.message}</span>
                  </button>
                  {expanded && (
                    <div className="well mx-3 mb-2 px-2.5 py-2">
                      <div className="mono grid grid-cols-[80px_1fr] gap-y-0.5 text-2xs">
                        <span className="text-text-faint">type</span>
                        <span className="text-text-muted">{e.type}</span>
                        {e.role && (
                          <>
                            <span className="text-text-faint">role</span>
                            <span className="text-text-muted">{e.role}</span>
                          </>
                        )}
                        <span className="text-text-faint">time</span>
                        <span className="text-text-muted">{new Date(e.createdAt).toISOString()}</span>
                        <span className="text-text-faint">message</span>
                        <span className="whitespace-pre-wrap break-words text-text">{e.message}</span>
                        {e.meta && Object.keys(e.meta).length > 0 && (
                          <>
                            <span className="text-text-faint">meta</span>
                            <pre className="overflow-x-auto whitespace-pre-wrap break-all text-text-muted">{JSON.stringify(e.meta, null, 2)}</pre>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
