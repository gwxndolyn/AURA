/**
 * Dependency graph helpers for mission plans. Pure functions.
 */

export interface GraphTask {
  key: string;
  dependsOn: string[];
  status: string;
  required?: boolean;
}

/** Returns the keys forming a cycle, or null when the graph is a DAG. Unknown deps are reported too. */
export function findCycle(tasks: GraphTask[]): string[] | null {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (const t of tasks) for (const d of t.dependsOn) if (!byKey.has(d)) return [t.key, `${d} (unknown)`];
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 on stack, 2 done
  const stack: string[] = [];
  const visit = (k: string): string[] | null => {
    state.set(k, 1);
    stack.push(k);
    for (const d of byKey.get(k)!.dependsOn) {
      const s = state.get(d) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (s === 0) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(k, 2);
    return null;
  };
  for (const t of tasks) if ((state.get(t.key) ?? 0) === 0) {
    const c = visit(t.key);
    if (c) return c;
  }
  return null;
}

/** Topological order (stable w.r.t. input order). Throws on cycles. */
export function topoOrder(tasks: GraphTask[]): string[] {
  const cycle = findCycle(tasks);
  if (cycle) throw new Error(`Plan has a dependency cycle: ${cycle.join(" → ")}`);
  const done = new Set<string>();
  const out: string[] = [];
  while (out.length < tasks.length) {
    for (const t of tasks) {
      if (done.has(t.key)) continue;
      if (t.dependsOn.every((d) => done.has(d))) {
        done.add(t.key);
        out.push(t.key);
      }
    }
  }
  return out;
}

/** Tasks whose dependencies have all SUCCEEDED and which are still PENDING. */
export function eligible(tasks: GraphTask[]): string[] {
  const status = new Map(tasks.map((t) => [t.key, t.status]));
  return tasks.filter((t) => t.status === "PENDING" && t.dependsOn.every((d) => status.get(d) === "SUCCEEDED")).map((t) => t.key);
}

/** Tasks that can never run because an upstream dependency FAILED or was SKIPPED. */
export function blockedByFailure(tasks: GraphTask[]): string[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const dead = new Set(tasks.filter((t) => t.status === "FAILED" || t.status === "SKIPPED").map((t) => t.key));
  const out: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (dead.has(t.key) || !["PENDING", "READY"].includes(t.status)) continue;
      if (t.dependsOn.some((d) => dead.has(d) || (byKey.get(d) && out.includes(d)))) {
        out.push(t.key);
        dead.add(t.key);
        changed = true;
      }
    }
  }
  return out;
}

/** Group tasks into dependency levels (for rendering a left-to-right plan graph). */
export function levels(tasks: GraphTask[]): string[][] {
  const order = topoOrder(tasks);
  const depth = new Map<string, number>();
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (const k of order) {
    const d = Math.max(-1, ...byKey.get(k)!.dependsOn.map((x) => depth.get(x) ?? 0));
    depth.set(k, d + 1);
  }
  const out: string[][] = [];
  for (const k of order) (out[depth.get(k)!] ??= []).push(k);
  return out;
}

/** Every task that transitively depends on `key` (not including `key`). */
export function descendants(tasks: GraphTask[], key: string): string[] {
  const out = new Set<string>();
  let frontier = [key];
  while (frontier.length) {
    const next: string[] = [];
    for (const t of tasks) if (!out.has(t.key) && t.dependsOn.some((d) => frontier.includes(d))) {
      out.add(t.key);
      next.push(t.key);
    }
    frontier = next;
  }
  return [...out];
}

/** Every task `key` transitively depends on. */
export function ancestors(tasks: GraphTask[], key: string): string[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const out = new Set<string>();
  const walk = (k: string) => {
    for (const d of byKey.get(k)?.dependsOn ?? []) if (!out.has(d)) {
      out.add(d);
      walk(d);
    }
  };
  walk(key);
  return [...out];
}
