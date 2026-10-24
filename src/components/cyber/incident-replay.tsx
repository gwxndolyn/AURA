"use client";

import { useEffect, useState } from "react";
import { X, Play, Pause, RotateCcw } from "lucide-react";
import { getAgentDef } from "@/lib/agents/definitions";
import { cn } from "@/lib/utils";

interface TL {
  ts: string;
  actor: string;
  message: string;
}

const SPEEDS = [1, 2, 5];

/**
 * Step-through replay of a recorded incident timeline. Uses only the persisted
 * timeline entries; it does not invent phases that were not recorded.
 */
export function IncidentReplay({
  incident,
  timeline,
  onClose,
}: {
  incident: { number: number; title: string; attackType: string | null; target: string | null; severity: string };
  timeline: TL[];
  onClose: () => void;
}) {
  const [step, setStep] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setStep((s) => Math.min(s + 1, timeline.length));
      if (e.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, timeline.length]);

  useEffect(() => {
    if (!playing) return;
    if (step >= timeline.length) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => s + 1), 900 / speed);
    return () => clearTimeout(t);
  }, [playing, step, speed, timeline.length]);

  const t0 = timeline[0] ? new Date(timeline[0].ts).getTime() : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`Replay of incident ${incident.number}`}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-2xl animate-fade-in rounded-lg border border-border-strong bg-bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.6)]">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="mono text-2xs text-text-faint">INC-{incident.number} · replay · simulated</div>
            <h3 className="mt-0.5 text-base font-medium">{incident.title}</h3>
            <div className="mono mt-0.5 text-xs text-text-muted">{incident.attackType ?? "unknown vector"} → {incident.target ?? "unknown target"}</div>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <ol className="max-h-[50vh] overflow-y-auto px-4 py-3">
          {timeline.map((t, i) => {
            const shown = i < step;
            const def = getAgentDef(t.actor.toLowerCase());
            return (
              <li key={i} className={cn("relative grid grid-cols-[64px_16px_1fr] gap-x-2 pb-3 transition-opacity", !shown && "opacity-25")}>
                <span className="mono pt-px text-2xs text-text-faint">+{Math.max(0, Math.round((new Date(t.ts).getTime() - t0) / 1000))}s</span>
                <span className="relative flex justify-center">
                  <span className={cn("dot mt-1.5", i === step - 1 ? "bg-brand" : "bg-text-faint")} />
                  {i < timeline.length - 1 && <span className="absolute top-4 h-[calc(100%-4px)] w-px bg-border" />}
                </span>
                <div className="min-w-0">
                  <span className="text-xs font-medium text-text">{t.actor}</span>
                  {def && <span className="ml-1.5 text-2xs text-text-faint">{def.role}</span>}
                  <p className="text-sm text-text-muted">{t.message}</p>
                </div>
              </li>
            );
          })}
          {timeline.length === 0 && <li className="text-sm text-text-muted">No timeline entries were recorded for this incident.</li>}
        </ol>

        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <button onClick={() => { setStep(1); setPlaying(false); }} className="btn-ghost btn-sm" aria-label="Restart">
            <RotateCcw className="h-3 w-3" />
          </button>
          <button onClick={() => { if (step >= timeline.length) setStep(1); setPlaying((p) => !p); }} className="btn-secondary btn-sm" disabled={timeline.length === 0}>
            {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />} {playing ? "Pause" : "Play"}
          </button>
          <div className="segmented" role="group" aria-label="Speed">
            {SPEEDS.map((s) => <button key={s} data-active={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
          </div>
          <span className="mono ml-auto text-2xs text-text-faint">step {Math.min(step, timeline.length)}/{timeline.length} · ← → to step</span>
        </div>
      </div>
    </div>
  );
}
