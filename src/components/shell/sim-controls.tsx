"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipForward } from "lucide-react";
import { useMutation } from "@/hooks/useApi";
import { useApp } from "@/lib/store";

const SPEEDS = [1, 2, 5, 10];

/**
 * Simulation clock. "Play" drives a client-side loop that steps the server
 * simulation (serverless-safe: no server timers). Failures stop the loop and
 * are surfaced rather than silently ignored.
 */
export function SimControls({ companyId }: { companyId: string }) {
  const { mutate } = useMutation<{ action: string; days: number }, { simDay: number }>();
  const { toast } = useApp();
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [day, setDay] = useState<number | null>(null);
  const loopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function step(): Promise<boolean> {
    try {
      const res = await mutate(`/api/companies/${companyId}/sim`, { action: "step", days: 1 });
      setDay(res.simDay);
      return true;
    } catch (e) {
      setRunning(false);
      toast({ title: "Simulation step failed", description: (e as Error).message, level: "danger" });
      return false;
    }
  }

  useEffect(() => {
    if (!running) {
      if (loopRef.current) clearTimeout(loopRef.current);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const ok = await step();
      if (cancelled || !ok) return;
      loopRef.current = setTimeout(tick, Math.max(400, 2000 / speed));
    };
    tick();
    return () => {
      cancelled = true;
      if (loopRef.current) clearTimeout(loopRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, speed]);

  return (
    <div className="flex h-7 items-center rounded-md border border-border" role="group" aria-label="Simulation clock">
      <button
        onClick={() => setRunning((r) => !r)}
        className={`flex h-full items-center gap-1.5 rounded-l-md px-2 text-2xs transition-colors hover:bg-bg-hover ${running ? "text-brand" : "text-text-muted"}`}
        aria-pressed={running}
        title={running ? "Pause simulation" : "Run simulation"}
      >
        {running ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        <span className="mono hidden sm:inline">{day !== null ? `day ${day}` : running ? "running" : "sim"}</span>
      </button>
      <button onClick={() => step()} className="flex h-full items-center border-l border-border px-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text" title="Advance one simulated day" aria-label="Advance one simulated day">
        <SkipForward className="h-3 w-3" />
      </button>
      <div className="hidden h-full items-center border-l border-border px-0.5 sm:flex">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            aria-pressed={speed === s}
            className={`mono h-5 rounded px-1.5 text-2xs transition-colors ${speed === s ? "bg-bg-hover text-text" : "text-text-faint hover:text-text"}`}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
