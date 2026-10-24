"use client";

/**
 * 2D office: the accessible fallback when WebGL is unavailable, and the
 * intentional small-screen office. Same VisualAgent[] input as the 3D scene,
 * fully keyboard operable (every agent and area is a real button).
 */
import { LOCATIONS, type LocationId } from "@/lib/office/layout";
import { ACTIVITY_LABEL, type VisualAgent } from "@/lib/office/state";
import { characterFor, pixelSprite } from "@/lib/office/characters";
import { cn } from "@/lib/utils";

export const ACTIVITY_DOT: Record<string, string> = {
  idle: "bg-text-faint",
  planning: "bg-[#b79cf0]",
  designing: "bg-[#f472b6]",
  coding: "bg-brand",
  reviewing: "bg-info",
  testing: "bg-success",
  blocked: "bg-danger",
  awaiting_approval: "bg-warning",
  completed: "bg-success",
};

export function PixelAvatar({ agentKey, size = 30, className }: { agentKey: string; size?: number; className?: string }) {
  const g = pixelSprite(characterFor(agentKey));
  return (
    <svg viewBox="0 0 10 10" width={size} height={size} className={cn("shrink-0 [image-rendering:pixelated]", className)} aria-hidden shapeRendering="crispEdges">
      {g.flatMap((row, y) => row.map((c, x) => (c ? <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={c} /> : null)))}
    </svg>
  );
}

const ORDER: LocationId[] = ["planning", "design", "engineering", "qa", "collaboration", "security", "deploy", "lounge"];

export function Office2D({ agents, selected, selectedLocation, onSelect, onSelectLocation, compact }: {
  agents: VisualAgent[];
  selected: string | null;
  selectedLocation: LocationId | null;
  onSelect: (key: string | null) => void;
  onSelectLocation: (id: LocationId) => void;
  compact?: boolean;
}) {
  return (
    <div className={cn("grid gap-2 p-2", compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-4")} data-testid="office-2d" role="list" aria-label="Office areas">
      {ORDER.map((id) => {
        const l = LOCATIONS.find((x) => x.id === id)!;
        const here = agents.filter((a) => a.location === id);
        return (
          <div key={id} role="listitem" className={cn("rounded-md border bg-[#1a1613] p-2 transition-colors", selectedLocation === id ? "border-brand/60" : "border-[#3a2f27]")} data-location={id}>
            <button onClick={() => onSelectLocation(id)} className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-[#f1e6d6] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 rounded" aria-label={`${l.label}: ${here.length} agent${here.length === 1 ? "" : "s"}`}>
              <span className="truncate">{l.label}</span>
              <span className="mono text-2xs text-[#a8957f]">{here.length}</span>
            </button>
            <ul className="mt-2 flex min-h-[40px] flex-wrap gap-1.5">
              {here.map((a) => (
                <li key={a.key}>
                  <button
                    onClick={() => onSelect(selected === a.key ? null : a.key)}
                    aria-pressed={selected === a.key}
                    aria-label={`${a.name}, ${a.role}: ${ACTIVITY_LABEL[a.activity]}`}
                    data-agent={a.key}
                    data-activity={a.activity}
                    className={cn("group relative flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70", selected === a.key ? "border-brand bg-brand/10" : "border-[#3a2f27] bg-[#241e19] hover:border-[#5a4a3c]")}
                  >
                    <PixelAvatar agentKey={a.key} size={compact ? 22 : 26} />
                    <span className="min-w-0">
                      <span className="block text-2xs font-medium leading-tight text-[#f1e6d6]">{a.name}</span>
                      <span className="flex items-center gap-1 text-[10px] leading-tight text-[#a8957f]"><span className={cn("h-1.5 w-1.5 rounded-full", ACTIVITY_DOT[a.activity])} />{ACTIVITY_LABEL[a.activity]}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
