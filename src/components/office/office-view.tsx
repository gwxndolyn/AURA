"use client";

/**
 * The living office. Chooses a renderer:
 *   - 3D (three.js, dynamically imported) when WebGL is available and the
 *     viewport is wide enough;
 *   - the 2D office otherwise (no WebGL, small screens, or `?office=2d`).
 * Both render the same VisualAgent[]; neither owns any execution state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Crosshair, Minus, Plus, Box, Grid2x2, Hand } from "lucide-react";
import { LOCATIONS, LOCATION_BY_ID, type LocationId } from "@/lib/office/layout";
import { ACTIVITY_LABEL, type OfficeInteraction, type VisualAgent } from "@/lib/office/state";
import { Office2D, ACTIVITY_DOT } from "./office-2d";
import { webglAvailable, prefersReducedMotion } from "./webgl";
import type { OfficeScene } from "./scene";
import { cn } from "@/lib/utils";

export type OfficeMode = "auto" | "3d" | "2d";

const HINT_KEY = "aura.office.hint.v1";

export function OfficeView({ agents, interactions = [], selected, onSelect, selectedLocation, onSelectLocation, mode = "auto", className, height = 560, focusKey, label = "AURA office" }: {
  agents: VisualAgent[];
  interactions?: OfficeInteraction[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  selectedLocation: LocationId | null;
  onSelectLocation: (id: LocationId | null) => void;
  mode?: OfficeMode;
  className?: string;
  height?: number | string;
  /** Agent the camera should gently follow (e.g. the current demo step's focus). */
  focusKey?: string | null;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const labelRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const locRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [renderer, setRenderer] = useState<"pending" | "3d" | "2d">("pending");
  const [why2d, setWhy2d] = useState<string>("");
  const [ready, setReady] = useState(false);
  const [hint, setHint] = useState(false);
  const [forced, setForced] = useState<"3d" | "2d" | null>(null);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const interRef = useRef(interactions);
  interRef.current = interactions;

  // Decide renderer on the client.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("office");
    const want = forced ?? (q === "2d" || q === "3d" ? q : mode);
    const small = window.matchMedia("(max-width: 767px)").matches;
    if (want === "2d") return setRenderer("2d"), setWhy2d(q === "2d" ? "2D office (requested)" : "2D office");
    if (!webglAvailable()) return setRenderer("2d"), setWhy2d("WebGL is unavailable in this browser, so the office is shown in 2D.");
    if (want === "auto" && small) return setRenderer("2d"), setWhy2d("Compact office for small screens.");
    setRenderer("3d");
  }, [mode, forced]);

  // Mount / unmount the 3D scene.
  useEffect(() => {
    if (renderer !== "3d" || !canvasRef.current) return;
    let disposed = false;
    import("./scene")
      .then(({ OfficeScene }) => {
        if (disposed || !canvasRef.current) return;
        try {
          const s = new OfficeScene(canvasRef.current, {
            onPickAgent: (k) => onSelectRef.current(k),
            onPickLocation: (id) => onSelectLocRef.current(id),
            onFrame: (a, l) => {
              // Greedy de-collision: front-most (lowest on screen) labels keep their spot,
              // labels behind them are lifted until they no longer overlap.
              const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
              for (const [k, p] of Object.entries(a).sort((m, n) => n[1].y - m[1].y)) {
                const el = labelRefs.current[k];
                if (!el) continue;
                const w = el.offsetWidth || 60;
                const h = el.offsetHeight || 18;
                let y = p.y;
                for (let tries = 0; tries < 4; tries++) {
                  const hit = placed.find((r) => p.x - w / 2 < r.x1 && p.x + w / 2 > r.x0 && y - h < r.y1 && y > r.y0);
                  if (!hit) break;
                  y = hit.y0 - 2;
                }
                placed.push({ x0: p.x - w / 2, x1: p.x + w / 2, y0: y - h, y1: y });
                el.style.transform = `translate(${p.x}px, ${y}px) translate(-50%, -100%)`;
              }
              for (const [k, p] of Object.entries(l)) {
                const el = locRefs.current[k];
                if (el) el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
              }
            },
          }, prefersReducedMotion());
          sceneRef.current = s;
          s.setAgents(agentsRef.current, interRef.current);
          setReady(true);
          try {
            if (!localStorage.getItem(HINT_KEY)) setHint(true);
          } catch {
            /* storage unavailable */
          }
        } catch {
          setRenderer("2d");
          setWhy2d("The 3D office could not start (WebGL error), so it is shown in 2D.");
        }
      })
      .catch(() => {
        setRenderer("2d");
        setWhy2d("The 3D office failed to load, so it is shown in 2D.");
      });
    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
      setReady(false);
    };
  }, [renderer]);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onSelectLocRef = useRef(onSelectLocation);
  onSelectLocRef.current = onSelectLocation;

  useEffect(() => {
    sceneRef.current?.setAgents(agents, interactions);
  }, [agents, interactions, ready]);
  // The hint goes away for good once someone has interacted with the office.
  useEffect(() => {
    if (hint && (selected || selectedLocation || focusKey)) dismissHint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectedLocation, focusKey]);
  useEffect(() => {
    sceneRef.current?.select(selected);
    if (selected) sceneRef.current?.focusAgent(selected);
  }, [selected, ready]);
  useEffect(() => {
    if (selectedLocation) sceneRef.current?.focusLocation(selectedLocation);
  }, [selectedLocation, ready]);
  useEffect(() => {
    if (focusKey && !selected) sceneRef.current?.focusAgent(focusKey);
  }, [focusKey, selected, ready]);

  const reset = useCallback(() => {
    onSelect(null);
    onSelectLocation(null);
    sceneRef.current?.resetView();
  }, [onSelect, onSelectLocation]);

  const dismissHint = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") reset();
    if (renderer !== "3d") return;
    if (e.key === "+" || e.key === "=") sceneRef.current?.zoomBy(1.15);
    if (e.key === "-") sceneRef.current?.zoomBy(1 / 1.15);
  };

  const interactionPartners = new Set(interactions.flatMap((i) => [i.from, ...i.to]));

  return (
    <div className={cn("relative overflow-hidden rounded-xl border border-[#3a2f27] bg-[#16110e]", className)} style={{ height: renderer === "2d" ? undefined : height }} onKeyDown={onKey} role="region" aria-label={label} data-testid="office" data-renderer={renderer}>
      {renderer === "3d" && (
        <>
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,#3b2c22_0%,#1b1410_60%,#120d0a_100%)]" />
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" style={{ cursor: "grab" }} aria-hidden data-testid="office-canvas" />
          {/* Location labels (buttons: keyboard path into each area) */}
          <div className="pointer-events-none absolute inset-0">
            {LOCATIONS.map((l) => (
              <button
                key={l.id}
                ref={(el) => {
                  locRefs.current[l.id] = el;
                }}
                onClick={() => onSelectLocation(selectedLocation === l.id ? null : l.id)}
                className={cn("pointer-events-auto absolute left-0 top-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] backdrop-blur transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", selectedLocation === l.id ? "border-brand/70 bg-[#16110e]/90 text-brand-glow" : "border-white/10 bg-[#16110e]/70 text-[#e9dccb] hover:text-white", !ready && "opacity-0")}
                data-location={l.id}
                aria-label={`${l.label} area`}
              >
                {l.label}
              </button>
            ))}
            {agents.map((a) => (
              <button
                key={a.key}
                ref={(el) => {
                  labelRefs.current[a.key] = el;
                }}
                onClick={() => onSelect(selected === a.key ? null : a.key)}
                aria-pressed={selected === a.key}
                aria-label={`${a.name}, ${a.role}: ${ACTIVITY_LABEL[a.activity]}. ${a.label}`}
                data-agent={a.key}
                data-activity={a.activity}
                className={cn(
                  "pointer-events-auto absolute left-0 top-0 flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-[1px] text-[10px] font-medium shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-[background-color,border-color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  selected === a.key ? "z-10 border-brand bg-brand text-brand-ink" : "border-black/20 bg-[#fbf4e8]/95 text-[#2a211b] hover:bg-white",
                  !ready && "opacity-0",
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", ACTIVITY_DOT[a.activity], selected === a.key && "bg-brand-ink")} />
                {a.name}
                {(a.activity !== "idle" || interactionPartners.has(a.key)) && <span className={cn("hidden font-normal sm:inline", selected === a.key ? "text-brand-ink/70" : "text-[#7a6a5a]")}>· {ACTIVITY_LABEL[a.activity].toLowerCase()}</span>}
              </button>
            ))}
          </div>
          {!ready && <div className="absolute inset-0 grid place-items-center text-xs text-[#a8957f]" role="status">Setting up the office…</div>}
          {/* Controls */}
          <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-white/10 bg-[#16110e]/80 p-1 backdrop-blur">
            <button className="icon-btn h-7 w-7 text-[#e9dccb]" onClick={() => sceneRef.current?.zoomBy(1.15)} aria-label="Zoom in"><Plus className="h-3.5 w-3.5" /></button>
            <button className="icon-btn h-7 w-7 text-[#e9dccb]" onClick={() => sceneRef.current?.zoomBy(1 / 1.15)} aria-label="Zoom out"><Minus className="h-3.5 w-3.5" /></button>
            <button className="icon-btn h-7 w-7 text-[#e9dccb]" onClick={reset} aria-label="Back to overview" data-testid="office-reset"><Crosshair className="h-3.5 w-3.5" /></button>
            <button className="icon-btn h-7 w-7 text-[#e9dccb]" onClick={() => setForced("2d")} aria-label="Switch to the 2D office"><Grid2x2 className="h-3.5 w-3.5" /></button>
          </div>
          {hint && ready && (
            <div className="absolute right-3 top-3 flex max-w-[330px] items-start gap-2 rounded-lg border border-white/10 bg-[#16110e]/90 p-2.5 text-[11px] leading-snug text-[#e9dccb] backdrop-blur" role="note">
              <Hand className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
              <span>Click a teammate or an area to inspect it. Drag to pan, scroll to zoom. Press <kbd className="mono rounded bg-white/10 px-1">Esc</kbd> or <Crosshair className="inline h-3 w-3" /> to return to the overview.</span>
              <button className="ml-1 text-[#a8957f] hover:text-white" onClick={dismissHint} aria-label="Dismiss hint">×</button>
            </div>
          )}
        </>
      )}
      {renderer === "2d" && (
        <div>
          <div className="flex items-center justify-between gap-2 border-b border-[#3a2f27] px-3 py-1.5 text-[11px] text-[#a8957f]">
            <span>{why2d}</span>
            {webglAvailable() && forced === "2d" && <button className="flex items-center gap-1 hover:text-white" onClick={() => setForced("3d")}><Box className="h-3 w-3" /> 3D office</button>}
          </div>
          <Office2D agents={agents} selected={selected} selectedLocation={selectedLocation} onSelect={onSelect} onSelectLocation={(id) => onSelectLocation(selectedLocation === id ? null : id)} />
        </div>
      )}
      {renderer === "pending" && <div style={{ height }} />}
    </div>
  );
}

export function locationInfo(id: LocationId) {
  return LOCATION_BY_ID[id];
}
