/**
 * Product experience rubric (V17) — pure functions, no I/O.
 *
 * Raw observations from the inspectors (browser, axe-core, static source,
 * journeys) become findings with a dimension, severity, confidence, impact
 * and recommendation; findings are fingerprinted (dedupe across audits),
 * prioritised transparently, and summarised into METRICS whose formula and
 * data source are stated. There is deliberately no single opaque "UX score":
 * a broken critical journey is reported as a critical failure no matter how
 * many other checks pass.
 */

export const DIMENSIONS = ["task_completion", "clarity", "interaction", "accessibility", "responsive", "consistency", "feedback"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** confirmed = observed in a real run; likely = strong static/automated signal; hypothesis = heuristic about clarity, needs user evidence. */
export type Confidence = "confirmed" | "likely" | "hypothesis";
export type Method = "browser" | "axe" | "static" | "journey";

export interface Observation {
  rule: string;
  method: Method;
  route: string;
  viewport?: string;
  target?: string;
  detail: string;
  files?: string[];
  evidence: { kind: string; ref: string; detail: string }[];
  /** axe impact (minor | moderate | serious | critical) when method = axe. */
  axeImpact?: string;
  journey?: string;
  requirements?: string[];
  /** The journey this belongs to is critical (core user outcome). */
  critical?: boolean;
}

export interface Finding extends Required<Pick<Observation, "rule" | "method" | "route" | "detail" | "evidence">> {
  fingerprint: string;
  dimension: Dimension;
  title: string;
  viewport: string;
  target: string;
  files: string[];
  requirements: string[];
  journey: string;
  severity: Severity;
  confidence: Confidence;
  impact: string;
  recommendation: string;
  manualCheck: boolean;
}

interface RuleDef { dimension: Dimension; title: string; severity: Severity; confidence: Confidence; impact: string; fix: string; manual?: boolean }

/** The rule catalogue: every rule a finding can come from, with its rationale. Unknown axe rules map via axeRule(). */
export const RULES: Record<string, RuleDef> = {
  "journey:failed": { dimension: "task_completion", title: "User journey cannot be completed", severity: "high", confidence: "confirmed", impact: "users cannot reach the intended outcome", fix: "fix the failing step (see the observed vs expected evidence) and re-run the journey" },
  "journey:not_run": { dimension: "task_completion", title: "User journey could not be verified", severity: "medium", confidence: "likely", impact: "the outcome is unverified — it may or may not work", fix: "add a usable entry point (form/controls) for the journey or a JSON API to verify against" },
  "page:load_failed": { dimension: "task_completion", title: "Page does not load", severity: "critical", confidence: "confirmed", impact: "the page is unusable", fix: "fix the server/route error shown in the evidence" },
  "page:error": { dimension: "feedback", title: "Uncaught script error on the page", severity: "high", confidence: "confirmed", impact: "features on the page may silently stop working", fix: "fix the script error shown in the evidence" },
  "page:console_error": { dimension: "feedback", title: "Console errors while using the page", severity: "medium", confidence: "confirmed", impact: "often signals broken behaviour the user cannot see", fix: "fix the logged error" },
  "page:request_failed": { dimension: "feedback", title: "Failed request while loading the page", severity: "high", confidence: "confirmed", impact: "data or assets the page needs are missing", fix: "fix the failing endpoint or the client call" },
  "nav:broken_link": { dimension: "task_completion", title: "Navigation link leads to a missing page", severity: "high", confidence: "confirmed", impact: "users following the link hit a dead end", fix: "point the link at an existing route or create the page" },
  "control:inert": { dimension: "interaction", title: "Visible button does nothing when clicked", severity: "high", confidence: "confirmed", impact: "users press it and nothing happens", fix: "wire the button to its action, or remove it" },
  "form:no_submit": { dimension: "task_completion", title: "Form cannot be submitted", severity: "high", confidence: "confirmed", impact: "users cannot complete the form", fix: "add a submit control and a submit handler" },
  "form:no_validation_feedback": { dimension: "feedback", title: "Invalid input gives no feedback", severity: "medium", confidence: "confirmed", impact: "users do not learn what to correct", fix: "show an actionable, programmatically associated error message (aria-describedby / role=alert) next to the field" },
  "form:success_not_reflected": { dimension: "feedback", title: "Successful save is not reflected in the interface", severity: "high", confidence: "confirmed", impact: "users think the action failed and retry (duplicates) or give up", fix: "refresh the affected view after a successful response" },
  "form:error_not_recoverable": { dimension: "feedback", title: "Server error leaves the user without a way forward", severity: "high", confidence: "confirmed", impact: "users are stuck after a failure", fix: "show the error and keep the user's input so they can retry" },
  "state:loading_stuck": { dimension: "feedback", title: "Loading state never resolves", severity: "high", confidence: "confirmed", impact: "the page looks busy forever", fix: "resolve the loading indicator on success and on failure" },
  "a11y:keyboard_unreachable": { dimension: "accessibility", title: "Control cannot be reached with the keyboard", severity: "high", confidence: "confirmed", impact: "keyboard and switch users cannot operate it (WCAG 2.1.1)", fix: "use a native button/link or add tabindex=0 + key handlers" },
  "a11y:focus_not_visible": { dimension: "accessibility", title: "Keyboard focus is not visible", severity: "medium", confidence: "likely", impact: "keyboard users lose track of where they are (WCAG 2.4.7)", fix: "keep or add a visible :focus-visible style", manual: true },
  "a11y:reduced_motion_ignored": { dimension: "accessibility", title: "Animations ignore prefers-reduced-motion", severity: "low", confidence: "likely", impact: "motion-sensitive users get animation they asked not to see (WCAG 2.3.3)", fix: "wrap animations/transitions in @media (prefers-reduced-motion: no-preference)" },
  "a11y:heading_order": { dimension: "accessibility", title: "Heading structure is missing or skips levels", severity: "low", confidence: "likely", impact: "screen-reader users navigate by headings", fix: "use one h1 and nested heading levels" },
  "responsive:overflow": { dimension: "responsive", title: "Page scrolls horizontally", severity: "high", confidence: "confirmed", impact: "content is cut off or needs sideways scrolling", fix: "constrain the overflowing element (max-width:100%, wrapping, responsive layout)" },
  "responsive:small_target": { dimension: "responsive", title: "Touch targets too small", severity: "medium", confidence: "confirmed", impact: "hard to tap accurately on touch screens (WCAG 2.5.8: 24×24 CSS px)", fix: "make interactive targets at least 24×24 px (44×44 recommended)" },
  "responsive:clipped_text": { dimension: "responsive", title: "Text is clipped", severity: "medium", confidence: "likely", impact: "users cannot read the full content", fix: "allow wrapping or remove fixed heights/overflow:hidden on text containers" },
  "clarity:ambiguous_label": { dimension: "clarity", title: "Ambiguous control label", severity: "low", confidence: "hypothesis", impact: "users may not know what the control does (hypothesis — no user research)", fix: "name the action and its object (e.g. 'Save expense' instead of 'Submit')" },
  "clarity:no_primary_action": { dimension: "clarity", title: "No visible primary action on the start page", severity: "low", confidence: "hypothesis", impact: "users may not know where to start (hypothesis)", fix: "make the main task's call to action visible above the fold" },
  "consistency:style_conflict": { dimension: "consistency", title: "Inconsistent visual styles for the same component", severity: "low", confidence: "likely", impact: "the interface feels unpredictable", fix: "use one shared style/token for this component" },
  "consistency:hardcoded_colors": { dimension: "consistency", title: "Many one-off colour values instead of shared tokens", severity: "low", confidence: "likely", impact: "inconsistent colours and harder theming", fix: "define CSS custom properties and reuse them" },
  "feedback:no_empty_state": { dimension: "feedback", title: "Empty list shows nothing", severity: "low", confidence: "likely", impact: "a new user sees a blank area with no guidance", fix: "show an empty-state message explaining what to do first" },
};

const AXE_SEVERITY: Record<string, Severity> = { critical: "high", serious: "high", moderate: "medium", minor: "low" };

/** Map an axe-core rule to the rubric; axe results are automated checks — never proof of full WCAG compliance. */
export function axeRule(id: string, impact: string | undefined, help: string): RuleDef {
  const contrast = id === "color-contrast" || id === "color-contrast-enhanced";
  return {
    dimension: "accessibility",
    title: `Accessibility: ${help}`,
    severity: AXE_SEVERITY[impact ?? ""] ?? "medium",
    confidence: contrast ? "likely" : "confirmed",
    impact: `axe-core rule ${id} (${impact ?? "unknown"} impact) — automated check, WCAG 2.2 AA informed`,
    fix: `see https://dequeuniversity.com/rules/axe/4.10/${id}`,
    manual: contrast || /aria|label|name/.test(id),
  };
}

export function fingerprint(o: Pick<Observation, "rule" | "route" | "target" | "journey">) {
  const tgt = (o.target ?? "").replace(/\s+/g, " ").replace(/[0-9a-f]{8,}/gi, "#").slice(0, 120);
  return `${o.rule}|${o.journey ?? ""}|${o.route}|${tgt}`;
}

/** Observation → finding. Viewports are merged by the caller (one finding per rule/route/target). */
export function toFinding(o: Observation, axe?: { help: string }): Finding {
  const def = o.method === "axe" ? axeRule(o.rule.replace(/^axe:/, ""), o.axeImpact, axe?.help ?? o.rule) : RULES[o.rule];
  if (!def) throw new Error(`unknown experience rule ${o.rule}`);
  // A failure on a critical journey (core outcome) is always critical.
  const severity: Severity = o.critical && def.dimension === "task_completion" && def.severity !== "medium" ? "critical" : def.severity;
  return {
    fingerprint: fingerprint(o),
    rule: o.rule, method: o.method, route: o.route, detail: o.detail.slice(0, 1500), evidence: o.evidence.slice(0, 8),
    dimension: def.dimension, title: def.title, viewport: o.viewport ?? "", target: (o.target ?? "").slice(0, 300),
    files: o.files ?? [], requirements: o.requirements ?? [], journey: o.journey ?? "",
    severity, confidence: def.confidence, impact: def.impact, recommendation: def.fix, manualCheck: !!def.manual,
  };
}

/** Merge findings that differ only by viewport (keeps every viewport in the evidence). */
export function mergeFindings(fs: Finding[]): Finding[] {
  const by = new Map<string, Finding>();
  for (const f of fs) {
    const prev = by.get(f.fingerprint);
    if (!prev) by.set(f.fingerprint, { ...f });
    else {
      prev.viewport = [...new Set([...prev.viewport.split(","), ...f.viewport.split(",")].filter(Boolean))].join(",");
      prev.evidence = [...prev.evidence, ...f.evidence].slice(0, 8);
      if (SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(prev.severity)) prev.severity = f.severity;
    }
  }
  return [...by.values()];
}

// ---------------------------------------------------------------------------
// Prioritisation (transparent; stored with its reasons)
// ---------------------------------------------------------------------------

const SEV_W: Record<Severity, number> = { critical: 40, high: 25, medium: 12, low: 4 };
const CONF_W: Record<Confidence, number> = { confirmed: 10, likely: 5, hypothesis: 0 };

export function priorityOf(f: Pick<Finding, "severity" | "confidence" | "dimension" | "journey" | "requirements" | "files">, ctx: { sharedFiles?: string[]; sensitive?: boolean } = {}) {
  const why: string[] = [`+${SEV_W[f.severity]} severity ${f.severity}`, `+${CONF_W[f.confidence]} confidence ${f.confidence}`];
  let score = SEV_W[f.severity] + CONF_W[f.confidence];
  if (f.journey) { score += 10; why.push("+10 on a user journey"); }
  if (f.requirements.length) { score += 5; why.push(`+5 traced to ${f.requirements.join(", ")}`); }
  if (f.dimension === "task_completion") { score += 8; why.push("+8 blocks task completion"); }
  const shared = f.files.filter((x) => ctx.sharedFiles?.includes(x));
  if (shared.length) { score -= 4; why.push(`-4 touches shared component(s) ${shared.join(", ")} (wider regression risk)`); }
  if (ctx.sensitive) { score -= 4; why.push("-4 sensitive flow (needs stronger verification)"); }
  return { score, why };
}

/**
 * Risk-aware remediation policy: what may happen automatically.
 *  - "auto": low-risk, well-understood (confirmed/likely, not sensitive, not navigation/IA)
 *  - "approval": sensitive flow (auth/payments/privacy), shared component, or IA change
 *  - "recommend": hypothesis-level evidence — present, never auto-change
 */
export function remediationPolicy(f: { confidence: string; rule: string; files: string[]; route: string; title: string; detail: string }, ctx: { sharedFiles?: string[] } = {}) {
  const text = `${f.title} ${f.detail} ${f.route} ${f.files.join(" ")}`;
  if (f.confidence === "hypothesis") return { mode: "recommend" as const, why: "hypothesis-level evidence (no user research): recommendation only" };
  if (/\b(auth|login|sign[- ]?in|password|session|token|payment|billing|checkout|privacy|personal data|admin|role)\b/i.test(text)) return { mode: "approval" as const, why: "sensitive flow: change needs approval and stronger verification" };
  if (f.rule.startsWith("nav:") || /navigation|menu|information architecture/i.test(f.title)) return { mode: "approval" as const, why: "navigation / information-architecture change: proposed with rationale, needs approval" };
  if (f.files.some((x) => ctx.sharedFiles?.includes(x))) return { mode: "approval" as const, why: "shared component: impact analysis + broader regression testing, needs approval" };
  return { mode: "auto" as const, why: "low-risk, evidence-backed, localised fix" };
}

// ---------------------------------------------------------------------------
// Metrics (formula + source; no invented numbers)
// ---------------------------------------------------------------------------

export interface Metric { id: string; label: string; value: number | null; of: number | null; source: string; formula: string }

export function scoreAudit(a: {
  journeys: { status: "passed" | "failed" | "not_run"; critical: boolean; requirements: string[] }[];
  findings: Pick<Finding, "severity" | "dimension" | "rule" | "method" | "confidence">[];
  forms: { total: number; withValidationFeedback: number; withRecovery: number };
  browserRan: boolean;
  requirementsTotal: number;
}): { metrics: Metric[]; criticalFailures: string[]; verdict: "blocked" | "issues" | "no_blocking_issues" | "unverified" } {
  const j = a.journeys;
  const crit = j.filter((x) => x.critical);
  const by = (pred: (f: (typeof a.findings)[number]) => boolean) => a.findings.filter(pred).length;
  const verifiedReqs = new Set(j.filter((x) => x.status === "passed").flatMap((x) => x.requirements));
  const metrics: Metric[] = [
    { id: "critical_journeys", label: "Critical journeys passing", value: a.browserRan ? crit.filter((x) => x.status === "passed").length : null, of: crit.length, source: "journey runs in real Chromium", formula: "passed critical journeys / critical journeys (null = browser not run)" },
    { id: "journeys", label: "All journeys passing", value: a.browserRan ? j.filter((x) => x.status === "passed").length : null, of: j.length, source: "journey runs", formula: "passed / defined; not_run counts as not passing" },
    { id: "broken_controls", label: "Broken interactive controls", value: a.browserRan ? by((f) => f.rule === "control:inert" || f.rule === "form:no_submit" || f.rule === "nav:broken_link") : null, of: null, source: "clicks + link checks in the browser", formula: "count of inert buttons, unsubmittable forms, broken links" },
    { id: "high_usability", label: "Open high/critical usability findings", value: by((f) => f.dimension !== "accessibility" && (f.severity === "high" || f.severity === "critical")), of: null, source: "all inspection methods", formula: "count" },
    { id: "a11y_serious", label: "Automated accessibility violations (serious/critical)", value: a.browserRan ? by((f) => f.method === "axe" && f.severity === "high") : null, of: null, source: "axe-core in the browser + keyboard checks", formula: "count of axe violations with serious/critical impact (automated only — not a compliance claim)" },
    { id: "a11y_total", label: "Automated accessibility violations (all)", value: a.browserRan ? by((f) => f.dimension === "accessibility") : null, of: null, source: "axe-core + keyboard/focus/heading/motion checks", formula: "count" },
    { id: "responsive_failures", label: "Responsive layout failures", value: a.browserRan ? by((f) => f.dimension === "responsive") : null, of: null, source: "per-viewport layout checks", formula: "count (overflow, clipped text, small touch targets)" },
    { id: "form_feedback", label: "Forms with validation feedback", value: a.browserRan ? a.forms.withValidationFeedback : null, of: a.forms.total, source: "invalid-submit probe on each form", formula: "forms that show an associated error after an invalid submit / forms" },
    { id: "requirements_e2e", label: "Requirements verified end-to-end", value: a.browserRan ? verifiedReqs.size : null, of: a.requirementsTotal, source: "requirements traced to passing journeys", formula: "distinct requirement ids on passing journeys / requirement ids in the brief" },
  ];
  const criticalFailures = [
    ...crit.filter((x) => x.status !== "passed").map((x) => `critical journey ${x.status === "failed" ? "failed" : "not verified"}`),
    ...a.findings.filter((f) => f.severity === "critical").map((f) => `${f.rule}`),
  ];
  const verdict = !a.browserRan ? "unverified" : criticalFailures.length ? "blocked" : a.findings.some((f) => f.severity === "high") ? "issues" : "no_blocking_issues";
  return { metrics, criticalFailures, verdict };
}

/** Compare with a baseline audit: regressions = high/critical fingerprints present now and absent (or fixed) before. */
export function regressionsAgainst(now: { fingerprint: string; severity: Severity }[], baseline: Set<string> | null) {
  if (!baseline) return [];
  return now.filter((f) => (f.severity === "high" || f.severity === "critical") && !baseline.has(f.fingerprint)).map((f) => f.fingerprint);
}

// ---------------------------------------------------------------------------
// Journeys from requirements (reuse the brief + backlog, no second source of truth)
// ---------------------------------------------------------------------------

export interface JourneySpec { id: string; name: string; requirements: string[]; critical: boolean; steps: string[]; kind: "create_persist" | "validation" | "navigation" | "load" }

/**
 * Derive verifiable journeys from the product brief (journeys, functional
 * requirements, acceptance) and the app's real API. Each journey names the
 * requirement ids it covers so results trace back to the brief.
 */
export function journeysFrom(brief: { journeys?: { name: string; steps: string[] }[]; functional?: { id: string; text: string }[]; acceptance?: { id: string; text: string }[]; coreJourney?: string } | null, app: { collections: string[]; pages: string[] }): JourneySpec[] {
  const out: JourneySpec[] = [];
  const reqs = [...(brief?.functional ?? []), ...(brief?.acceptance ?? [])];
  const match = (re: RegExp) => reqs.filter((r) => re.test(r.text)).map((r) => r.id);
  out.push({ id: "load", name: "Start page loads and is usable", requirements: [], critical: true, steps: ["open /", "page renders without errors"], kind: "load" });
  for (const c of app.collections) {
    const noun = c.replace(/^\/api\//, "").replace(/s$/, "");
    const re = new RegExp(`\\b(add|create|record|log|submit|enter|save|new)\\b.*\\b${noun}`, "i");
    const rq = match(re);
    const bj = brief?.journeys?.find((x) => new RegExp(noun, "i").test(`${x.name} ${x.steps.join(" ")}`));
    out.push({ id: `create:${c}`, name: bj ? bj.name : `Create a ${noun} and see it saved`, requirements: rq.length ? rq : match(new RegExp(noun, "i")), critical: true, steps: ["fill the form with valid values", "submit", `the new ${noun} is shown immediately`, "reload: it is still there"], kind: "create_persist" });
    out.push({ id: `validate:${c}`, name: `Invalid ${noun} input is explained`, requirements: match(/\b(valid|reject|required|error)/i), critical: false, steps: ["submit the form empty", "an actionable error is shown", "nothing invalid is saved"], kind: "validation" });
  }
  if (app.pages.length > 1) out.push({ id: "nav", name: "Every navigation link leads to a page", requirements: [], critical: false, steps: ["collect same-origin links", "each returns a page"], kind: "navigation" });
  return out;
}
