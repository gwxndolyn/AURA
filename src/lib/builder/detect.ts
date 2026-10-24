/**
 * Verification plan for a working tree: which REAL commands prove the project
 * works. Derived from the files (package.json scripts, lockfiles, configs),
 * never from what an agent claims.
 */
export interface Check {
  id: "install" | "test" | "lint" | "typecheck" | "build" | "syntax";
  command: string;
  network: boolean; // install only
  required: boolean;
}

export function verificationPlan(files: Record<string, string>): { checks: Check[]; notes: string[] } {
  const notes: string[] = [];
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
  try {
    pkg = files["package.json"] ? JSON.parse(files["package.json"]) : null;
  } catch {
    notes.push("package.json is not valid JSON");
  }
  const checks: Check[] = [];
  if (!pkg) {
    notes.push("No package.json: only Node projects are executable in this version.");
    return { checks, notes };
  }
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  const pm = files["pnpm-lock.yaml"] !== undefined ? "pnpm" : files["yarn.lock"] !== undefined ? "yarn" : "npm";
  if (deps.length) {
    const cmd = pm === "npm" ? (files["package-lock.json"] !== undefined ? "npm ci --ignore-scripts --no-audit --no-fund" : "npm install --ignore-scripts --no-audit --no-fund") : pm === "yarn" ? "corepack yarn install --frozen-lockfile --ignore-scripts" : "corepack pnpm install --frozen-lockfile --ignore-scripts";
    checks.push({ id: "install", command: cmd, network: true, required: true });
  }
  const s = pkg.scripts ?? {};
  const runner = pm === "npm" ? "npm run" : `corepack ${pm} run`;
  if (s.test) checks.push({ id: "test", command: pm === "npm" ? "npm test --silent" : `${runner} test`, network: false, required: true });
  else notes.push("No test script: correctness cannot be verified until one exists.");
  if (s.lint) checks.push({ id: "lint", command: `${runner} lint`, network: false, required: true });
  if (s.typecheck) checks.push({ id: "typecheck", command: `${runner} typecheck`, network: false, required: true });
  else if (files["tsconfig.json"] !== undefined && deps.includes("typescript")) checks.push({ id: "typecheck", command: "npx --no-install tsc --noEmit", network: false, required: true });
  if (s.build) checks.push({ id: "build", command: `${runner} build`, network: false, required: true });
  if (s.check) checks.push({ id: "syntax", command: `${runner} check`, network: false, required: true });
  return { checks, notes };
}

/** Parse node:test / TAP style summaries into counts (best effort; exit code is authoritative). */
export function parseTestSummary(out: string) {
  const n = (re: RegExp) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  const tests = n(/^[#ℹ]\s*tests\s+(\d+)/m);
  const pass = n(/^[#ℹ]\s*pass\s+(\d+)/m);
  const fail = n(/^[#ℹ]\s*fail\s+(\d+)/m);
  // TAP ("not ok 2 - name") and the node:test spec reporter ("✖ name (1.2ms)"), de-duplicated.
  const tap = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  const spec = [...out.matchAll(/^\s*✖ (.+?) \(\d+(?:\.\d+)?m?s\)\s*$/gm)].map((m) => m[1].trim());
  const failing = [...new Set([...tap, ...spec])].slice(0, 30);
  return { tests, pass, fail, failing };
}
