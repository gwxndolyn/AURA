"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { cn, timeAgo } from "@/lib/utils";

export interface ChangeDetail {
  id: string;
  path: string;
  op: string;
  source: string;
  author: string;
  missionId: string | null;
  taskKey: string | null;
  runId: string | null;
  explanation: string;
  status: string;
  added: number;
  removed: number;
  baseRev: number;
  appliedRevision: number | null;
  revertedRevision: number | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  history: { at: string; actor: string; change: string; detail?: string }[];
  verification: { missionStatus?: string; risk?: string; testRuns?: number; lastTest?: { artifactId: string; name: string; mode?: string; passed?: number; failed?: number; total?: number } | null; openBlocking?: string[]; resolvedFindings?: number };
  before: string;
  after: string;
  current: { rev: number; sha256: string; matchesProposed: boolean; matchesBase: boolean } | null;
  mission: { id: string; title: string; status: string; acceptance: string[]; risk: string } | null;
  run: { id: string; agentKey: string; taskKey: string; attempt: number; claims: string; startedAt: string } | null;
  missionTests: { id: string; name: string; meta: { mode?: string; passed?: number; total?: number; failed?: number }; createdAt: string }[];
  checks: { id: string; check: string; status: string; passed: number | null; total: number | null; exitCode: number | null; createdAt: string }[];
  blockers: string[];
  requiresApproval: boolean;
  canDecide: boolean;
}

/** Lifecycle labels kept distinct: proposed ≠ verified ≠ accepted (applied) ≠ reverted. */
export const CHANGE_STATUS: Record<string, { label: string; tone: "neutral" | "warning" | "success" | "danger" | "info" }> = {
  PROPOSED: { label: "proposed", tone: "neutral" },
  VERIFICATION_PENDING: { label: "verification pending", tone: "info" },
  VERIFICATION_FAILED: { label: "verification failed", tone: "danger" },
  VERIFIED: { label: "verified · not applied", tone: "warning" },
  ACCEPTED: { label: "accepted · applied", tone: "success" },
  REJECTED: { label: "rejected", tone: "neutral" },
  REVERTED: { label: "reverted", tone: "neutral" },
  CONFLICT: { label: "conflict", tone: "danger" },
  SUPERSEDED: { label: "superseded", tone: "neutral" },
};

export function ChangeStatus({ status }: { status: string }) {
  const s = CHANGE_STATUS[status] ?? { label: status.toLowerCase(), tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/**
 * Review panel for one change: provenance, the agent's explanation (a claim),
 * the verification evidence, blockers, and the decision controls. Controls
 * that cannot apply are not rendered as working buttons — the reason is shown.
 */
export function ReviewPanel({ companyId, c, busy, onAction, onRunCheck }: { companyId: string; c: ChangeDetail; busy: string | null; onAction: (action: "accept" | "reject" | "revert" | "revise", extra?: Record<string, unknown>) => void; onRunCheck: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  const open = ["PROPOSED", "VERIFICATION_PENDING", "VERIFICATION_FAILED", "VERIFIED"].includes(c.status);
  const lt = c.verification.lastTest;
  return (
    <div className="space-y-4 p-3 text-sm" data-testid="review-panel">
      <header>
        <div className="flex flex-wrap items-center gap-1.5">
          <ChangeStatus status={c.status} />
          {c.requiresApproval && <Badge tone="warning">higher risk · explicit approval</Badge>}
        </div>
        <h2 className="mono mt-2 break-all text-sm text-text">{c.path}</h2>
        <p className="mono text-2xs text-text-faint">{c.op} · <span className="text-success">+{c.added}</span> <span className="text-danger">−{c.removed}</span> · based on file r{c.baseRev}{c.appliedRevision ? ` · applied as r${c.appliedRevision}` : ""}{c.revertedRevision ? ` · reverted in r${c.revertedRevision}` : ""}</p>
      </header>

      <section>
        <h3 className="metric-label mb-1">Provenance</h3>
        <dl className="grid grid-cols-[88px_1fr] gap-y-0.5 text-xs">
          <dt className="text-text-faint">Mission</dt><dd className="truncate">{c.mission ? <Link className="hover:underline" href={`/app/${companyId}/missions/${c.mission.id}`}>{c.mission.title}</Link> : "—"}</dd>
          <dt className="text-text-faint">Task</dt><dd className="mono">{c.taskKey ?? "—"}{c.run ? ` · attempt ${c.run.attempt}` : ""}</dd>
          <dt className="text-text-faint">Agent</dt><dd className="mono">{c.author}</dd>
          <dt className="text-text-faint">Proposed</dt><dd>{timeAgo(c.createdAt)}</dd>
          {c.decidedBy && <><dt className="text-text-faint">Decided by</dt><dd>{c.decidedBy} · {c.decidedAt && timeAgo(c.decidedAt)}</dd></>}
          <dt className="text-text-faint">Current file</dt><dd className="mono">{c.current ? `r${c.current.rev}${c.current.matchesProposed ? " = this change" : c.current.matchesBase ? " = base (not applied)" : " (moved since)"}` : "deleted"}</dd>
        </dl>
      </section>

      {(c.explanation || c.run?.claims) && (
        <section>
          <h3 className="metric-label mb-1">Agent explanation <span className="normal-case tracking-normal text-text-faint">· a claim, not evidence</span></h3>
          <p className="text-xs italic text-text-muted">{c.explanation}{c.run?.claims ? ` — ${c.run.claims.slice(0, 400)}` : ""}</p>
        </section>
      )}

      <section>
        <h3 className="metric-label mb-1">Verification evidence (recorded)</h3>
        <ul className="space-y-1 text-xs" data-testid="review-evidence">
          {c.missionTests.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              {t.meta.failed === 0 && t.meta.mode === "docker" ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <XCircle className="h-3.5 w-3.5 text-danger" />}
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <span className="mono text-2xs text-text-faint">{t.meta.passed}/{t.meta.total} · {t.meta.mode}</span>
            </li>
          ))}
          {c.checks.map((k) => (
            <li key={k.id} className="flex items-center gap-2">
              {k.status === "PASSED" ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <XCircle className="h-3.5 w-3.5 text-danger" />}
              <span className="min-w-0 flex-1 truncate">workspace check: {k.check} on this change</span>
              <span className="mono text-2xs text-text-faint">{k.status.toLowerCase()}{k.total !== null ? ` ${k.passed}/${k.total}` : ""} · exit {k.exitCode ?? "—"}</span>
            </li>
          ))}
          {!c.missionTests.length && !c.checks.length && <li className="text-text-muted">No test run is recorded for this change.</li>}
        </ul>
        {c.verification.openBlocking?.length ? <p className="mt-1 text-xs text-danger">Open blocking findings: {c.verification.openBlocking.join("; ")}</p> : c.verification.resolvedFindings ? <p className="mt-1 text-xs text-text-muted">{c.verification.resolvedFindings} reviewer finding(s) raised and resolved before this version.</p> : null}
        <button onClick={onRunCheck} disabled={!!busy || !open} className="btn-secondary btn-sm mt-2" data-testid="verify-change">
          {busy === "check" ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Run tests on this change
        </button>
      </section>

      {c.mission?.acceptance.length ? (
        <section>
          <h3 className="metric-label mb-1">Mission acceptance criteria</h3>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-text-muted">{c.mission.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
        </section>
      ) : null}

      <section className="rounded-md border border-border p-2.5" aria-label="Decision">
        <h3 className="metric-label mb-1.5">Decision</h3>
        {open ? (
          <>
            {c.blockers.length > 0 ? (
              <ul className="mb-2 space-y-0.5 text-xs text-warning" data-testid="blockers">
                {c.blockers.map((b) => <li key={b} className="flex gap-1"><ShieldAlert className="mt-px h-3 w-3 shrink-0" />{b}</li>)}
              </ul>
            ) : (
              <p className="mb-2 flex gap-1 text-xs text-success"><CheckCircle2 className="mt-px h-3 w-3" />No blockers: verified in the sandbox, no open blocking findings.</p>
            )}
            {!c.canDecide && <p className="mb-2 text-xs text-text-muted">Accepting requires the admin role. You can reject.</p>}
            {c.requiresApproval && c.canDecide && c.blockers.length === 0 && (
              <label className="mb-2 flex items-start gap-1.5 text-xs"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" data-testid="confirm-risk" />I reviewed the diff and evidence of this higher-risk change and approve applying it to the project.</label>
            )}
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (required for a revision request)" aria-label="Decision note" className="input mb-2 h-7 text-xs" />
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => onAction("accept", { confirmHighRisk: confirm, note })} disabled={!!busy || !c.canDecide || c.blockers.length > 0 || (c.requiresApproval && !confirm)} className="btn-primary btn-sm" data-testid="accept-change">
                {busy === "accept" ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Accept &amp; apply
              </button>
              <button onClick={() => onAction("reject", { note })} disabled={!!busy} className="btn-ghost btn-sm"><XCircle className="h-3 w-3" /> Reject</button>
              <button onClick={() => onAction("revise", { note })} disabled={!!busy || !c.canDecide || note.trim().length < 5 || !c.missionId} className="btn-ghost btn-sm" title="Rejects this change and starts a new mission with your note; it waits for plan approval">Request revision</button>
            </div>
          </>
        ) : c.status === "ACCEPTED" ? (
          c.current?.matchesProposed ? (
            <button onClick={() => onAction("revert")} disabled={!!busy || !c.canDecide} className="btn-secondary btn-sm" data-testid="revert-change"><RotateCcw className="h-3 w-3" /> Revert (restores r{c.baseRev} content as a new revision)</button>
          ) : (
            <p className="flex gap-1 text-xs text-text-muted"><AlertTriangle className="mt-px h-3 w-3 shrink-0" />The file changed after this was applied; reverting would undo later work. Edit the file instead.</p>
          )
        ) : (
          <p className="text-xs text-text-muted">{c.status === "CONFLICT" ? "The file changed after the agent started, so this change cannot be applied safely. Reject it, or start a new mission on the current revision." : "No further action."}</p>
        )}
      </section>

      <section>
        <h3 className="metric-label mb-1">History</h3>
        <ol className="space-y-0.5 text-xs" data-testid="change-history">
          {c.history.map((h, i) => (
            <li key={i} className="flex gap-2"><span className="mono w-14 shrink-0 text-2xs text-text-faint">{timeAgo(h.at)}</span><span className={cn("min-w-0", /conflict|reject/.test(h.change) && "text-warning")}>{h.change} <span className="text-text-faint">· {h.actor}</span></span></li>
          ))}
        </ol>
      </section>
    </div>
  );
}
