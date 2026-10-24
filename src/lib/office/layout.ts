/**
 * The AURA office floor plan. Pure data, shared by the 3D scene, the 2D
 * fallback and the state mapper. Every location maps to a real AURA concept
 * (the task kinds or records that send an agent there) — none are decorative.
 *
 * Coordinates are grid cells: x ∈ [0, W), z ∈ [0, H). The back wall runs
 * along z = 0 and the left wall along x = 0; the camera looks from +x/+z.
 * A seat has an integer `cell` (path target, always walkable) and an exact
 * `pos` the character settles into after arriving.
 */

export const GRID_W = 28;
export const GRID_H = 18;

export type LocationId = "planning" | "design" | "engineering" | "collaboration" | "qa" | "security" | "deploy" | "lounge";
export type Pose = "sit" | "stand";

export interface Seat {
  id: string;
  cell: [number, number];
  pos: [number, number];
  /** Yaw in radians; 0 faces +z (toward the camera), π faces the back wall. */
  facing: number;
  pose: Pose;
}

export interface OfficeLocation {
  id: LocationId;
  label: string;
  /** What happens here, in AURA terms. */
  concept: string;
  /** Mission task kinds that bring an agent here while the task is running. */
  taskKinds: string[];
  /** Other records that are shown here. */
  records: string[];
  rect: [number, number, number, number]; // x0, z0, x1, z1 (inclusive cells)
  anchor: [number, number]; // label anchor (world x, z)
  seats: Seat[];
}

const N = Math.PI; // face the back wall
const S = 0; // face the camera
const E = Math.PI / 2; // face +x
const Wf = -Math.PI / 2; // face -x

export const LOCATIONS: OfficeLocation[] = [
  {
    id: "planning",
    label: "Planning",
    concept: "Requirements, architecture and the final mission report are worked out here.",
    taskKinds: ["REQUIREMENTS", "ANALYSIS", "ARCHITECTURE", "REPORT"],
    records: ["mission plans"],
    rect: [1, 1, 8, 6],
    anchor: [4.5, 1.2],
    seats: [
      { id: "planning-board-1", cell: [2, 1], pos: [2.5, 1.35], facing: N, pose: "stand" },
      { id: "planning-board-2", cell: [6, 1], pos: [6.5, 1.35], facing: N, pose: "stand" },
      { id: "planning-table-n", cell: [4, 2], pos: [5.0, 2.55], facing: S, pose: "stand" },
      { id: "planning-table-s", cell: [5, 4], pos: [5.0, 4.45], facing: N, pose: "stand" },
      { id: "planning-table-w", cell: [3, 3], pos: [3.55, 3.5], facing: E, pose: "stand" },
      { id: "planning-table-e", cell: [6, 3], pos: [6.45, 3.5], facing: Wf, pose: "stand" },
    ],
  },
  {
    id: "engineering",
    label: "Engineering desks",
    concept: "Code changes are made here, inside each task's declared write scope.",
    taskKinds: ["CODE_CHANGE"],
    records: ["file changes", "diffs"],
    rect: [10, 1, 21, 6],
    anchor: [15.5, 1.2],
    // Desks stand mid-room; engineers sit behind them facing the room (and the camera).
    seats: [10, 13, 16, 19].map((x, i) => ({ id: `desk-${i + 1}`, cell: [x, 2] as [number, number], pos: [x + 1, 2.45] as [number, number], facing: S, pose: "sit" as Pose })),
  },
  {
    id: "collaboration",
    label: "Collaboration table",
    concept: "Handoffs and independent code reviews: one agent's validated output becomes another's input.",
    taskKinds: ["REVIEW"],
    records: ["handoffs", "review findings"],
    rect: [10, 8, 16, 12],
    anchor: [13.5, 8.4],
    seats: [
      { id: "table-w", cell: [11, 10], pos: [11.85, 10.5], facing: E, pose: "sit" },
      { id: "table-e", cell: [15, 10], pos: [15.15, 10.5], facing: Wf, pose: "sit" },
      { id: "table-n", cell: [13, 8], pos: [13.5, 8.85], facing: S, pose: "sit" },
      { id: "table-s", cell: [13, 12], pos: [13.5, 12.15], facing: N, pose: "sit" },
    ],
  },
  {
    id: "design",
    label: "Design studio",
    concept: "User flows, page and component specs and design handoffs are drafted here and wait for your review.",
    taskKinds: [],
    records: ["design artifacts", "design handoffs"],
    rect: [17, 8, 20, 12],
    anchor: [18.5, 8.4],
    seats: [
      { id: "design-desk", cell: [18, 10], pos: [19.0, 10.45], facing: S, pose: "sit" },
      { id: "design-easel", cell: [17, 11], pos: [17.6, 11.5], facing: Wf, pose: "stand" },
      { id: "design-wall", cell: [20, 12], pos: [20.4, 12.4], facing: S, pose: "stand" },
    ],
  },
  {
    id: "qa",
    label: "QA lab",
    concept: "Tests are reproduced and re-run in the Docker sandbox; results decide, not descriptions.",
    taskKinds: ["REPRODUCE", "TEST"],
    records: ["test runs", "workspace checks"],
    rect: [22, 1, 27, 7],
    anchor: [24.5, 1.2],
    seats: [
      { id: "qa-bench-1", cell: [23, 2], pos: [23.5, 2.5], facing: S, pose: "stand" },
      { id: "qa-bench-2", cell: [25, 2], pos: [25.2, 2.5], facing: S, pose: "stand" },
      { id: "qa-rig", cell: [25, 5], pos: [25.4, 5.5], facing: E, pose: "stand" },
    ],
  },
  {
    id: "security",
    label: "Security corner",
    concept: "Deterministic security checks of trust boundaries on changed code; cyber-range work.",
    taskKinds: ["SECURITY_REVIEW"],
    records: ["security findings", "cyber-range incidents"],
    rect: [21, 10, 27, 17],
    anchor: [24.5, 10.4],
    seats: [
      { id: "sec-desk-1", cell: [23, 12], pos: [23.5, 12.35], facing: S, pose: "sit" },
      { id: "sec-desk-2", cell: [25, 12], pos: [25.5, 12.35], facing: S, pose: "sit" },
      { id: "sec-stand-1", cell: [22, 15], pos: [22.5, 15.5], facing: E, pose: "stand" },
      { id: "sec-stand-2", cell: [26, 15], pos: [26.5, 15.5], facing: Wf, pose: "stand" },
    ],
  },
  {
    id: "deploy",
    label: "Release station",
    concept: "Human approval gates and release readiness. Deployments here are AURA's simulated pipeline.",
    taskKinds: ["APPROVAL"],
    records: ["approvals", "deployments"],
    rect: [1, 10, 8, 17],
    anchor: [4.5, 10.4],
    seats: [
      { id: "deploy-console", cell: [4, 13], pos: [4.5, 13.6], facing: S, pose: "sit" },
      { id: "deploy-rack", cell: [3, 11], pos: [2.55, 11.5], facing: Wf, pose: "stand" },
      { id: "deploy-gate", cell: [6, 12], pos: [6.5, 12.5], facing: Wf, pose: "stand" },
    ],
  },
  {
    id: "lounge",
    label: "Lounge",
    concept: "Where agents with no assigned work wait. Idle is a real state, not a failure.",
    taskKinds: [],
    records: [],
    rect: [10, 14, 19, 17],
    anchor: [14.5, 14.2],
    seats: [
      { id: "sofa-1", cell: [12, 15], pos: [12.5, 15.3], facing: S, pose: "sit" },
      { id: "sofa-2", cell: [13, 15], pos: [13.5, 15.3], facing: S, pose: "sit" },
      { id: "sofa-3", cell: [14, 15], pos: [14.5, 15.3], facing: S, pose: "sit" },
      { id: "coffee", cell: [17, 16], pos: [17.45, 16.5], facing: E, pose: "stand" },
    ],
  },
];

export const LOCATION_BY_ID = Object.fromEntries(LOCATIONS.map((l) => [l.id, l])) as Record<LocationId, OfficeLocation>;

/** Furniture footprints (inclusive cell rects) that characters cannot walk through. */
export const OBSTACLES: [number, number, number, number][] = [
  [0, 0, GRID_W - 1, 0], // back wall
  [0, 0, 0, GRID_H - 1], // left wall
  [4, 3, 5, 3], // planning standing table
  [10, 3, 11, 3], [13, 3, 14, 3], [16, 3, 17, 3], [19, 3, 20, 3], // engineering desks
  [12, 9, 14, 11], // collaboration table
  [18, 11, 19, 11], // design drafting table
  [16, 11, 16, 11], // design easel
  [21, 1, 21, 5], // QA lab glass partition (door at z 6–7)
  [22, 3, 25, 3], // QA bench
  [26, 4, 26, 6], // QA test rig
  [21, 9, 24, 9], // security half wall
  [23, 13, 25, 13], // security desk
  [1, 9, 5, 9], // release half wall
  [1, 11, 1, 15], // server racks
  [3, 14, 5, 14], // release console
  [7, 15, 7, 16], // release pedestal
  [11, 14, 15, 14], // lounge sofa
  [12, 16, 13, 16], // coffee table
  [18, 16, 18, 17], // coffee machine
  [9, 16, 9, 17], // bookshelf
  [8, 7, 8, 7], // planter
  [20, 7, 20, 7], // planter
];

/** Home seat per agent key: where an agent waits when it has no running work. */
export const HOME: Record<string, string> = {
  "product-manager": "planning-table-n",
  architect: "planning-table-w",
  designer: "design-desk",
  ceo: "planning-table-e",
  "data-analyst": "planning-table-s",
  "frontend-engineer": "desk-1",
  "backend-engineer": "desk-2",
  reviewer: "desk-3",
  "qa-engineer": "qa-bench-1",
  "security-engineer": "sec-desk-1",
  "red-team": "sec-stand-1",
  "blue-team": "sec-stand-2",
  devops: "deploy-console",
  support: "sofa-1",
};

export const SEAT_BY_ID: Record<string, Seat & { location: LocationId }> = Object.fromEntries(
  LOCATIONS.flatMap((l) => l.seats.map((s) => [s.id, { ...s, location: l.id }])),
);

export function locationForTaskKind(kind: string): LocationId | null {
  return LOCATIONS.find((l) => l.taskKinds.includes(kind))?.id ?? null;
}

/** Walkable grid: true = walkable. Seats are always walkable. */
export function walkableGrid(): boolean[][] {
  const g = Array.from({ length: GRID_H }, () => new Array<boolean>(GRID_W).fill(true));
  for (const [x0, z0, x1, z1] of OBSTACLES) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) g[z][x] = false;
  return g;
}

/** Layout invariants, used by tests. */
export function validateLayout(): string[] {
  const errs: string[] = [];
  const g = walkableGrid();
  const ids = new Set<string>();
  for (const l of LOCATIONS)
    for (const s of l.seats) {
      if (ids.has(s.id)) errs.push(`duplicate seat ${s.id}`);
      ids.add(s.id);
      const [x, z] = s.cell;
      if (x < 0 || z < 0 || x >= GRID_W || z >= GRID_H) errs.push(`${s.id} outside grid`);
      else if (!g[z][x]) errs.push(`${s.id} cell blocked`);
    }
  for (const [k, seat] of Object.entries(HOME)) if (!SEAT_BY_ID[seat]) errs.push(`home of ${k} is unknown seat ${seat}`);
  return errs;
}
