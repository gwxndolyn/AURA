"use client";

import { cn } from "@/lib/utils";

export interface DeptSummary {
  key: "product" | "engineering" | "qa" | "infra" | "security";
  label: string;
  agents: { key: string; name: string; status: string; available: boolean }[];
  signals: { agents: number; busy: number; queued: number; running: number; blocked: number; recentFailures: number };
}

// Fixed layout: work flows product → engineering → QA → infra; security spans the delivery path.
const LAYOUT: Record<DeptSummary["key"], { x: number; y: number; w: number; h: number }> = {
  product: { x: 20, y: 30, w: 200, h: 120 },
  engineering: { x: 260, y: 30, w: 220, h: 120 },
  qa: { x: 520, y: 30, w: 200, h: 120 },
  infra: { x: 760, y: 30, w: 200, h: 120 },
  security: { x: 260, y: 190, w: 700, h: 80 },
};
const FLOWS: [DeptSummary["key"], DeptSummary["key"]][] = [["product", "engineering"], ["engineering", "qa"], ["qa", "infra"]];

function tone(s: DeptSummary["signals"]) {
  if (s.recentFailures > 0) return { stroke: "#ef5d5d", label: `${s.recentFailures} recent failure(s)` };
  if (s.blocked > 0) return { stroke: "#e5a13b", label: `${s.blocked} waiting on approval` };
  if (s.running > 0 || s.busy > 0) return { stroke: "#c5f04a", label: "active" };
  return { stroke: "#303035", label: "idle" };
}

/**
 * 2D operations map. Every number on it comes from real rows (agents,
 * mission tasks, task runs). Areas are buttons (keyboard accessible); the
 * selected area opens its details panel.
 */
export function OpsMap({ departments, selected, onSelect }: { departments: DeptSummary[]; selected: string | null; onSelect: (k: DeptSummary["key"]) => void }) {
  const by = Object.fromEntries(departments.map((d) => [d.key, d])) as Record<DeptSummary["key"], DeptSummary>;
  return (
    <div className="overflow-x-auto" data-testid="ops-map">
      <svg viewBox="0 0 980 290" className="min-w-[720px]" role="group" aria-label="Company operations map">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#303035" />
          </marker>
        </defs>
        {FLOWS.map(([a, b]) => {
          const A = LAYOUT[a], B = LAYOUT[b];
          return <line key={`${a}-${b}`} x1={A.x + A.w} y1={A.y + A.h / 2} x2={B.x - 4} y2={B.y + B.h / 2} stroke="#303035" strokeWidth={1.5} markerEnd="url(#arrow)" />;
        })}
        {(Object.keys(LAYOUT) as DeptSummary["key"][]).map((k) => {
          const L = LAYOUT[k];
          const d = by[k];
          if (!d) return null;
          const t = tone(d.signals);
          const sel = selected === k;
          return (
            <g
              key={k}
              role="button"
              tabIndex={0}
              aria-pressed={sel}
              aria-label={`${d.label}: ${d.signals.agents} agents, ${d.signals.running} running, ${d.signals.queued} queued, ${d.signals.blocked} blocked, ${t.label}`}
              data-dept={k}
              onClick={() => onSelect(k)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(k))}
              className="cursor-pointer outline-none [&:focus-visible>rect:first-child]:stroke-[#c5f04a]"
            >
              <rect x={L.x} y={L.y} width={L.w} height={L.h} rx={6} fill={sel ? "#18181b" : "#111113"} stroke={sel ? "#c5f04a" : t.stroke} strokeWidth={sel ? 1.5 : 1} />
              <text x={L.x + 12} y={L.y + 22} fill="#ecebe6" fontSize={13} fontWeight={600}>{d.label}</text>
              <text x={L.x + 12} y={L.y + 40} fill="#6e6d68" fontSize={10} fontFamily="var(--font-mono)">{t.label}</text>
              {/* agent dots: lit when the agent's real status is THINKING/WORKING */}
              {d.agents.slice(0, 6).map((a, i) => (
                <g key={a.key}>
                  <circle cx={L.x + 18 + i * 22} cy={L.y + (k === "security" ? 58 : 64)} r={6} fill={["THINKING", "WORKING"].includes(a.status) ? "#c5f04a" : a.available ? "#303035" : "#ef5d5d55"} stroke="#0b0b0c" strokeWidth={2}>
                    <title>{`${a.name} (${a.key}) — ${a.status.toLowerCase()}${a.available ? "" : ", unavailable"}`}</title>
                  </circle>
                </g>
              ))}
              {k !== "security" && (
                <g fontFamily="var(--font-mono)" fontSize={10}>
                  <text x={L.x + 12} y={L.y + 96} fill="#a3a29c">{`${d.signals.running} running · ${d.signals.queued} queued`}</text>
                  <text x={L.x + 12} y={L.y + 110} fill={d.signals.blocked ? "#e5a13b" : "#6e6d68"}>{`${d.signals.blocked} blocked · ${d.signals.recentFailures} failed (7d)`}</text>
                </g>
              )}
              {k === "security" && <text x={L.x + 160} y={L.y + 62} fill="#a3a29c" fontSize={10} fontFamily="var(--font-mono)">{`${d.signals.running} running · ${d.signals.blocked} blocked · ${d.signals.recentFailures} failed (7d)`}</text>}
            </g>
          );
        })}
      </svg>
      <p className={cn("mono mt-1 text-2xs text-text-faint")}>Operational data: agents, mission tasks and task runs from this workspace (sample missions excluded). Lit dots = agents currently working.</p>
    </div>
  );
}
