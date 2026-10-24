"use client";

/**
 * Inspector panels for the office: one agent (role, capabilities from the
 * real registry, current task/work, recent activity, links to evidence) or one
 * area (what happens there + who is there). Pure presentation.
 */
import Link from "next/link";
import { ArrowUpRight, X } from "lucide-react";
import { capabilityFor } from "@/lib/agents/capabilities";
import { LOCATION_BY_ID, type LocationId } from "@/lib/office/layout";
import { ACTIVITY_LABEL, type VisualAgent } from "@/lib/office/state";
import { PixelAvatar, ACTIVITY_DOT } from "./office-2d";
import { cn, timeAgo } from "@/lib/utils";

export interface ActivityLine {
  text: string;
  at?: string;
  href?: string;
  tone?: "ok" | "bad" | "neutral";
  demo?: boolean;
}

export function AgentInspector({ agent, activity, base, onClose, demo }: { agent: VisualAgent; activity: ActivityLine[]; base?: string; onClose: () => void; demo?: boolean }) {
  const cap = capabilityFor(agent.key);
  const loc = LOCATION_BY_ID[agent.location];
  return (
    <section className="space-y-3 text-sm" aria-label={`${agent.name} details`} data-testid="agent-inspector">
      <header className="flex items-start gap-3">
        <PixelAvatar agentKey={agent.key} size={40} className="rounded-md bg-[#2a221c] p-1" />
        <div className="min-w-0 flex-1">
          <h3 className="font-medium leading-tight">{agent.name}</h3>
          <p className="text-xs text-text-muted">{agent.role}</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs">
            <span className={cn("h-2 w-2 rounded-full", ACTIVITY_DOT[agent.activity])} />
            <span className="font-medium">{ACTIVITY_LABEL[agent.activity]}</span>
            <span className="text-text-faint">· {loc.label}</span>
            {demo && <span className="mono ml-1 rounded bg-warning/15 px-1 text-[10px] text-warning">demo</span>}
          </p>
        </div>
        <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="Close details"><X className="h-3.5 w-3.5" /></button>
      </header>

      <div>
        <div className="metric-label mb-1">Now</div>
        <p className="text-xs leading-relaxed">{agent.label || "No assigned work"}</p>
        {agent.task && (
          <div className="mt-1.5 rounded-md border border-border bg-bg-inset px-2 py-1.5 text-xs">
            <div className="flex items-center gap-2"><span className="mono text-text-faint">{agent.task.kind}</span><span className="mono text-text-faint">· {agent.task.status.toLowerCase()}</span>{agent.task.verification && agent.task.verification !== "NONE" && <span className="mono text-text-faint">· verification {agent.task.verification.toLowerCase()}</span>}</div>
            <div className="mt-0.5">{agent.task.title}</div>
            {base && agent.task.missionId !== "demo" && <Link className="mt-1 inline-flex items-center gap-1 text-brand-glow hover:underline" href={`${base}/missions/${agent.task.missionId}`}>Open mission: {agent.task.missionTitle} <ArrowUpRight className="h-3 w-3" /></Link>}
          </div>
        )}
        {agent.work && (
          <div className="mt-1.5 rounded-md border border-border bg-bg-inset px-2 py-1.5 text-xs">
            <div className="mono text-text-faint">{agent.work.itemKind} · {agent.work.status.toLowerCase()}</div>
            <div className="mt-0.5">{agent.work.title}</div>
            {base && <Link className="mt-1 inline-flex items-center gap-1 text-brand-glow hover:underline" href={`${base}/products/${agent.work.productId}`}>Open product: {agent.work.productTitle} <ArrowUpRight className="h-3 w-3" /></Link>}
          </div>
        )}
        {agent.queued > 0 && <p className="mt-1 text-2xs text-text-muted">{agent.queued} more task{agent.queued === 1 ? "" : "s"} waiting on dependencies or approval.</p>}
        {agent.stale && <p className="mt-1 text-2xs text-warning">The worker holding this task stopped renewing its lease. It will be recovered by the next advance.</p>}
        {agent.interactionWith.length > 0 && <p className="mt-1 text-2xs text-text-muted">Working with: {agent.interactionWith.join(", ")}</p>}
      </div>

      <div>
        <div className="metric-label mb-1">Recent activity</div>
        {activity.length === 0 ? (
          <p className="text-xs text-text-muted">No recorded activity yet.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {activity.slice(0, 6).map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", a.tone === "bad" ? "bg-danger" : a.tone === "ok" ? "bg-success" : "bg-text-faint")} />
                <span className="min-w-0 flex-1">{a.href ? <Link href={a.href} className="hover:underline">{a.text}</Link> : a.text}</span>
                {a.at && <span className="shrink-0 text-text-faint">{timeAgo(a.at)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {cap ? (
        <div>
          <div className="metric-label mb-1">Capabilities (from the registry)</div>
          <p className="text-xs text-text-muted">{cap.description}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {cap.taskKinds.map((k) => <span key={k} className="mono rounded border border-border px-1 text-[10px] text-text-muted">{k}</span>)}
          </div>
          <p className="mono mt-1.5 text-[10px] text-text-faint">tools: {cap.tools.length ? cap.tools.join(", ") : "none"} · {cap.canWriteCode ? "may write code in its task's scope" : "cannot write code"}</p>
        </div>
      ) : (
        <p className="text-xs text-text-muted">This role has no mission capabilities registered; it does not execute mission tasks.</p>
      )}
      <p className="text-[10px] leading-relaxed text-text-faint">Every AURA role runs on the same orchestrator and model client with its own prompt, capability entry and tool allowlist. Permissions are enforced in code, not by the prompt.</p>
    </section>
  );
}

export function LocationInspector({ id, agents, onSelectAgent, onClose, extra }: { id: LocationId; agents: VisualAgent[]; onSelectAgent: (k: string) => void; onClose: () => void; extra?: React.ReactNode }) {
  const l = LOCATION_BY_ID[id];
  const here = agents.filter((a) => a.location === id);
  return (
    <section className="space-y-3 text-sm" aria-label={`${l.label} details`} data-testid="location-inspector">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{l.label}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{l.concept}</p>
        </div>
        <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="Close details"><X className="h-3.5 w-3.5" /></button>
      </header>
      {(l.taskKinds.length > 0 || l.records.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {l.taskKinds.map((k) => <span key={k} className="mono rounded border border-border px-1 text-[10px] text-text-muted">{k}</span>)}
          {l.records.map((k) => <span key={k} className="rounded bg-bg-elevated px-1 text-[10px] text-text-muted">{k}</span>)}
        </div>
      )}
      <div>
        <div className="metric-label mb-1">Here now ({here.length})</div>
        {here.length === 0 ? <p className="text-xs text-text-muted">Nobody is working here right now.</p> : (
          <ul className="space-y-1">
            {here.map((a) => (
              <li key={a.key}>
                <button onClick={() => onSelectAgent(a.key)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-bg-hover">
                  <PixelAvatar agentKey={a.key} size={20} />
                  <span className="font-medium">{a.name}</span>
                  <span className="text-text-faint">{ACTIVITY_LABEL[a.activity]}</span>
                  <span className="ml-auto truncate text-text-muted">{a.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {extra}
    </section>
  );
}
