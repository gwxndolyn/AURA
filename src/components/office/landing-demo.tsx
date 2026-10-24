"use client";

/**
 * Landing-page guided demo. A scripted, deterministic replay of AURA's real
 * checkout-validation workflow (see src/lib/office/demo-script.ts), driven
 * step by step by the visitor. The office shows what the script's task
 * statuses imply via the same mapper the live office uses.
 *
 * Labelled DEMO everywhere. Code and diffs are the real fixture and repair
 * candidates; test output is recorded from real sandbox runs. No backend is
 * called from here.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleDot, FileCode2, FlaskConical, GitPullRequestArrow, Play, RotateCcw, SkipForward, X, ShieldCheck, FileText } from "lucide-react";
import { OfficeView } from "./office-view";
import { AgentInspector, LocationInspector } from "./agent-inspector";
import { DEMO_AGENTS, DEMO_PLAN, DEMO_PROJECT, DEMO_STEPS, DEMO_TASK_TEXT, DEMO_ACCEPTANCE, DEMO_NOW, demoDiff, demoHistory, demoInteractionsAt, demoTasksAt, recordedRun } from "@/lib/office/demo-script";
import { DEMO_RECORDING } from "@/lib/office/recording";
import { mapOfficeState, displayNames, type VisualAgent } from "@/lib/office/state";
import { PixelAvatar } from "./office-2d";
import type { LocationId } from "@/lib/office/layout";
import { cn } from "@/lib/utils";

const agentsIn = DEMO_AGENTS.map((a) => ({ ...a, status: "IDLE", available: true }));
const agentName = (k: string) => DEMO_AGENTS.find((a) => a.key === k)?.name ?? k;
const NAMES = displayNames(DEMO_AGENTS);
const demoName = (k: string) => NAMES[k] ?? agentName(k);

export function LandingDemo({ onStateChange }: { onStateChange?: (started: boolean) => void }) {
  const [i, setI] = useState(-1); // -1 = intro (office overview, not started)
  const [selected, setSelected] = useState<string | null>(null);
  const [loc, setLoc] = useState<LocationId | null>(null);
  const [typed, setTyped] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const step = i >= 0 ? DEMO_STEPS[i] : null;

  useEffect(() => onStateChange?.(i >= 0), [i, onStateChange]);

  // Typewriter for the task step (instant under reduced motion).
  useEffect(() => {
    if (step?.id !== "task") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return setTyped(DEMO_TASK_TEXT);
    setTyped("");
    let n = 0;
    const t = setInterval(() => {
      n++;
      setTyped(DEMO_TASK_TEXT.slice(0, n));
      if (n >= DEMO_TASK_TEXT.length) clearInterval(t);
    }, 28);
    return () => clearInterval(t);
  }, [step?.id]);

  const visual = useMemo(() => {
    const s = step ?? DEMO_STEPS[0];
    return mapOfficeState({ agents: agentsIn, tasks: step ? demoTasksAt(s) : [], interactions: step ? demoInteractionsAt(s) : [], now: DEMO_NOW });
  }, [step]);
  const interactions = useMemo(() => (step ? demoInteractionsAt(step) : []), [step]);
  const history = useMemo(() => demoHistory(Math.max(0, i)), [i]);

  const go = (n: number) => {
    setSelected(null);
    setLoc(null);
    setI(Math.max(-1, Math.min(DEMO_STEPS.length - 1, n)));
  };
  // ← / → step through the walkthrough while it is running (ignored in form fields
  // and while the office canvas has focus for its own controls).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (i < 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,select,[contenteditable]")) return;
      const r = rootRef.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) return;
      if (e.key === "ArrowRight") (e.preventDefault(), setI((n) => Math.min(DEMO_STEPS.length - 1, n + 1)), setSelected(null), setLoc(null));
      if (e.key === "ArrowLeft") (e.preventDefault(), setI((n) => Math.max(0, n - 1)), setSelected(null), setLoc(null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i]);

  const sel = visual.find((v) => v.key === selected);

  return (
    <div ref={rootRef} className="relative" data-testid="landing-demo" data-step={step?.id ?? "intro"}>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="relative min-w-0">
          <OfficeView
            agents={visual}
            interactions={interactions}
            selected={selected}
            onSelect={(k) => { setSelected(k); if (k) setLoc(null); }}
            selectedLocation={loc}
            onSelectLocation={(l) => { setLoc(l); if (l) setSelected(null); }}
            height="min(66vh, 640px)"
            focusKey={step?.focus ?? null}
            label="Demo office"
          />
          <span className="mono pointer-events-none absolute left-3 top-3 rounded-full border border-warning/40 bg-[#16110e]/85 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-warning backdrop-blur" data-testid="demo-badge">Demo · scripted replay</span>
        </div>

        <aside ref={panelRef} className="flex min-h-[420px] min-w-0 flex-col rounded-xl border border-border bg-bg-raised" aria-live="polite" aria-label="Demo walkthrough">
          {sel ? (
            <div className="p-4"><AgentInspector agent={sel} demo activity={(history[sel.key] ?? []).map((h) => ({ text: h.text, demo: true }))} onClose={() => setSelected(null)} /></div>
          ) : loc ? (
            <div className="p-4"><LocationInspector id={loc} agents={visual} onSelectAgent={setSelected} onClose={() => setLoc(null)} /></div>
          ) : !step ? (
            <Intro onStart={() => go(0)} onSkip={() => go(DEMO_STEPS.length - 1)} team={visual} onPick={setSelected} />
          ) : (
            <>
              <div className="border-b border-border px-4 pb-3 pt-4">
                <div className="mono flex items-center justify-between text-2xs text-text-faint">
                  <span>Step {i + 1} of {DEMO_STEPS.length}</span>
                  <span className="text-warning">demo</span>
                </div>
                <div className="mt-1.5 flex gap-0.5" aria-hidden>{DEMO_STEPS.map((s, n) => <span key={s.id} className={cn("h-1 flex-1 rounded-full", n <= i ? "bg-brand" : "bg-border-strong")} />)}</div>
                <h3 className="mt-3 text-base font-medium" data-testid="demo-step-title">{step.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-text-muted">{step.caption}</p>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4"><StepPanel step={step} typed={typed} onPickAgent={setSelected} /></div>
              <div className="flex items-center gap-2 border-t border-border p-3">
                <button onClick={() => go(i - 1)} className="btn-ghost btn-sm" aria-label="Previous step"><ArrowLeft className="h-3.5 w-3.5" /> Back</button>
                <button onClick={() => go(-1)} className="btn-ghost btn-sm" aria-label="Restart the demo" data-testid="demo-reset"><RotateCcw className="h-3.5 w-3.5" /> Replay</button>
                {i < DEMO_STEPS.length - 1 ? (
                  <button onClick={() => go(i + 1)} className="btn-primary btn-sm ml-auto" data-testid="demo-next">Next <ArrowRight className="h-3.5 w-3.5" /></button>
                ) : (
                  <Link href="/register?next=%2Fapp" className="btn-primary btn-sm ml-auto" data-testid="demo-cta">Run it for real <ArrowRight className="h-3.5 w-3.5" /></Link>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function Intro({ onStart, onSkip, team, onPick }: { onStart: () => void; onSkip: () => void; team: VisualAgent[]; onPick: (k: string) => void }) {
  return (
    <div className="flex flex-1 flex-col p-5">
      <p className="mono text-2xs uppercase tracking-[0.14em] text-text-faint">Guided demo · 11 steps · ~2 min</p>
      <h3 className="mt-2 text-lg font-medium leading-snug">Watch the team fix a real validation bug.</h3>
      <ol className="mt-4 space-y-2.5 text-sm">
        {[
          ["Pick a project and describe the task", FileCode2],
          ["See the plan and who owns each step", CircleDot],
          ["Watch tests fail, a fix, a review finding and a repair", FlaskConical],
          ["Review the evidence and decide", GitPullRequestArrow],
        ].map(([t, Icon], n) => {
          const I = Icon as typeof Play;
          return (
            <li key={n} className="flex items-center gap-2.5 text-text-muted"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-bg-elevated"><I className="h-3.5 w-3.5" /></span>{t as string}</li>
          );
        })}
      </ol>
      <div className="mt-5">
        <div className="metric-label mb-2">Meet the team</div>
        <ul className="grid grid-cols-3 gap-1.5" data-testid="demo-team">
          {team.map((a) => (
            <li key={a.key}>
              <button onClick={() => onPick(a.key)} className="flex w-full items-center gap-1.5 rounded-md border border-border bg-bg-elevated/60 px-1.5 py-1 text-left hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60" aria-label={`Meet ${a.name}, ${a.role}`}>
                <PixelAvatar agentKey={a.key} size={22} />
                <span className="min-w-0"><span className="block truncate text-[11px] font-medium leading-tight">{a.name}</span><span className="block truncate text-[10px] leading-tight text-text-faint">{a.role}</span></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto space-y-3 pt-5">
        <div className="flex gap-2">
          <button onClick={onStart} className="btn-primary h-9 flex-1" data-testid="demo-start-panel"><Play className="h-4 w-4" /> Start</button>
          <button onClick={onSkip} className="btn-secondary h-9" data-testid="demo-skip"><SkipForward className="h-4 w-4" /> Skip to the result</button>
        </div>
        <p className="text-[11px] leading-relaxed text-text-faint">
          A scripted replay, not live AI. The code is AURA&apos;s real sample project, the fixes are its prepared repair candidates, and the test results were recorded from real Docker sandbox runs on {new Date(DEMO_RECORDING.recordedAt).toISOString().slice(0, 10)}. Use ← → to move between steps.
        </p>
      </div>
    </div>
  );
}

function StepPanel({ step, typed, onPickAgent }: { step: (typeof DEMO_STEPS)[number]; typed: string; onPickAgent: (k: string) => void }) {
  const p = step.panel;
  switch (p.type) {
    case "project":
      return (
        <div className="space-y-2" data-testid="demo-project">
          {[{ ...DEMO_PROJECT, active: true }, { id: "x1", name: "Your repository", description: "Bring your own codebase", active: false }].map((proj) => (
            <div key={proj.id} className={cn("rounded-lg border p-3", proj.active ? "border-brand/60 bg-brand/5" : "border-dashed border-border opacity-60")}>
              <div className="flex items-center gap-2 text-sm font-medium">{proj.active ? <Check className="h-3.5 w-3.5 text-brand" /> : <span className="h-3.5 w-3.5" />}{proj.name}{!proj.active && <span className="mono ml-auto text-[10px] font-normal text-text-faint">not in the demo</span>}</div>
              <p className="mt-0.5 pl-5 text-xs text-text-muted">{proj.description}</p>
              {proj.active && <ul className="mono mt-2 space-y-0.5 pl-5 text-[11px] text-text-muted">{DEMO_PROJECT.files.map((f) => <li key={f.path}>{f.path}</li>)}</ul>}
            </div>
          ))}
          <p className="text-[11px] text-text-faint">{DEMO_PROJECT.ticket}</p>
        </div>
      );
    case "task":
      return (
        <div data-testid="demo-task">
          <label className="metric-label" htmlFor="demo-task-input">Task for the team</label>
          <div id="demo-task-input" className="mt-1.5 min-h-[64px] rounded-lg border border-border-strong bg-bg-inset p-3 text-sm" aria-readonly>
            {typed}
            <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-brand" />
          </div>
          <p className="mt-2 text-xs text-text-muted">AURA matches this to the project&apos;s checkout validation module and its test suite.</p>
        </div>
      );
    case "plan":
      return (
        <div data-testid="demo-plan">
          <ol className="space-y-1.5">
            {DEMO_PLAN.map((t, n) => (
              <li key={t.key} className="flex items-start gap-2 text-xs">
                <span className="mono mt-0.5 w-4 shrink-0 text-text-faint">{n + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{t.title}</span>
                  <span className="block text-text-faint">{t.kind.toLowerCase().replace("_", " ")}{t.dependsOn.length ? ` · after ${t.dependsOn.join(", ")}` : ""}</span>
                </span>
                <button onClick={() => onPickAgent(t.agentKey)} className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[11px] text-text-muted hover:border-brand hover:text-text">{demoName(t.agentKey)}</button>
              </li>
            ))}
          </ol>
          <div className="mt-3 rounded-md border border-border bg-bg-inset p-2.5 text-[11px] text-text-muted">
            <div className="metric-label mb-1">Acceptance criteria</div>
            <ul className="list-disc space-y-0.5 pl-4">{DEMO_ACCEPTANCE.map((a) => <li key={a}>{a}</li>)}</ul>
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-text-faint"><ShieldCheck className="h-3 w-3" /> In the app, nothing runs until you approve this plan.</p>
        </div>
      );
    case "code": {
      const f = DEMO_PROJECT.files.find((x) => x.path === p.file)!;
      return (
        <div data-testid="demo-code">
          <div className="mono mb-1 text-[11px] text-text-faint">{p.file}</div>
          <pre className="max-h-[300px] overflow-auto rounded-lg border border-border bg-bg-inset p-2.5 text-[11px] leading-[1.55]">
            {f.content.split("\n").map((line, n) => <div key={n} className={cn("px-1", line.includes(p.highlight) && "rounded bg-danger/15 text-[#ffd0d0]")}><span className="mr-2 inline-block w-4 select-none text-right text-text-faint">{n + 1}</span>{line}</div>)}
          </pre>
          <p className="mt-2 text-xs text-text-muted">{p.note}</p>
        </div>
      );
    }
    case "diff": {
      const d = demoDiff(p.before, p.after);
      const lines = d.text.split("\n");
      const changed = lines.map((l, n) => (l.startsWith("+") || l.startsWith("-") ? n : -1)).filter((n) => n >= 0);
      const from = Math.max(0, (changed[0] ?? 0) - 3);
      const to = Math.min(lines.length, (changed.at(-1) ?? 0) + 4);
      return (
        <div data-testid="demo-diff">
          <div className="mb-1 flex items-center gap-2 text-[11px]"><span className="font-medium text-text">{p.title}</span><span className="mono ml-auto text-success">+{d.added}</span><span className="mono text-danger">−{d.removed}</span></div>
          <pre className="overflow-x-auto rounded-lg border border-border bg-bg-inset py-2 text-[11px] leading-[1.6]">
            {lines.slice(from, to).map((l, n) => <div key={n} className={cn("px-2.5", l.startsWith("+") ? "bg-success/12 text-[#c9f2d9]" : l.startsWith("-") ? "bg-danger/12 text-[#ffd0d0]" : "text-text-muted")}>{l}</div>)}
          </pre>
          <p className="mono mt-2 text-[11px] text-text-faint">{p.note}</p>
          <p className="mt-1 text-[11px] text-text-faint">Demo: this is the engine&apos;s prepared repair candidate (what runs without an API key). With a key, the engineer&apos;s model writes the change within the same scope.</p>
        </div>
      );
    }
    case "tests":
      return <div className="space-y-3" data-testid="demo-tests">{p.runs.map((id) => <RunCard key={id} id={id} />)}<p className="text-xs text-text-muted">{p.note}</p></div>;
    case "review":
      return (
        <div className="space-y-3" data-testid="demo-review">
          {p.runs.map((id) => <RunCard key={id} id={id} />)}
          {p.finding && (
            <div className="rounded-lg border border-danger/40 bg-danger/5 p-2.5 text-xs">
              <div className="flex items-center gap-2"><span className="mono shrink-0 whitespace-nowrap rounded bg-danger/20 px-1 text-[10px] text-danger">{p.finding.code}</span><span className="font-medium">{p.finding.title}</span>{p.finding.blocking && <span className="mono ml-auto text-[10px] text-danger">blocking</span>}</div>
              <p className="mt-1 text-text-muted">Backed by the executed probes above. Routed to {demoName("backend-engineer")} as repair round 1 of 2.</p>
            </div>
          )}
        </div>
      );
    case "evidence":
      return (
        <div className="space-y-3 text-xs" data-testid="demo-evidence">
          <ul className="space-y-1.5">
            {DEMO_ACCEPTANCE.map((a, n) => (
              <li key={a} className="flex gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /><span>{a}<span className="block text-text-faint">{["verify-2: 5/5 tests passed (recorded sandbox run)", "Diff touches only src/checkout/validation.js", "review-2: 3/3 probes passed; F-1 resolved"][n]}</span></span></li>
            ))}
          </ul>
          <div className="grid grid-cols-4 gap-1.5 text-center">
            {[["Proposed", "1 change"], ["Executed", "5 runs"], ["Verified", "yes"], ["Deployed", "0"]].map(([k, v]) => (
              <div key={k} className="rounded-md border border-border bg-bg-inset px-1 py-1.5"><div className="mono text-sm text-text">{v}</div><div className="text-[10px] text-text-faint">{k}</div></div>
            ))}
          </div>
          <div className="rounded-lg border border-border p-2.5">
            <div className="metric-label mb-1 flex items-center gap-1"><FileText className="h-3 w-3" /> What happens next (in the app)</div>
            <ul className="list-disc space-y-0.5 pl-4 text-text-muted">
              <li>You read the diff and the evidence, then <b className="font-medium text-text">accept</b> it into the project (new revision) or <b className="font-medium text-text">reject</b> it.</li>
              <li>An accepted change can be reverted later. Nothing is deployed.</li>
            </ul>
            <div className="mt-2 flex gap-1.5"><span className="btn-secondary btn-sm pointer-events-none opacity-70"><X className="h-3 w-3" /> Reject</span><span className="btn-secondary btn-sm pointer-events-none opacity-70"><Check className="h-3 w-3" /> Accept change</span><span className="ml-auto self-center text-[10px] text-warning">disabled in the demo</span></div>
          </div>
        </div>
      );
  }
}

function RunCard({ id }: { id: string }) {
  const r = recordedRun(id);
  const ok = r.failed === 0;
  return (
    <div className="rounded-lg border border-border bg-bg-inset p-2.5" data-run={id}>
      <div className="flex items-center gap-2 text-xs">
        <span className={cn("mono rounded px-1.5 py-0.5 text-[10px] font-medium", ok ? "bg-success/15 text-success" : "bg-danger/15 text-danger")}>{ok ? "PASSED" : "FAILED"}</span>
        <span className="font-medium">{r.kind === "probes" ? "Reviewer probes" : "Test suite"}</span>
        <span className="mono ml-auto text-text-muted">{r.passed}/{r.total} passed</span>
      </div>
      <ul className="mono mt-2 space-y-0.5 text-[10.5px] leading-snug">
        {r.cases.map((c) => <li key={c.name} className={cn("flex gap-1.5", c.ok ? "text-text-muted" : "text-[#ffb4b4]")}><span className="shrink-0">{c.ok ? "ok" : "not ok"}</span><span className="truncate" title={c.name}>{c.name.replace(/^probe [a-z-]+: /, "")}</span></li>)}
      </ul>
      <p className="mono mt-1.5 break-words text-[10px] text-text-faint">recorded · {DEMO_RECORDING.command} · {DEMO_RECORDING.image} · network {DEMO_RECORDING.network} · {r.durationMs} ms</p>
    </div>
  );
}
