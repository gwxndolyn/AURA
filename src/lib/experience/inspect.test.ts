/**
 * Experience inspection on REAL infrastructure: the fixture app runs in AURA's
 * isolated Docker container; real Chromium + axe-core inspect it. Skipped —
 * not faked — when Docker or Chromium is unavailable (the unavailable path is
 * tested in experience.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { browserAvailable, startIsolatedApp, launchChromium, routesFrom, collectionRoutes } from "@/lib/builder/browser";
import { buildIndex } from "@/lib/builder/intel";
import { browserInspect, staticInspect, viewportsFor } from "./inspect";
import { journeysFrom, toFinding, mergeFindings, scoreAudit } from "./rubric";
import { appFiles, BRIEF } from "../../../test/fixtures/experience-app";

let ok = false;
const dirs: string[] = [];
beforeAll(async () => { ok = (await browserAvailable()).ok; }, 30_000);
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tree(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "aura-xp-"));
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); }
  chmodSync(d, 0o755);
  return d;
}

async function inspect(files: Record<string, string>) {
  const dir = tree(files);
  const started = await startIsolatedApp({ treeDir: dir, id: `xptest${Date.now()}` });
  if (!("app" in started)) throw new Error(`app did not start: ${JSON.stringify(started)}`);
  const ch = await launchChromium();
  if (!("browser" in ch)) throw new Error(ch.unavailable);
  try {
    const index = await buildIndex(files);
    const collections = collectionRoutes(index.routes);
    const pages = routesFrom(Object.keys(files));
    const r = await browserInspect({ browser: ch.browser, base: started.app.base, pages, viewports: viewportsFor(files), journeys: journeysFrom(BRIEF, { collections, pages }), collections, evidenceDir: join(dir, "_evidence"), files });
    const findings = mergeFindings([...staticInspect(files), ...r.observations].map((o) => toFinding(o, { help: (o as { _help?: string })._help ?? o.rule })));
    return { r, findings, rules: new Set(findings.map((f) => f.rule)) };
  } finally {
    await ch.browser.close();
    await started.app.stop();
  }
}

describe("experience inspection (real Docker + Chromium + axe-core)", () => {
  it("finds the planted defects with evidence, and a critical journey failure stays visible in the score", async (c) => {
    if (!ok) return c.skip();
    const { r, findings, rules } = await inspect(appFiles(false));
    for (const rule of ["form:no_validation_feedback", "form:error_not_recoverable", "control:inert", "responsive:overflow", "nav:broken_link", "a11y:reduced_motion_ignored", "journey:failed"]) expect(rules, rule).toContain(rule);
    expect([...rules].some((x) => x.startsWith("axe:"))).toBe(true); // unlabeled input / contrast found by axe-core
    expect(rules.has("axe:color-contrast")).toBe(true);
    expect(rules).toContain("a11y:unlabeled_field"); // placeholder-only input
    const create = r.journeys.find((j) => j.id === "create:/api/notes")!;
    expect(create.status).toBe("failed");
    expect(create.detail).toMatch(/did not show it until a reload/);
    expect(create.requirements).toContain("FR-1"); // traced to the brief
    const jf = findings.find((f) => f.rule === "journey:failed" && f.journey === "create:/api/notes")!;
    expect(jf.severity).toBe("critical");
    expect(jf.evidence.length).toBeGreaterThan(0);
    const inert = findings.find((f) => f.rule === "control:inert")!;
    expect(inert.target).toMatch(/Export/);
    expect(inert.confidence).toBe("confirmed");
    const overflow = findings.find((f) => f.rule === "responsive:overflow")!;
    expect(overflow.viewport).toContain("mobile");
    expect(overflow.viewport).not.toContain("desktop");
    expect(r.routes.every((x) => x.screenshot)).toBe(true);
    const s = scoreAudit({ journeys: r.journeys, findings, forms: r.forms, browserRan: true, requirementsTotal: 3 });
    expect(s.verdict).toBe("blocked");
    expect(s.criticalFailures.length).toBeGreaterThan(0);
    expect(s.metrics.find((m) => m.id === "form_feedback")).toMatchObject({ value: 0, of: 1 });
  }, 180_000);

  it("the corrected app no longer shows those defects; the journeys pass with step evidence", async (c) => {
    if (!ok) return c.skip();
    const { r, rules } = await inspect(appFiles(true));
    for (const rule of ["form:no_validation_feedback", "form:error_not_recoverable", "control:inert", "responsive:overflow", "nav:broken_link", "a11y:reduced_motion_ignored", "journey:failed", "a11y:unlabeled_field", "axe:color-contrast"]) expect(rules, rule).not.toContain(rule);
    const create = r.journeys.find((j) => j.id === "create:/api/notes")!;
    expect(create.status).toBe("passed");
    expect(create.steps.map((s) => s.ok)).toEqual([true, true, true, true]);
    expect(r.journeys.find((j) => j.id === "validate:/api/notes")!.status).toBe("passed");
    expect(r.forms).toMatchObject({ total: 1, withValidationFeedback: 1, withRecovery: 1 });
  }, 180_000);
});
