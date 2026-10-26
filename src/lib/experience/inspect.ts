/**
 * Experience inspectors (V17). Two sources, combined by the audit service:
 *
 *  - staticInspect(files): source-level checks that need no runtime
 *    (reduced-motion, colour tokens, focus-style removal, empty-state
 *    handling, ambiguous labels). Confidence ≤ "likely"; never "confirmed".
 *  - browserInspect(base, …): a REAL Chromium session against the app running
 *    in AURA's isolated container (src/lib/builder/browser.ts). Per route ×
 *    viewport: axe-core (injected from the installed axe-core package),
 *    keyboard reachability + visible focus, touch-target size, overflow and
 *    clipped text, heading order; per form: an invalid-submit probe
 *    (validation feedback) and a server-error probe (recovery, via request
 *    interception — no real data is touched); every visible button outside a
 *    form is clicked in a fresh page and observed for any effect (DOM change,
 *    request, navigation, dialog); same-origin links are fetched; journeys
 *    derived from the brief are executed with step-level evidence.
 *
 * Nothing here decides "passed" without an observation. A journey that cannot
 * be attempted is "not_run" with the reason.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Observation, JourneySpec } from "./rubric";

// ---------------------------------------------------------------------------
// Static inspection
// ---------------------------------------------------------------------------

export function staticInspect(files: Record<string, string>): Observation[] {
  const out: Observation[] = [];
  const css = Object.entries(files).filter(([p]) => /\.(css|scss)$/.test(p));
  const ui = Object.entries(files).filter(([p]) => /^public\/.*\.(html|js)$|\.(jsx|tsx)$/.test(p));
  for (const [p, c] of css) {
    const animates = /\b(animation|transition)\s*:/.test(c) && !/@keyframes\s+\w+\s*\{\s*\}/.test(c);
    if (animates && !/prefers-reduced-motion/.test(c)) out.push({ rule: "a11y:reduced_motion_ignored", method: "static", route: "", target: p, files: [p], detail: `${p} defines animations/transitions without a prefers-reduced-motion query`, evidence: [{ kind: "code", ref: p, detail: (c.match(/.{0,40}\b(animation|transition)\s*:[^;]*/) ?? [""])[0].trim().slice(0, 160) }] });
    if (/outline\s*:\s*(none|0)\b/.test(c) && !/:focus-visible/.test(c)) out.push({ rule: "a11y:focus_not_visible", method: "static", route: "", target: p, files: [p], detail: `${p} removes the focus outline and defines no :focus-visible replacement`, evidence: [{ kind: "code", ref: p, detail: (c.match(/[^{}]*\{[^}]*outline\s*:\s*(none|0)[^}]*\}/) ?? [""])[0].trim().slice(0, 200) }] });
    const colours = new Set((c.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? []).map((x) => x.toLowerCase()));
    if (colours.size >= 12 && !/--[a-z0-9-]+\s*:/.test(c)) out.push({ rule: "consistency:hardcoded_colors", method: "static", route: "", target: p, files: [p], detail: `${colours.size} distinct literal colour values and no CSS custom properties in ${p}`, evidence: [{ kind: "code", ref: p, detail: [...colours].slice(0, 8).join(" ") }] });
  }
  for (const [p, c] of ui) {
    for (const m of c.matchAll(/<button[^>]*>\s*(Submit|OK|Go|Click here|Button|Do it)\s*<\/button>/gi)) out.push({ rule: "clarity:ambiguous_label", method: "static", route: "", target: `button "${m[1]}"`, files: [p], detail: `button labelled "${m[1]}" does not name its action (hypothesis, no user research)`, evidence: [{ kind: "code", ref: p, detail: m[0].slice(0, 160) }] });
    // A list rendered from an array with no empty branch: `.map(` into innerHTML without any length check.
    if (/\.innerHTML\s*=\s*\w+\.map\(/.test(c) && !/\.length\s*(===|==|<|>|\?)|empty|nothing yet|no \w+ yet/i.test(c)) out.push({ rule: "feedback:no_empty_state", method: "static", route: "", target: p, files: [p], detail: `${p} renders a list with .map() and has no empty-state branch`, evidence: [{ kind: "code", ref: p, detail: (c.match(/.{0,30}\.innerHTML\s*=\s*\w+\.map\([^)]*\)/) ?? [""])[0].slice(0, 160) }] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Browser inspection (real Chromium)
// ---------------------------------------------------------------------------

type Page = any; // playwright-core Page (optional runtime dependency; typed loosely like browser.ts)
type Browser = { newContext: (o: object) => Promise<any> };

let axeSource: string | null = null;
async function axeScript() {
  if (axeSource) return axeSource;
  const req = createRequire(join(process.cwd(), "package.json"));
  axeSource = await readFile(req.resolve("axe-core/axe.min.js"), "utf8");
  return axeSource;
}

export interface BrowserInspection {
  observations: Observation[];
  routes: { route: string; viewport: string; httpStatus: number | null; screenshot: string | null }[];
  journeys: { id: string; name: string; requirements: string[]; critical: boolean; status: "passed" | "failed" | "not_run"; steps: { action: string; expect: string; observed: string; ok: boolean | null }[]; detail: string }[];
  forms: { total: number; withValidationFeedback: number; withRecovery: number };
  axe: "ran" | string;
}

export interface Viewport { name: string; width: number; height: number }
export const DEFAULT_VIEWPORTS: Viewport[] = [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }];

/** Project breakpoints when declared (CSS media queries) → one viewport just below each, capped; else the defaults. */
export function viewportsFor(files: Record<string, string>): Viewport[] {
  const bps = new Set<number>();
  for (const [p, c] of Object.entries(files)) if (/\.css$/.test(p)) for (const m of c.matchAll(/@media[^{]*\((?:max|min)-width:\s*(\d+)px\)/g)) bps.add(Number(m[1]));
  const sizes = [...bps].filter((n) => n >= 320 && n <= 1600).sort((a, b) => a - b);
  if (!sizes.length) return DEFAULT_VIEWPORTS;
  const vps: Viewport[] = [{ name: "mobile", width: 390, height: 844 }];
  for (const s of sizes.slice(0, 2)) if (s - 1 > 420) vps.push({ name: `bp-${s}`, width: s - 1, height: 900 });
  vps.push({ name: "desktop", width: 1280, height: 800 });
  return vps;
}

function pageAudit() {
  // Runs IN the page. Returns raw observations; classification happens server-side.
  const visible = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const sel = (el: Element) => { const h = el as HTMLElement; if (h.id) return `#${h.id}`; const t = el.tagName.toLowerCase(); const tid = el.getAttribute("data-testid"); if (tid) return `${t}[data-testid=${tid}]`; const txt = (h.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30); return txt ? `${t} "${txt}"` : t; };
  const d = document.documentElement;
  const overflow = d.scrollWidth - window.innerWidth;
  const interactive = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [onclick]")].filter(visible);
  const small = interactive.filter((el) => { const r = el.getBoundingClientRect(); return (r.width < 24 || r.height < 24) && !(el as HTMLInputElement).type?.match?.(/checkbox|radio/) && !el.closest("p, li") ; }).map(sel).slice(0, 6);
  // A placeholder is not a label (it disappears while typing; WCAG 3.3.2): fields need a <label>, aria-label or aria-labelledby.
  const unlabeled = [...document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea")].filter(visible).filter((el) => { const id = el.getAttribute("id"); return !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (id && document.querySelector(`label[for="${id}"]`)) || el.closest("label")); }).map(sel).slice(0, 6);
  const unreachable = [...document.querySelectorAll("[onclick], [role=button], div[data-action], span[data-action]")].filter(visible).filter((el) => !["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && (el as HTMLElement).tabIndex < 0).map(sel).slice(0, 6);
  const clipped = [...document.querySelectorAll("h1,h2,h3,p,li,label,button,a,td,th,span")].filter(visible).filter((el) => { const h = el as HTMLElement; const s = getComputedStyle(h); return (s.overflow === "hidden" || s.textOverflow === "ellipsis" || s.overflowX === "hidden") && h.scrollWidth > h.clientWidth + 2 && (h.innerText || "").trim().length > 0; }).map(sel).slice(0, 6);
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible).map((h) => Number(h.tagName[1]));
  const h1 = headings.filter((n) => n === 1).length;
  let skip = "";
  for (let i = 1; i < headings.length; i++) if (headings[i] - headings[i - 1] > 1) { skip = `h${headings[i - 1]} → h${headings[i]}`; break; }
  const loaders = [...document.querySelectorAll("[aria-busy=true], .loading, .spinner, [data-loading]")].filter(visible).map(sel).slice(0, 4);
  const forms = document.querySelectorAll("form").length;
  const buttons = [...document.querySelectorAll("button")].filter(visible).filter((b) => !b.closest("form") && b.type !== "submit" && !(b as HTMLButtonElement).disabled).map((b, i) => ({ i, label: sel(b) }));
  const links = [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href).filter((h) => h.startsWith(location.origin) && !h.includes("#")).slice(0, 25);
  const primary = interactive.some((el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && (el.tagName === "BUTTON" || el.getAttribute("type") === "submit" || el.getAttribute("role") === "button" || el.tagName === "A"); });
  return { overflow, small, unreachable, unlabeled, clipped, h1, skip, loaders, forms, buttons, links, primary };
}

async function focusVisible(page: Page) {
  // Tab through the first controls; a focused element with no outline/box-shadow/border change has no visible focus.
  const bad: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const visibleRing = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== "none");
      return { sel: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30)}"`, ok: !!visibleRing };
    }).catch(() => null);
    if (r && !r.ok && !bad.includes(r.sel)) bad.push(r.sel);
  }
  return bad;
}

export async function browserInspect(args: {
  browser: Browser; base: string; pages: string[]; viewports: Viewport[]; journeys: JourneySpec[]; collections: string[]; evidenceDir: string; signal?: AbortSignal;
  files: Record<string, string>;
}): Promise<BrowserInspection> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(args.evidenceDir, { recursive: true });
  const obs: Observation[] = [];
  const routes: BrowserInspection["routes"] = [];
  const own = (u: string) => u.startsWith(args.base) && !u.endsWith("/favicon.ico");
  const fileFor = (route: string) => (route === "/" ? "public/index.html" : `public${route}`);
  let axeState: BrowserInspection["axe"] = "ran";
  const axe = await axeScript().catch((e) => { axeState = `unavailable: axe-core not installed (${(e as Error).message.slice(0, 80)})`; return null; });
  const forms = { total: 0, withValidationFeedback: 0, withRecovery: 0 };
  const seenLinks = new Set<string>();
  const firstButtons: { route: string; buttons: { i: number; label: string }[] }[] = [];
  const widest = [...args.viewports].sort((x, y) => y.width - x.width)[0];

  for (const vp of args.viewports) {
    const ctx = await args.browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: "reduce" });
    for (const route of args.pages) {
      if (args.signal?.aborted) throw new Error("cancelled");
      const page = await ctx.newPage();
      const errors: string[] = [], consoleErrors: string[] = [], failed: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      page.on("console", (m: { type: () => string; text: () => string; location: () => { url?: string } }) => m.type() === "error" && !(m.location()?.url ?? "").endsWith("/favicon.ico") && consoleErrors.push(m.text()));
      page.on("response", (res: { url: () => string; status: () => number }) => own(res.url()) && res.status() >= 400 && failed.push(`${res.status()} ${res.url().slice(args.base.length)}`));
      let status: number | null = null;
      try {
        status = (await page.goto(`${args.base}${route}`, { waitUntil: "networkidle", timeout: 15_000 }))?.status() ?? null;
      } catch (e) {
        obs.push({ rule: "page:load_failed", method: "browser", route, viewport: vp.name, detail: (e as Error).message.slice(0, 300), files: [fileFor(route)], evidence: [{ kind: "browser", ref: `${route}@${vp.name}`, detail: "navigation failed" }] });
      }
      if (status !== null && status >= 400) obs.push({ rule: "page:load_failed", method: "browser", route, viewport: vp.name, detail: `HTTP ${status}`, files: [fileFor(route)], evidence: [{ kind: "http", ref: `GET ${route}`, detail: String(status) }] });
      await page.waitForTimeout(300);
      const a = await page.evaluate(pageAudit).catch(() => null);
      if (errors.length) obs.push({ rule: "page:error", method: "browser", route, viewport: vp.name, detail: errors.slice(0, 3).join(" | "), files: [fileFor(route)], evidence: [{ kind: "pageerror", ref: route, detail: errors[0].slice(0, 300) }] });
      if (consoleErrors.length) obs.push({ rule: "page:console_error", method: "browser", route, viewport: vp.name, detail: consoleErrors.slice(0, 3).join(" | "), evidence: [{ kind: "console", ref: route, detail: consoleErrors[0].slice(0, 300) }] });
      if (failed.length) obs.push({ rule: "page:request_failed", method: "browser", route, viewport: vp.name, detail: [...new Set(failed)].slice(0, 5).join(", "), evidence: [{ kind: "network", ref: route, detail: failed[0] }] });
      if (a) {
        if (a.overflow > 4) obs.push({ rule: "responsive:overflow", method: "browser", route, viewport: vp.name, detail: `document is ${a.overflow}px wider than the ${vp.width}px viewport`, evidence: [{ kind: "layout", ref: `${route}@${vp.name}`, detail: `scrollWidth − innerWidth = ${a.overflow}px` }] });
        if (a.small.length && vp.width < 800) obs.push({ rule: "responsive:small_target", method: "browser", route, viewport: vp.name, target: a.small[0], detail: `targets smaller than 24×24 px: ${a.small.join(", ")}`, evidence: [{ kind: "layout", ref: `${route}@${vp.name}`, detail: a.small.join(", ") }] });
        if (a.clipped.length) obs.push({ rule: "responsive:clipped_text", method: "browser", route, viewport: vp.name, target: a.clipped[0], detail: `clipped text: ${a.clipped.join(", ")}`, evidence: [{ kind: "layout", ref: `${route}@${vp.name}`, detail: a.clipped.join(", ") }] });
        if (a.unlabeled.length) obs.push({ rule: "a11y:unlabeled_field", method: "browser", route, viewport: vp.name, target: a.unlabeled[0], detail: `form fields without a label (a placeholder is not a label): ${a.unlabeled.join(", ")}`, files: [fileFor(route)], evidence: [{ kind: "dom", ref: route, detail: a.unlabeled.join(", ") }] });
        for (const u of a.unreachable) obs.push({ rule: "a11y:keyboard_unreachable", method: "browser", route, viewport: vp.name, target: u, detail: `${u} has a click handler but is not focusable`, files: [fileFor(route)], evidence: [{ kind: "dom", ref: route, detail: `${u}: tabIndex < 0, not a native control` }] });
        if (vp === widest) {
          if (a.h1 !== 1 || a.skip) obs.push({ rule: "a11y:heading_order", method: "browser", route, viewport: vp.name, detail: a.h1 !== 1 ? `${a.h1} h1 element(s) on the page` : `heading level skipped: ${a.skip}`, files: [fileFor(route)], evidence: [{ kind: "dom", ref: route, detail: a.h1 !== 1 ? `h1 count ${a.h1}` : a.skip }] });
          if (!a.primary && route === "/") obs.push({ rule: "clarity:no_primary_action", method: "browser", route, viewport: vp.name, detail: "no button or link is visible in the first viewport", evidence: [{ kind: "layout", ref: route, detail: "no interactive element above the fold" }] });
          if (a.loaders.length) { await page.waitForTimeout(4000); const still = await page.evaluate(pageAudit).catch(() => null); if (still?.loaders.length) obs.push({ rule: "state:loading_stuck", method: "browser", route, viewport: vp.name, target: still.loaders[0], detail: `loading indicator still visible after 4 s: ${still.loaders.join(", ")}`, evidence: [{ kind: "dom", ref: route, detail: still.loaders.join(", ") }] }); }
          for (const l of a.links) seenLinks.add(l);
          firstButtons.push({ route, buttons: a.buttons });
          // Keyboard focus visibility (desktop only).
          for (const s of await focusVisible(page)) obs.push({ rule: "a11y:focus_not_visible", method: "browser", route, viewport: vp.name, target: s, detail: `${s} shows no visible focus indicator when reached with Tab`, evidence: [{ kind: "keyboard", ref: route, detail: `Tab → ${s}: no outline / box-shadow` }] });
        }
      }
      if (axe) {
        try {
          await page.addScriptTag({ content: axe });
          const res = await page.evaluate(async () => {
            const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[]; failureSummary: string }[] }[] }> } }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
            return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target.join(" "), summary: (n.failureSummary || "").slice(0, 200) })) }));
          });
          for (const v of res) obs.push({ rule: `axe:${v.id}`, method: "axe", route, viewport: vp.name, target: v.nodes[0]?.target ?? "", axeImpact: v.impact, detail: `${v.help} — ${v.nodes.length} element(s): ${v.nodes.map((n: { target: string }) => n.target).join(", ")}`, files: [fileFor(route)], evidence: v.nodes.slice(0, 3).map((n: { target: string; summary: string }) => ({ kind: "axe", ref: n.target, detail: n.summary })), _help: v.help } as Observation & { _help: string });
        } catch (e) {
          axeState = `partial: ${(e as Error).message.slice(0, 120)}`;
        }
      }
      let shot: string | null = null;
      try {
        const file = join(args.evidenceDir, `${vp.name}${route === "/" ? "-index" : route.replace(/[^a-z0-9]+/gi, "-")}.png`);
        await writeFile(file, await page.screenshot({ fullPage: true }));
        shot = file;
      } catch { /* optional */ }
      routes.push({ route, viewport: vp.name, httpStatus: status, screenshot: shot });
      await page.close();
    }
    await ctx.close();
  }

  const desktop = widest;
  const ctx = await args.browser.newContext({ viewport: { width: desktop.width, height: desktop.height } });
  try {
    // Inert controls: click each visible non-form button in a fresh page, watch for any effect.
    for (const { route, buttons } of firstButtons) {
      for (const b of buttons.slice(0, 8)) {
        const page = await ctx.newPage();
        await page.goto(`${args.base}${route}`, { waitUntil: "networkidle", timeout: 15_000 }).catch(() => null);
        let effect = false;
        page.on("request", (r: { url: () => string }) => { if (own(r.url())) effect = true; });
        page.on("dialog", (d: { dismiss: () => Promise<void> }) => { effect = true; d.dismiss().catch(() => null); });
        const before = await page.evaluate(() => document.body.innerHTML.length + "|" + location.href + "|" + document.activeElement?.outerHTML.length).catch(() => "");
        const el = (await page.$$("button")).filter(Boolean);
        const target = await page.evaluateHandle((i: number) => [...document.querySelectorAll("button")].filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).filter((x) => !x.closest("form") && (x as HTMLButtonElement).type !== "submit" && !(x as HTMLButtonElement).disabled)[i], b.i);
        void el;
        try {
          await (target as { click: (o: object) => Promise<void> }).click({ timeout: 3000 });
          await page.waitForTimeout(500);
          const after = await page.evaluate(() => document.body.innerHTML.length + "|" + location.href + "|" + document.activeElement?.outerHTML.length).catch(() => "");
          const aria = await page.evaluate((i: number) => { const x = [...document.querySelectorAll("button")][i]; return x ? `${x.getAttribute("aria-expanded")}|${x.getAttribute("aria-pressed")}` : ""; }, b.i).catch(() => "");
          if (before.split("|").slice(0, 2).join("|") !== after.split("|").slice(0, 2).join("|") || aria.replace(/null/g, "").replace("|", "") !== "") effect = true;
          if (!effect) obs.push({ rule: "control:inert", method: "browser", route, viewport: desktop.name, target: b.label, detail: `clicking ${b.label} changed nothing: no DOM change, no request, no navigation, no dialog`, files: [fileFor(route), "public/app.js"], evidence: [{ kind: "click", ref: `${route} ${b.label}`, detail: "DOM length, URL and network unchanged 500 ms after click" }] });
        } catch { /* not clickable (covered/hidden) — not reported as inert */ }
        await page.close();
      }
    }
    // Broken links.
    for (const l of [...seenLinks].slice(0, 25)) {
      const r = await fetch(l, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!r || r.status >= 400) obs.push({ rule: "nav:broken_link", method: "browser", route: new URL(l).pathname, target: new URL(l).pathname, detail: `link to ${new URL(l).pathname} returns ${r?.status ?? "no response"}`, evidence: [{ kind: "http", ref: `GET ${new URL(l).pathname}`, detail: String(r?.status ?? "network error") }] });
    }
    // Forms: invalid submit → feedback? server error → recoverable?
    const fpage = await ctx.newPage();
    await fpage.goto(`${args.base}/`, { waitUntil: "networkidle", timeout: 15_000 }).catch(() => null);
    const formCount = await fpage.evaluate(() => document.querySelectorAll("form").length).catch(() => 0);
    await fpage.close();
    forms.total = formCount;
    for (let i = 0; i < Math.min(formCount, 3); i++) {
      const p = await ctx.newPage();
      const posted: string[] = [];
      p.on("request", (r: { method: () => string; url: () => string }) => r.method() !== "GET" && own(r.url()) && posted.push(r.url()));
      await p.goto(`${args.base}/`, { waitUntil: "networkidle", timeout: 15_000 }).catch(() => null);
      const label = await p.evaluate((n: number) => { const f = document.querySelectorAll("form")[n] as HTMLFormElement; return f.id ? `form#${f.id}` : `form ${n + 1}`; }, i);
      const hasSubmit = await p.evaluate((n: number) => !!document.querySelectorAll("form")[n].querySelector("[type=submit], button:not([type])"), i);
      if (!hasSubmit) obs.push({ rule: "form:no_submit", method: "browser", route: "/", target: label, detail: `${label} has no submit control`, files: ["public/index.html"], evidence: [{ kind: "dom", ref: label, detail: "no [type=submit] or default button" }] });
      // Invalid submit: clear all fields, submit, look for feedback (native validity UI counts only when the browser blocks submit AND a message is exposed).
      const fb = await p.evaluate(async (n: number) => {
        const f = document.querySelectorAll("form")[n] as HTMLFormElement;
        for (const el of [...f.querySelectorAll("input, textarea")] as HTMLInputElement[]) if (!["submit", "button", "checkbox", "radio", "hidden"].includes(el.type)) el.value = "";
        const native = !f.noValidate && !f.checkValidity();
        (f.querySelector("[type=submit], button:not([type])") as HTMLElement | null)?.click() ?? f.requestSubmit();
        await new Promise((r) => setTimeout(r, 700));
        const alerts = [...document.querySelectorAll("[role=alert], [aria-live], [aria-invalid=true], .error, .invalid")].filter((e) => (e as HTMLElement).innerText?.trim() || e.getAttribute("aria-invalid") === "true");
        const describedBy = [...f.querySelectorAll("[aria-describedby]")].some((e) => (document.getElementById(e.getAttribute("aria-describedby")!)?.innerText || "").trim());
        return { native, custom: alerts.length > 0 || describedBy, text: alerts.map((a) => (a as HTMLElement).innerText?.trim()).filter(Boolean).slice(0, 2).join(" | ") };
      }, i).catch(() => null);
      if (fb) {
        if (fb.native || fb.custom) forms.withValidationFeedback++;
        else obs.push({ rule: "form:no_validation_feedback", method: "browser", route: "/", target: label, detail: `submitting ${label} empty showed no error message${posted.length ? ` and sent ${posted.length} request(s) with invalid data` : ""}`, files: ["public/index.html", "public/app.js"], evidence: [{ kind: "interaction", ref: label, detail: `empty submit → no [role=alert]/aria-invalid/aria-describedby message; native validation ${fb.native ? "blocked" : "not used"}` }] });
      }
      await p.close();
      // Server failure: intercept the form's write with a 500 and check the user gets an error and keeps their input.
      const q = await ctx.newPage();
      await q.route(`${args.base}/api/**`, (r: { request: () => { method: () => string }; fulfill: (o: object) => Promise<void>; continue: () => Promise<void> }) => r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "simulated server failure (AURA recovery probe)" }) }));
      await q.goto(`${args.base}/`, { waitUntil: "networkidle", timeout: 15_000 }).catch(() => null);
      const marker = `aura-probe-${randomBytes(2).toString("hex")}`;
      const rec = await q.evaluate(async ({ n, m }: { n: number; m: string }) => {
        const f = document.querySelectorAll("form")[n] as HTMLFormElement;
        let textEl: HTMLInputElement | null = null;
        for (const el of [...f.querySelectorAll("input, select, textarea")] as HTMLInputElement[]) {
          if (["submit", "button", "hidden"].includes(el.type)) continue;
          if (el.tagName === "SELECT") { const o = [...(el as unknown as HTMLSelectElement).options].find((x) => x.value); if (o) el.value = o.value; }
          else if (el.type === "number") el.value = "12.5"; else if (el.type === "date") el.value = new Date().toISOString().slice(0, 10); else if (el.type === "email") el.value = "probe@example.com"; else if (el.type === "checkbox") el.checked = true;
          else if (!textEl) { el.value = m; textEl = el; } else el.value = "detail";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        (f.querySelector("[type=submit], button:not([type])") as HTMLElement | null)?.click() ?? f.requestSubmit();
        await new Promise((r) => setTimeout(r, 900));
        const msg = [...document.querySelectorAll("[role=alert], [aria-live], .error")].map((e) => (e as HTMLElement).innerText?.trim()).filter(Boolean).join(" | ");
        return { attempted: !!textEl, message: msg.slice(0, 200), kept: textEl ? (textEl as HTMLInputElement).value === m : false };
      }, { n: i, m: marker }).catch(() => null);
      if (rec?.attempted) {
        if (rec.message && rec.kept) forms.withRecovery++;
        else obs.push({ rule: "form:error_not_recoverable", method: "browser", route: "/", target: label, detail: `when the server fails, ${label} ${rec.message ? "shows an error but clears the user's input" : "shows no error message"}${!rec.kept && !rec.message ? " and loses the input" : ""}`, files: ["public/app.js"], evidence: [{ kind: "interaction", ref: label, detail: `write request answered 500 (intercepted, no data touched) → message: ${rec.message || "none"}; input kept: ${rec.kept}` }] });
      }
      await q.close();
    }
  } finally {
    await ctx.close();
  }
  const journeys = await runJourneys(args.browser, args.base, args.journeys, args.collections, own);
  for (const j of journeys) {
    if (j.status === "failed") obs.push({ rule: "journey:failed", method: "journey", route: "/", journey: j.id, critical: j.critical, requirements: j.requirements, detail: `${j.name}: ${j.detail}`, files: ["public/app.js", "public/index.html"], evidence: j.steps.filter((s) => s.ok === false).map((s) => ({ kind: "step", ref: s.action, detail: `expected ${s.expect}; observed ${s.observed}` })) });
    if (j.status === "not_run" && j.critical) obs.push({ rule: "journey:not_run", method: "journey", route: "/", journey: j.id, critical: false, requirements: j.requirements, detail: `${j.name}: ${j.detail}`, evidence: [{ kind: "journey", ref: j.id, detail: j.detail }] });
  }
  return { observations: obs, routes, journeys, forms, axe: axeState };
}

async function runJourneys(browser: Browser, base: string, specs: JourneySpec[], collections: string[], own: (u: string) => boolean): Promise<BrowserInspection["journeys"]> {
  const out: BrowserInspection["journeys"] = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    for (const s of specs) {
      const steps: BrowserInspection["journeys"][number]["steps"] = [];
      const done = (status: "passed" | "failed" | "not_run", detail: string) => out.push({ id: s.id, name: s.name, requirements: s.requirements, critical: s.critical, status, steps, detail });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      try {
        const resp = await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 15_000 });
        if (s.kind === "load") {
          const ok = !!resp && resp.status() < 400 && !errors.length;
          steps.push({ action: "open /", expect: "HTTP < 400, no script errors", observed: `HTTP ${resp?.status() ?? "none"}${errors.length ? `, error: ${errors[0].slice(0, 120)}` : ""}`, ok });
          done(ok ? "passed" : "failed", ok ? "start page loads without errors" : steps[0].observed);
          continue;
        }
        if (s.kind === "navigation") { done("not_run", "covered by the link check (see nav:broken_link findings)"); continue; }
        const coll = s.id.split(":")[1];
        const hasForm = await page.evaluate(() => !!document.querySelector("form"));
        if (!hasForm) { steps.push({ action: "find the form", expect: "a form on the start page", observed: "no form", ok: false }); done("failed", `no form to create a record through — the ${coll} API has no usable frontend entry point`); continue; }
        if (s.kind === "validation") {
          const before = await (await fetch(`${base}${coll}`).catch(() => null))?.json().catch(() => null);
          const fb = await page.evaluate(async () => {
            const f = document.querySelector("form") as HTMLFormElement;
            for (const el of [...f.querySelectorAll("input, textarea")] as HTMLInputElement[]) if (!["submit", "button", "checkbox", "radio", "hidden"].includes(el.type)) el.value = "";
            const native = !f.noValidate && !f.checkValidity();
            (f.querySelector("[type=submit], button:not([type])") as HTMLElement | null)?.click() ?? f.requestSubmit();
            await new Promise((r) => setTimeout(r, 700));
            const custom = [...document.querySelectorAll("[role=alert], [aria-live], [aria-invalid=true], .error")].some((e) => (e as HTMLElement).innerText?.trim() || e.getAttribute("aria-invalid") === "true");
            return { native, custom };
          });
          steps.push({ action: "submit the form empty", expect: "an error is shown (native validation or an associated message)", observed: fb.native ? "browser validation blocked the submit" : fb.custom ? "an error message was shown" : "no feedback", ok: fb.native || fb.custom });
          const after = await (await fetch(`${base}${coll}`).catch(() => null))?.json().catch(() => null);
          const saved = Array.isArray(before) && Array.isArray(after) ? after.length - before.length : null;
          steps.push({ action: `GET ${coll}`, expect: "no invalid record saved", observed: saved === null ? "could not read the collection" : `${saved} new record(s)`, ok: saved === null ? null : saved === 0 });
          const ok = steps.every((x) => x.ok !== false);
          done(ok ? "passed" : "failed", ok ? "invalid input is explained and nothing invalid is saved" : steps.filter((x) => x.ok === false).map((x) => `${x.action}: ${x.observed}`).join("; "));
          continue;
        }
        // create → shown immediately → persists
        const marker = `aura-journey-${randomBytes(3).toString("hex")}`;
        const filled = await page.evaluate((m: string) => {
          const f = document.querySelector("form")!;
          let t = false;
          for (const el of [...f.querySelectorAll("input, select, textarea")] as HTMLInputElement[]) {
            if (["hidden", "submit", "button"].includes(el.type)) continue;
            if (el.tagName === "SELECT") { const o = [...(el as unknown as HTMLSelectElement).options].find((x) => x.value); if (o) el.value = o.value; }
            else if (el.type === "number") el.value = "12.5"; else if (el.type === "date") el.value = new Date().toISOString().slice(0, 10); else if (el.type === "month") el.value = new Date().toISOString().slice(0, 7); else if (el.type === "email") el.value = "journey@example.com"; else if (el.type === "checkbox" || el.type === "radio") el.checked = true;
            else { el.value = t ? "detail" : m; t = true; }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return t;
        }, marker);
        steps.push({ action: "fill the form with valid values", expect: "a text field to identify the record", observed: filled ? `filled (marker ${marker})` : "no text field", ok: filled });
        if (!filled) { done("not_run", "the form has no text field to identify the created record"); continue; }
        const posted = page.waitForResponse((r: { url: () => string; request: () => { method: () => string } }) => r.request().method() === "POST" && own(r.url()) && r.url().includes(coll), { timeout: 8000 }).catch(() => null);
        await page.evaluate(() => { const f = document.querySelector("form")!; (f.querySelector("[type=submit], button:not([type])") as HTMLElement | null)?.click() ?? f.requestSubmit(); });
        const r = await posted;
        steps.push({ action: "submit", expect: `POST ${coll} succeeds`, observed: r ? `${r.status()}` : "no request sent", ok: !!r && r.status() < 400 });
        if (!r || r.status() >= 400) { done("failed", r ? `POST ${coll} returned ${r.status()}` : `submitting the form did not call ${coll}`); continue; }
        await page.waitForTimeout(600);
        const shown = (await page.content()).includes(marker);
        steps.push({ action: "look at the page", expect: "the new record is visible without reloading", observed: shown ? "visible" : "not visible", ok: shown });
        await page.reload({ waitUntil: "networkidle" });
        const kept = (await page.content()).includes(marker);
        steps.push({ action: "reload", expect: "the record is still listed", observed: kept ? "still listed" : "gone", ok: kept });
        done(shown && kept ? "passed" : "failed", shown && kept ? "created, shown immediately and persisted" : !shown && kept ? "saved, but the page did not show it until a reload (success not reflected)" : shown ? "shown but not persisted" : "never displayed");
        if (!shown && kept) out[out.length - 1].steps.push({ action: "diagnosis", expect: "", observed: "API stored the record; the view is not refreshed after a successful save", ok: false });
      } catch (e) {
        steps.push({ action: "run", expect: "journey completes", observed: (e as Error).message.slice(0, 200), ok: false });
        done("failed", (e as Error).message.slice(0, 200));
      } finally {
        await page.close();
      }
    }
  } finally {
    await ctx.close();
  }
  void collections;
  return out;
}
