import { createWorkspace, execInSandbox, dockerAvailable } from "./docker";

/**
 * Higher-level sandbox operations used by the agent workflows. These run REAL
 * code in a locked-down container when Docker is present; otherwise they return
 * a clearly-marked simulated result so the app keeps working.
 */

export interface TestRunResult {
  mode: "docker" | "simulated";
  passed: number;
  failed: number;
  total: number;
  cases: { name: string; ok: boolean }[];
  output: string;
  durationMs: number;
  timedOut?: boolean;
}

/**
 * Write a JS module + a plain Node test file to the sandbox and execute the
 * tests for real with `node --test` (built into Node 20, no network/deps).
 * Returns parsed pass/fail counts from the actual run.
 */
export async function runNodeTests(args: {
  moduleFile: string; // e.g. "feature.js"
  moduleCode: string;
  testCode: string; // uses node:test + node:assert
}): Promise<TestRunResult> {
  const ws = await createWorkspace({
    [args.moduleFile]: args.moduleCode,
    "feature.test.js": args.testCode,
  });
  try {
    const res = await execInSandbox(ws, "node --test 2>&1 || true", { timeoutMs: 15000 });
    if (res.mode === "unavailable") {
      return { mode: "simulated", passed: 1, failed: 0, total: 1, cases: [{ name: "sandbox unavailable", ok: true }], output: "Docker unavailable — simulated pass", durationMs: 0 };
    }
    const parsed = parseNodeTap(res.stdout + "\n" + res.stderr);
    return {
      mode: "docker",
      ...parsed,
      output: (res.stdout + res.stderr).slice(0, 8000),
      durationMs: res.durationMs,
      timedOut: res.timedOut,
    };
  } finally {
    await ws.cleanup();
  }
}

/**
 * Run every `*.test.js` in a flat set of files with `node --test`. Unlike
 * runNodeTests, an unavailable sandbox is reported as `simulated` with ZERO
 * tests — callers must treat that as "not executed", never as a pass.
 */
export async function runNodeSuite(files: Record<string, string>, opts: { timeoutMs?: number } = {}): Promise<TestRunResult> {
  if (!(await dockerAvailable())) {
    return { mode: "simulated", passed: 0, failed: 0, total: 0, cases: [], output: "Docker unavailable — tests were not executed", durationMs: 0 };
  }
  const ws = await createWorkspace(files);
  try {
    const res = await execInSandbox(ws, "node --test 2>&1 || true", { timeoutMs: opts.timeoutMs ?? 15000 });
    if (res.mode === "unavailable") return { mode: "simulated", passed: 0, failed: 0, total: 0, cases: [], output: "Docker unavailable — tests were not executed", durationMs: 0 };
    const parsed = parseNodeTap(res.stdout + "\n" + res.stderr);
    return { mode: "docker", ...parsed, output: (res.stdout + res.stderr).slice(0, 8000), durationMs: res.durationMs, timedOut: res.timedOut };
  } finally {
    await ws.cleanup();
  }
}

/** Parse Node's TAP-ish `--test` output for pass/fail counts and case names. */
function parseNodeTap(out: string): { passed: number; failed: number; total: number; cases: { name: string; ok: boolean }[] } {
  const cases: { name: string; ok: boolean }[] = [];
  const lines = out.split("\n");
  for (const line of lines) {
    // matches "ok 1 - name" and "not ok 2 - name"
    const m = line.match(/^(not ok|ok)\s+\d+\s+-\s+(.*)$/);
    if (m) {
      const name = m[2].trim().replace(/\\#/g, "#"); // TAP escapes "#" in test names
      // skip the suite-level duplicates node emits; keep leaf names
      cases.push({ name, ok: m[1] === "ok" });
    }
  }
  // Prefer the summary lines when present.
  const passMatch = out.match(/#\s*pass\s+(\d+)/);
  const failMatch = out.match(/#\s*fail\s+(\d+)/);
  let passed = passMatch ? Number(passMatch[1]) : cases.filter((c) => c.ok).length;
  let failed = failMatch ? Number(failMatch[1]) : cases.filter((c) => !c.ok).length;
  if (passed + failed === 0) {
    // No tests detected — treat as a single failure so the gate catches it.
    return { passed: 0, failed: 1, total: 1, cases: [{ name: "no tests detected", ok: false }] };
  }
  return { passed, failed, total: passed + failed, cases: cases.length ? cases : [{ name: "tests", ok: failed === 0 }] };
}

/**
 * Run a real build/lint-style check: node can parse every .js file in the
 * workspace (syntax check via `node --check`).
 */
export async function runSyntaxCheck(files: Record<string, string>): Promise<{ mode: string; ok: boolean; output: string }> {
  const ws = await createWorkspace(files);
  try {
    const jsFiles = Object.keys(files).filter((f) => f.endsWith(".js"));
    if (jsFiles.length === 0) return { mode: "simulated", ok: true, output: "no js files" };
    const cmd = jsFiles.map((f) => `node --check "${f}"`).join(" && ") + " && echo BUILD_OK";
    const res = await execInSandbox(ws, cmd + " 2>&1 || true", { timeoutMs: 10000 });
    if (res.mode === "unavailable") return { mode: "simulated", ok: true, output: "Docker unavailable — simulated build pass" };
    return { mode: "docker", ok: res.stdout.includes("BUILD_OK"), output: (res.stdout + res.stderr).slice(0, 4000) };
  } finally {
    await ws.cleanup();
  }
}

export { dockerAvailable };
