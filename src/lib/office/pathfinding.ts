/**
 * Deterministic grid A* for office movement. 8-directional without corner
 * cutting (a diagonal step needs both orthogonal neighbours free), octile
 * heuristic, and a fixed tie-break order so the same request always yields
 * the same path. No randomness, no model calls.
 */

export type Cell = [number, number];

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

const octile = (ax: number, az: number, bx: number, bz: number) => {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
};

/**
 * Shortest path from `start` to `goal` (inclusive of both), or null when the
 * goal is unreachable. `grid[z][x] === true` means walkable. A blocked start
 * is tolerated (a character may be standing at a seat that overlaps furniture
 * art) — only the cells it moves *into* must be walkable.
 */
export function findPath(grid: boolean[][], start: Cell, goal: Cell): Cell[] | null {
  const H = grid.length;
  const W = grid[0]?.length ?? 0;
  const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < W && z < H;
  const [sx, sz] = start;
  const [gx, gz] = goal;
  if (!inside(sx, sz) || !inside(gx, gz) || !grid[gz][gx]) return null;
  if (sx === gx && sz === gz) return [[sx, sz]];

  const idx = (x: number, z: number) => z * W + x;
  const g = new Float64Array(W * H).fill(Infinity);
  const came = new Int32Array(W * H).fill(-1);
  const closed = new Uint8Array(W * H);
  // Small binary heap keyed by (f, h, insertion order) for deterministic ties.
  const heap: { f: number; h: number; n: number; i: number }[] = [];
  let counter = 0;
  const less = (a: (typeof heap)[0], b: (typeof heap)[0]) => a.f < b.f - 1e-9 || (Math.abs(a.f - b.f) <= 1e-9 && (a.h < b.h - 1e-9 || (Math.abs(a.h - b.h) <= 1e-9 && a.n < b.n)));
  const push = (e: (typeof heap)[0]) => {
    heap.push(e);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!less(heap[k], heap[p])) break;
      [heap[k], heap[p]] = [heap[p], heap[k]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === k) break;
        [heap[k], heap[m]] = [heap[m], heap[k]];
        k = m;
      }
    }
    return top;
  };

  const s = idx(sx, sz);
  g[s] = 0;
  push({ f: octile(sx, sz, gx, gz), h: octile(sx, sz, gx, gz), n: counter++, i: s });
  const goalI = idx(gx, gz);
  while (heap.length) {
    const cur = pop();
    if (closed[cur.i]) continue;
    closed[cur.i] = 1;
    if (cur.i === goalI) break;
    const cx = cur.i % W;
    const cz = (cur.i - cx) / W;
    for (const [dx, dz, cost] of DIRS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (!inside(nx, nz) || !grid[nz][nx]) continue;
      if (dx !== 0 && dz !== 0 && (!grid[cz][nx] || !grid[nz][cx])) continue; // no corner cutting
      const ni = idx(nx, nz);
      if (closed[ni]) continue;
      const ng = g[cur.i] + cost;
      if (ng < g[ni] - 1e-9) {
        g[ni] = ng;
        came[ni] = cur.i;
        const h = octile(nx, nz, gx, gz);
        push({ f: ng + h, h, n: counter++, i: ni });
      }
    }
  }
  if (!Number.isFinite(g[goalI])) return null;
  const path: Cell[] = [];
  for (let i = goalI; i !== -1; i = came[i]) path.push([i % W, Math.floor(i / W)]);
  return path.reverse();
}

/** Total length of a path in cells (diagonals count √2). */
export function pathLength(path: Cell[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return d;
}

/** Nearest walkable cell to (x, z) — used to recover a character placed on furniture. */
export function nearestWalkable(grid: boolean[][], x: number, z: number): Cell {
  const H = grid.length;
  const W = grid[0].length;
  const cx = Math.min(W - 1, Math.max(0, Math.round(x)));
  const cz = Math.min(H - 1, Math.max(0, Math.round(z)));
  if (grid[cz][cx]) return [cx, cz];
  for (let r = 1; r < Math.max(W, H); r++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx >= 0 && nz >= 0 && nx < W && nz < H && grid[nz][nx]) return [nx, nz];
      }
  return [cx, cz];
}
