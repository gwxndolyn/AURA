/**
 * Three.js renderer for the AURA office. Loaded with a dynamic import only on
 * pages that show the office, so `three` never enters the main bundle.
 *
 * The scene is a *view*: it receives VisualAgent[] (from lib/office/state.ts)
 * and animates toward it. It never decides what an agent is doing.
 *
 *   - Static environment: procedural voxel boxes merged into a handful of
 *     meshes (lit, glowing, glass) → a few draw calls.
 *   - Characters: chunky voxel rigs (shared unit box geometry, cached
 *     materials) with idle / walk / sit / type / test / review / point / talk /
 *     slump / hop poses.
 *   - Movement: deterministic A* paths over the layout's walkable grid.
 *   - Rendering pauses when the canvas is offscreen or the tab is hidden; pixel
 *     ratio is capped; reduced motion = instant moves and still poses.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { GRID_H, GRID_W, LOCATIONS, SEAT_BY_ID, walkableGrid, type LocationId } from "@/lib/office/layout";
import { findPath, nearestWalkable } from "@/lib/office/pathfinding";
import { characterFor, type CharacterSpec } from "@/lib/office/characters";
import type { Activity, OfficeInteraction, VisualAgent } from "@/lib/office/state";

export interface SceneCallbacks {
  onPickAgent: (key: string | null) => void;
  onPickLocation: (id: LocationId) => void;
  /** Screen-space positions for HTML labels (CSS px relative to the canvas). */
  onFrame?: (agents: Record<string, { x: number; y: number }>, locations: Record<string, { x: number; y: number }>) => void;
}

export const ACTIVITY_COLOR: Record<Activity, string> = {
  idle: "#8b8a85",
  planning: "#b79cf0",
  designing: "#f472b6",
  coding: "#c5f04a",
  reviewing: "#78a9ff",
  testing: "#4cc38a",
  blocked: "#ef5d5d",
  awaiting_approval: "#e5a13b",
  completed: "#4cc38a",
};

const ZONE_RUG: Record<LocationId, string> = {
  planning: "#cbbfdc",
  design: "#e6c6d6",
  engineering: "#bccbd8",
  collaboration: "#e0cba8",
  qa: "#bfd6c2",
  security: "#d6bfcb",
  deploy: "#d3cdbb",
  lounge: "#e3c2a6",
};

// ---------------------------------------------------------------------------
// Static environment builder (vertex-coloured boxes, merged)
// ---------------------------------------------------------------------------

class Builder {
  lit: THREE.BufferGeometry[] = [];
  glow: THREE.BufferGeometry[] = [];
  glass: THREE.BufferGeometry[] = [];
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, kind: "lit" | "glow" | "glass" = "lit") {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x + w / 2, y + h / 2, z + d / 2);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // subtle top-face lightening for a voxel "bevel" read
      const ny = g.attributes.normal.getY(i);
      const k = ny > 0.5 ? 1.06 : ny < -0.5 ? 0.8 : 0.94;
      arr[i * 3] = Math.min(1, c.r * k);
      arr[i * 3 + 1] = Math.min(1, c.g * k);
      arr[i * 3 + 2] = Math.min(1, c.b * k);
    }
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    (kind === "lit" ? this.lit : kind === "glow" ? this.glow : this.glass).push(g);
  }
  build(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const mk = (list: THREE.BufferGeometry[], mat: THREE.Material, shadows: boolean) => {
      if (!list.length) return;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = shadows;
      m.receiveShadow = shadows;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      out.push(m);
    };
    mk(this.lit, new THREE.MeshLambertMaterial({ vertexColors: true }), true);
    mk(this.glow, new THREE.MeshBasicMaterial({ vertexColors: true }), false);
    mk(this.glass, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.28, depthWrite: false }), false);
    return out;
  }
}

function plant(b: Builder, x: number, z: number, tall = false) {
  b.box(x + 0.25, 0, z + 0.25, 0.5, 0.36, 0.5, "#c46d4b");
  b.box(x + 0.22, 0.34, z + 0.22, 0.56, 0.06, 0.56, "#a85a3c");
  const h = tall ? 0.9 : 0.5;
  b.box(x + 0.2, 0.4, z + 0.2, 0.6, h * 0.55, 0.6, "#5f9e5a");
  b.box(x + 0.3, 0.4 + h * 0.5, z + 0.3, 0.4, h * 0.5, 0.4, "#77b46b");
  b.box(x + 0.14, 0.5, z + 0.4, 0.2, 0.25, 0.2, "#4f8a4b");
}

function chair(b: Builder, cx: number, cz: number, facing: number, color = "#3b3e47") {
  // seat centred on (cx, cz); backrest behind the sitter (opposite of facing dir)
  b.box(cx - 0.22, 0.2, cz - 0.22, 0.44, 0.07, 0.44, color);
  b.box(cx - 0.04, 0, cz - 0.04, 0.08, 0.2, 0.08, "#2a2c32");
  b.box(cx - 0.2, 0, cz - 0.2, 0.4, 0.03, 0.4, "#2a2c32");
  const bx = -Math.sin(facing) * 0.24;
  const bz = -Math.cos(facing) * 0.24;
  const alongX = Math.abs(Math.cos(facing)) > 0.5;
  if (alongX) b.box(cx - 0.22, 0.27, cz + bz - 0.04, 0.44, 0.38, 0.08, color);
  else b.box(cx + bx - 0.04, 0.27, cz - 0.22, 0.08, 0.38, 0.44, color);
}

/** Monitor; `side` = which z-face the screen is on (+1 faces +z, -1 faces -z). */
function monitor(b: Builder, x: number, y: number, z: number, screen: string, w = 0.62, side: 1 | -1 = 1) {
  b.box(x - 0.04, y, z - 0.06, 0.08, 0.16, 0.08, "#2a2c33");
  b.box(x - w / 2, y + 0.14, z - 0.05, w, 0.38, 0.05, "#26282f");
  b.box(x - w / 2 + 0.04, y + 0.18, side > 0 ? z : z - 0.06, w - 0.08, 0.3, 0.01, screen, "glow");
}

function codeLines(b: Builder, x: number, y: number, z: number, w: number, seed: number, side: 1 | -1 = 1) {
  const colors = ["#c5f04a", "#9fd8ff", "#f6c177", "#e6e1d6"];
  for (let i = 0; i < 4; i++) {
    const lw = 0.12 + (((seed * 7 + i * 13) % 10) / 10) * (w - 0.2);
    b.box(x - w / 2 + 0.07 + ((i * 3 + seed) % 2) * 0.04, y + 0.23 + i * 0.055, side > 0 ? z + 0.012 : z - 0.067, lw, 0.025, 0.005, colors[(i + seed) % colors.length], "glow");
  }
}

/** Laptop open toward -z (the sitter is on the -z side); the lid carries a sticker. */
function laptop(b: Builder, x: number, y: number, z: number, screen: string, sticker: string) {
  b.box(x - 0.24, y, z - 0.18, 0.48, 0.025, 0.32, "#b9bec7");
  b.box(x - 0.22, y + 0.025, z - 0.15, 0.44, 0.005, 0.2, "#3a3e46");
  b.box(x - 0.24, y + 0.02, z + 0.12, 0.48, 0.32, 0.03, "#b9bec7");
  b.box(x - 0.21, y + 0.05, z + 0.115, 0.42, 0.27, 0.005, screen, "glow");
  b.box(x - 0.06, y + 0.15, z + 0.15, 0.12, 0.1, 0.005, sticker);
}

function buildEnvironment(): { meshes: THREE.Object3D[]; leds: THREE.Mesh[] } {
  const b = new Builder();
  const W = GRID_W;
  const H = GRID_H;
  // Diorama base + planked floor
  b.box(-0.3, -0.5, -0.3, W + 0.6, 0.5, H + 0.6, "#3a2c24");
  b.box(-0.3, -0.06, -0.3, W + 0.6, 0.06, H + 0.6, "#5b4334");
  for (let z = 0; z < H; z++) {
    let x = 0;
    let k = z * 3;
    while (x < W) {
      const len = Math.min(W - x, 2 + ((k * 5) % 3));
      b.box(x + 0.01, 0, z + 0.01, len - 0.02, 0.02, 0.98, k % 2 ? "#c49b72" : "#bb926a");
      x += len;
      k++;
    }
  }
  // Zone rugs
  for (const l of LOCATIONS) {
    const [x0, z0, x1, z1] = l.rect;
    b.box(x0 + 0.15, 0.02, z0 + 0.15, x1 - x0 + 0.7, 0.025, z1 - z0 + 0.7, ZONE_RUG[l.id]);
    b.box(x0 + 0.3, 0.045, z0 + 0.3, x1 - x0 + 0.4, 0.004, 0.06, "#ffffff");
  }
  // Walls (back z=0, left x=0) with wainscot, skirting and windows
  b.box(0, 0, -0.35, W, 2.7, 0.35, "#e8dcc8");
  b.box(-0.35, 0, -0.35, 0.35, 2.7, H, "#e2d4bd");
  b.box(0, 0, -0.02, W, 0.9, 0.04, "#d5c4a8");
  b.box(-0.02, 0, 0, 0.04, 0.9, H, "#d0bea1");
  b.box(0, 2.7, -0.42, W, 0.12, 0.5, "#cbb894");
  b.box(-0.42, 2.7, -0.42, 0.5, 0.12, H + 0.1, "#c4b08c");
  for (const wx of [9, 12.4, 17.4]) {
    b.box(wx, 1.15, -0.03, 2.2, 1.2, 0.05, "#7a6a58");
    b.box(wx + 0.08, 1.23, 0.02, 2.04, 1.04, 0.01, "#cfe9f3", "glow");
    b.box(wx + 1.07, 1.23, 0.03, 0.06, 1.04, 0.02, "#7a6a58");
    b.box(wx - 0.05, 1.12, 0.02, 2.3, 0.06, 0.12, "#8a7864");
  }
  for (const wz of [7.6, 11.5]) {
    b.box(-0.03, 1.15, wz, 0.05, 1.2, 2.2, "#7a6a58");
    b.box(0.02, 1.23, wz + 0.08, 0.01, 1.04, 2.04, "#cfe9f3", "glow");
    b.box(0.03, 1.23, wz + 1.07, 0.02, 1.04, 0.06, "#7a6a58");
  }
  // AURA plaque on the back wall
  b.box(22.2, 1.95, -0.04, 3.6, 0.55, 0.06, "#1a1b1f");
  for (let i = 0; i < 4; i++) b.box(22.55 + i * 0.8, 2.07, 0.02, 0.5, 0.3, 0.02, ["#c5f04a", "#4cc38a", "#c5f04a", "#c5f04a"][i], "glow");

  // --- Planning: whiteboard, sticky notes, standing table, bookshelf
  b.box(1.4, 0.95, -0.03, 6.2, 1.45, 0.06, "#9aa0a8");
  b.box(1.5, 1.03, 0.03, 6.0, 1.29, 0.02, "#f7f6f2");
  const notes = ["#ffd166", "#f4a7c3", "#9ad1f5", "#b8e994", "#ffd166", "#f4a7c3"];
  for (let i = 0; i < 12; i++) b.box(1.7 + (i % 6) * 0.95, 1.15 + Math.floor(i / 6) * 0.48, 0.05, 0.34, 0.32, 0.02, notes[(i * 5) % notes.length]);
  for (let i = 0; i < 5; i++) b.box(1.75 + i * 1.15, 2.2, 0.05, 0.7, 0.03, 0.01, "#5b6b8a");
  b.box(4.1, 0, 3.1, 1.8, 0.95, 0.8, "#8a5a3b");
  b.box(4.0, 0.95, 3.0, 2.0, 0.07, 1.0, "#dcc7a5");
  b.box(4.4, 1.02, 3.3, 0.5, 0.02, 0.36, "#f7f6f2");
  b.box(5.15, 1.02, 3.35, 0.4, 0.02, 0.3, "#ffd166");
  plant(b, 1, 5, true);

  // --- Engineering: four desks mid-room, engineers face the room
  [10, 13, 16, 19].forEach((x, i) => {
    const z0 = 3.0;
    for (const [lx, lz] of [[0.05, 0.05], [1.87, 0.05], [0.05, 0.75], [1.87, 0.75]]) b.box(x + lx, 0, z0 + lz, 0.08, 0.62, 0.08, "#3d3f46");
    b.box(x, 0.62, z0, 2.0, 0.07, 0.88, "#dcc7a5");
    b.box(x + 0.1, 0.25, z0 + 0.78, 1.8, 0.37, 0.04, "#cdb894");
    const scr = ["#1b2a3a", "#1d2b25", "#2a2238", "#2b2a1d"][i];
    laptop(b, x + 1.0, 0.69, z0 + 0.32, scr, ["#c5f04a", "#f472b6", "#78a9ff", "#e5a13b"][i]);
    monitor(b, x + 1.6, 0.69, z0 + 0.55, scr, 0.42, -1);
    codeLines(b, x + 1.6, 0.69, z0 + 0.55, 0.42, i, -1);
    b.box(x + 0.18, 0.69, z0 + 0.25, 0.16, 0.18, 0.16, i % 2 ? "#e07a5f" : "#81b29a");
    b.box(x + 0.15, 0.69, z0 + 0.6, 0.3, 0.06, 0.2, ["#f4a7c3", "#9ad1f5", "#ffd166", "#b8e994"][i]);
    chair(b, x + 1, 2.45, 0);
  });
  // wall shelf + framed posters behind the desks
  b.box(10.2, 1.55, 0.0, 10.6, 0.06, 0.32, "#a9744f");
  for (let i = 0; i < 9; i++) b.box(10.5 + i * 1.15, 1.61, 0.06, 0.24 + (i % 3) * 0.06, 0.2 + (i % 2) * 0.1, 0.2, ["#d36b5a", "#5b8fd6", "#e6c540", "#4fa37a", "#9a7ad6"][i % 5]);

  // --- Collaboration table with chairs
  b.box(12.1, 0, 9.1, 0.12, 0.62, 0.12, "#5a3d2a");
  b.box(14.78, 0, 9.1, 0.12, 0.62, 0.12, "#5a3d2a");
  b.box(12.1, 0, 11.78, 0.12, 0.62, 0.12, "#5a3d2a");
  b.box(14.78, 0, 11.78, 0.12, 0.62, 0.12, "#5a3d2a");
  b.box(12.0, 0.62, 9.0, 3.0, 0.08, 3.0, "#a9744f");
  b.box(12.2, 0.7, 9.2, 2.6, 0.01, 2.6, "#b98560");
  b.box(13.1, 0.7, 10.2, 0.6, 0.03, 0.42, "#2c2e35");
  b.box(13.15, 0.73, 10.25, 0.5, 0.01, 0.32, "#9fd8ff", "glow");
  b.box(12.5, 0.7, 9.5, 0.36, 0.02, 0.26, "#f7f6f2");
  b.box(14.1, 0.7, 11.2, 0.12, 0.14, 0.12, "#f2efe8");
  chair(b, 11.85, 10.5, Math.PI / 2, "#6d5a8c");
  chair(b, 15.15, 10.5, -Math.PI / 2, "#6d5a8c");
  chair(b, 13.5, 8.85, 0, "#6d5a8c");
  chair(b, 13.5, 12.15, Math.PI, "#6d5a8c");

  // --- QA lab: glass partition, test bench facing the room, test rig
  b.box(21.05, 0, 0.0, 0.1, 2.2, 6.0, "#d8eef5", "glass");
  b.box(21.0, 0, 0.0, 0.2, 0.12, 6.0, "#9aa0a8");
  b.box(21.0, 2.2, 0.0, 0.2, 0.08, 6.0, "#9aa0a8");
  b.box(22.0, 0, 3.0, 4.0, 0.85, 0.9, "#e9eef0");
  b.box(21.95, 0.85, 2.95, 4.1, 0.06, 1.0, "#cfd8dc");
  for (let i = 0; i < 3; i++) {
    b.box(22.35 + i * 1.25, 0.91, 3.35, 0.7, 0.42, 0.42, "#3a3f47");
    b.box(22.41 + i * 1.25, 0.97, 3.34, 0.58, 0.3, 0.01, i === 1 ? "#3d2424" : "#1d3326", "glow");
    b.box(22.5 + i * 1.25, 1.05, 3.33, 0.3, 0.04, 0.005, i === 1 ? "#ef5d5d" : "#4cc38a", "glow");
  }
  for (let i = 0; i < 5; i++) b.box(22.2 + i * 0.75, 0.91, 3.85, 0.12, 0.2, 0.12, ["#9fe2bf", "#f6c177", "#9fd8ff", "#f4a7c3", "#b8e994"][i]);
  b.box(22.2, 1.2, 0.0, 4.6, 0.06, 0.3, "#cfd8dc");
  for (let i = 0; i < 6; i++) b.box(22.4 + i * 0.75, 1.26, 0.06, 0.3, 0.32, 0.2, i % 2 ? "#3a3f47" : "#6b7380");
  b.box(26.15, 0, 4.1, 0.75, 1.3, 2.8, "#6b7380");
  b.box(26.1, 1.3, 4.05, 0.85, 0.06, 2.9, "#4a515c");
  for (let i = 0; i < 4; i++) b.box(26.1, 0.25 + i * 0.26, 4.3, 0.02, 0.14, 2.4, "#3b414b");
  for (let i = 0; i < 3; i++) b.box(26.08, 1.0, 4.5 + i * 0.8, 0.02, 0.18, 0.5, "#9fe2bf", "glow");
  plant(b, 22, 6);

  // --- Security: half wall, desk with monitors, poster
  b.box(21.0, 0, 9.0, 4.0, 1.0, 0.3, "#d9cbb3");
  b.box(20.95, 1.0, 8.95, 4.1, 0.08, 0.4, "#bfae90");
  b.box(23.0, 0, 13.05, 3.0, 0.62, 0.9, "#3a3540");
  b.box(22.95, 0.62, 13.0, 3.1, 0.07, 1.0, "#4a4450");
  for (let i = 0; i < 3; i++) monitor(b, 23.5 + i * 1.0, 0.69, 13.6, "#2a1b26", 0.5, -1), codeLines(b, 23.5 + i * 1.0, 0.69, 13.6, 0.5, i + 5, -1);
  b.box(23.1, 0.25, 13.85, 2.8, 0.37, 0.04, "#2f2a35");
  chair(b, 23.5, 12.35, 0, "#5a3348");
  chair(b, 25.5, 12.35, 0, "#5a3348");
  plant(b, 26, 16, true);

  // --- Release station: half wall, racks, console, pedestal
  b.box(1.0, 0, 9.0, 5.0, 1.0, 0.3, "#d9cbb3");
  b.box(0.95, 1.0, 8.95, 5.1, 0.08, 0.4, "#bfae90");
  for (let i = 0; i < 5; i++) {
    b.box(1.05, 0, 11.05 + i, 0.9, 1.75, 0.9, "#2f333b");
    b.box(1.93, 0.1, 11.12 + i, 0.02, 1.55, 0.76, "#252830");
  }
  b.box(3.0, 0, 14.05, 3.0, 0.62, 0.9, "#4b5260");
  b.box(2.95, 0.62, 14.0, 3.1, 0.07, 1.0, "#5c6474");
  monitor(b, 4.5, 0.69, 14.55, "#1e2a24", 0.9, -1);
  b.box(4.1, 0.9, 14.48, 0.7, 0.04, 0.01, "#4cc38a", "glow");
  b.box(4.1, 0.98, 14.48, 0.5, 0.04, 0.01, "#4cc38a", "glow");
  b.box(4.1, 1.06, 14.48, 0.6, 0.04, 0.01, "#e5a13b", "glow");
  b.box(3.1, 0.25, 14.85, 2.8, 0.37, 0.04, "#434956");
  chair(b, 4.5, 13.6, 0, "#4b5260");
  b.box(7.1, 0, 15.1, 0.8, 0.5, 1.8, "#7d8696");
  b.box(7.25, 0.5, 15.6, 0.5, 0.42, 0.5, "#c88a4a");
  b.box(7.25, 0.68, 15.6, 0.5, 0.06, 0.5, "#e8c07e");
  b.box(7.3, 0.5, 16.3, 0.4, 0.3, 0.4, "#c88a4a");

  // --- Design studio: drafting table facing the room, swatches, mood board, easel
  const dz = 11.0;
  for (const [lx, lz] of [[0.1, 0.05], [1.8, 0.05], [0.1, 0.75], [1.8, 0.75]]) b.box(18 + lx, 0, dz + lz, 0.1, 0.7, 0.1, "#3d3f46");
  b.box(18.0, 0.7, dz, 2.0, 0.06, 0.9, "#f1ece4");
  b.box(18.2, 0.76, dz + 0.1, 0.8, 0.01, 0.55, "#ffffff");
  for (let i = 0; i < 3; i++) b.box(18.28 + i * 0.24, 0.77, dz + 0.18, 0.18, 0.005, 0.38, ["#e5e7eb", "#c7d2fe", "#fbcfe8"][i]);
  monitor(b, 19.45, 0.76, dz + 0.6, "#2a1f2b", 0.5, -1);
  b.box(19.26, 0.94, dz + 0.53, 0.2, 0.14, 0.005, "#f472b6", "glow");
  b.box(19.5, 0.94, dz + 0.53, 0.18, 0.06, 0.005, "#c5f04a", "glow");
  const sw = ["#f472b6", "#c5f04a", "#78a9ff", "#e5a13b", "#4cc38a", "#ecebe6"];
  for (let i = 0; i < 6; i++) b.box(18.2 + i * 0.27, 0.76, dz + 0.72, 0.2, 0.02, 0.12, sw[i]);
  chair(b, 19.0, 10.45, 0, "#b54a86");
  b.box(16.9, 0, 11.2, 0.06, 1.5, 0.06, "#8a5a3b");
  b.box(16.85, 0.7, 11.0, 0.08, 0.9, 1.0, "#f7f6f2");
  b.box(16.92, 0.85, 11.15, 0.02, 0.25, 0.3, "#fbcfe8");
  b.box(16.92, 0.85, 11.5, 0.02, 0.5, 0.35, "#c7d2fe");
  b.box(16.92, 1.2, 11.12, 0.02, 0.25, 0.33, "#fde68a");

  // --- Lounge: sofa, coffee table, machine, bookshelf, rug, lamp
  b.box(11.0, 0, 14.0, 5.0, 0.32, 0.95, "#c96f4f");
  b.box(11.0, 0.32, 14.0, 5.0, 0.5, 0.3, "#b8613f");
  b.box(10.85, 0, 14.0, 0.25, 0.55, 1.2, "#b8613f");
  b.box(15.9, 0, 14.0, 0.25, 0.55, 1.2, "#b8613f");
  for (let i = 0; i < 3; i++) b.box(11.25 + i * 1.55, 0.32, 14.3, 1.45, 0.1, 0.62, "#d77b59");
  b.box(12.1, 0, 16.1, 1.8, 0.3, 0.8, "#7a5236");
  b.box(12.05, 0.3, 16.05, 1.9, 0.05, 0.9, "#9b6b47");
  b.box(12.4, 0.35, 16.3, 0.16, 0.14, 0.16, "#f2efe8");
  b.box(13.2, 0.35, 16.25, 0.4, 0.04, 0.3, "#5b8fd6");
  b.box(18.1, 0, 16.1, 0.8, 0.9, 0.8, "#3f434b");
  b.box(18.15, 0.9, 16.15, 0.7, 0.4, 0.7, "#c9ccd2");
  b.box(18.3, 0.95, 16.82, 0.4, 0.15, 0.01, "#c5f04a", "glow");
  b.box(9.05, 0, 16.0, 0.9, 1.9, 1.9, "#8a5a3b");
  for (let s = 0; s < 4; s++) {
    b.box(9.0, 0.08 + s * 0.46, 16.0, 1.0, 0.05, 1.9, "#6e4529");
    for (let j = 0; j < 5; j++) b.box(9.15, 0.13 + s * 0.46, 16.1 + j * 0.34, 0.6, 0.3 + ((s + j) % 3) * 0.04, 0.26, ["#d36b5a", "#5b8fd6", "#e6c540", "#4fa37a", "#9a7ad6"][(s + j) % 5]);
  }
  b.box(16.6, 0, 14.4, 0.3, 0.05, 0.3, "#2f333a");
  b.box(16.7, 0.05, 14.5, 0.1, 1.3, 0.1, "#2f333a");
  b.box(16.45, 1.35, 14.25, 0.6, 0.35, 0.6, "#f6dca7", "glow");
  plant(b, 8, 7, true);
  plant(b, 20, 7, true);
  plant(b, 19, 14);

  const meshes = b.build();
  // Blinking LEDs (separate tiny meshes, animated)
  const leds: THREE.Mesh[] = [];
  const ledGeo = new THREE.BoxGeometry(0.06, 0.06, 0.02);
  const addLed = (x: number, y: number, z: number, color: string, rotY = 0) => {
    const m = new THREE.Mesh(ledGeo, new THREE.MeshBasicMaterial({ color }));
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    m.userData.base = new THREE.Color(color);
    m.userData.phase = leds.length * 1.37;
    leds.push(m);
  };
  for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) addLed(1.95, 0.35 + j * 0.35, 11.3 + i + (j % 2) * 0.3, j % 3 === 0 ? "#e5a13b" : "#4cc38a", Math.PI / 2);
  for (let i = 0; i < 4; i++) addLed(26.07, 0.32 + i * 0.26, 6.55, i % 2 ? "#4cc38a" : "#78a9ff", -Math.PI / 2);
  return { meshes: [...meshes, ...leds], leds };
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

const UNIT = new THREE.BoxGeometry(1, 1, 1);

class MatCache {
  private m = new Map<string, THREE.MeshLambertMaterial>();
  get(c: string) {
    let x = this.m.get(c);
    if (!x) {
      x = new THREE.MeshLambertMaterial({ color: c });
      this.m.set(c, x);
    }
    return x;
  }
  dispose() {
    for (const x of this.m.values()) x.dispose();
  }
}

function part(mats: MatCache, color: string, w: number, h: number, d: number, x: number, y: number, z: number, parent: THREE.Object3D) {
  const m = new THREE.Mesh(UNIT, mats.get(color));
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

interface Rig {
  root: THREE.Group; // world position + yaw
  body: THREE.Group; // bob / sit offset
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  ring: THREE.Mesh;
  hit: THREE.Mesh;
  hipY: number;
}

function hashPhase(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
}

function buildCharacter(spec: CharacterSpec, mats: MatCache, shadowTex: THREE.Texture): Rig {
  const s = 1.18 * spec.height;
  const bw = spec.build;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const has = (a: string) => spec.accessories.includes(a as never);

  // legs (pivot at hip)
  const hipY = 0.3 * s;
  const mkLeg = (x: number) => {
    const g = new THREE.Group();
    g.position.set(x, hipY, 0);
    part(mats, spec.bottom, 0.16 * s * bw, hipY - 0.06 * s, 0.17 * s, 0, -(hipY - 0.06 * s) / 2, 0, g);
    part(mats, spec.shoes, 0.18 * s * bw, 0.08 * s, 0.24 * s, 0, -hipY + 0.04 * s, 0.03 * s, g);
    body.add(g);
    return g;
  };
  const legL = mkLeg(-0.1 * s * bw);
  const legR = mkLeg(0.1 * s * bw);

  // torso
  const torso = new THREE.Group();
  torso.position.set(0, hipY, 0);
  body.add(torso);
  const tw = 0.42 * s * bw;
  const th = 0.4 * s;
  const td = 0.26 * s;
  part(mats, spec.top, tw, th, td, 0, th / 2, 0, torso);
  part(mats, spec.topAccent, tw * 0.3, th * 0.55, 0.01, 0, th * 0.6, td / 2 + 0.003, torso);
  if (has("labcoat")) part(mats, "#f7f7f4", tw * 1.08, th * 1.15, td * 1.06, 0, th * 0.45, 0, torso), part(mats, spec.topAccent, tw * 0.22, th * 0.8, 0.012, 0, th * 0.5, td * 0.53 + 0.003, torso);
  if (has("hood")) part(mats, spec.top, tw * 0.9, th * 0.28, td * 0.5, 0, th * 0.95, -td * 0.42, torso);
  if (has("scarf")) part(mats, "#e9c46a", tw * 0.86, th * 0.16, td * 1.1, 0, th * 0.92, 0, torso), part(mats, "#e9c46a", tw * 0.16, th * 0.45, 0.04, tw * 0.22, th * 0.6, td * 0.55, torso);
  if (has("tie")) part(mats, "#c94f4f", tw * 0.1, th * 0.6, 0.012, 0, th * 0.55, td / 2 + 0.006, torso);
  if (has("toolbelt")) part(mats, "#6b4a2f", tw * 1.04, th * 0.14, td * 1.08, 0, th * 0.08, 0, torso), part(mats, "#f2c230", 0.06 * s, 0.1 * s, 0.05 * s, tw * 0.38, 0.02, td * 0.5, torso);

  // arms (pivot at shoulder)
  const mkArm = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * (tw / 2 + 0.06 * s), th * 0.88, 0);
    const sleeve = has("labcoat") ? "#f7f7f4" : spec.top;
    part(mats, sleeve, 0.12 * s, 0.3 * s, 0.13 * s, 0, -0.15 * s, 0, g);
    part(mats, spec.skin, 0.11 * s, 0.09 * s, 0.11 * s, 0, -0.33 * s, 0, g);
    torso.add(g);
    return g;
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);
  if (has("clipboard")) part(mats, "#a8743f", 0.22 * s, 0.03 * s, 0.28 * s, 0, -0.36 * s, 0.12 * s, armL), part(mats, "#f7f6f2", 0.18 * s, 0.01 * s, 0.22 * s, 0, -0.34 * s, 0.12 * s, armL);
  if (has("tablet")) part(mats, "#2b2d33", 0.26 * s, 0.03 * s, 0.2 * s, 0, -0.37 * s, 0.1 * s, armL), part(mats, "#9fd8ff", 0.22 * s, 0.005 * s, 0.16 * s, 0, -0.35 * s, 0.1 * s, armL);
  if (has("pencil")) part(mats, "#f6d365", 0.04 * s, 0.04 * s, 0.26 * s, 0, -0.38 * s, 0.12 * s, armR);
  if (has("mug")) part(mats, "#f2efe8", 0.1 * s, 0.12 * s, 0.1 * s, 0, -0.4 * s, 0.05 * s, armR);

  // head
  const head = new THREE.Group();
  head.position.set(0, th + 0.01, 0);
  torso.add(head);
  const hs = 0.5 * s;
  part(mats, spec.skin, hs, hs * 0.92, hs * 0.9, 0, hs * 0.46, 0, head);
  // face
  const fz = hs * 0.45 + 0.003;
  part(mats, "#1b1b1f", hs * 0.11, hs * 0.16, 0.01, -hs * 0.2, hs * 0.48, fz, head);
  part(mats, "#1b1b1f", hs * 0.11, hs * 0.16, 0.01, hs * 0.2, hs * 0.48, fz, head);
  part(mats, "#f0a3a0", hs * 0.12, hs * 0.07, 0.008, -hs * 0.32, hs * 0.32, fz, head);
  part(mats, "#f0a3a0", hs * 0.12, hs * 0.07, 0.008, hs * 0.32, hs * 0.32, fz, head);
  if (!has("mask")) part(mats, "#9a4a46", hs * 0.16, hs * 0.05, 0.01, 0, hs * 0.26, fz, head);
  // hair
  const hc = spec.hair;
  switch (spec.hairStyle) {
    case "bun":
      part(mats, hc, hs * 1.04, hs * 0.3, hs * 0.96, 0, hs * 0.86, -0.005, head);
      part(mats, hc, hs * 1.04, hs * 0.5, hs * 0.2, 0, hs * 0.66, -hs * 0.4, head);
      part(mats, hc, hs * 0.36, hs * 0.3, hs * 0.36, 0, hs * 1.1, -hs * 0.12, head);
      break;
    case "ponytail":
      part(mats, hc, hs * 1.04, hs * 0.28, hs * 0.96, 0, hs * 0.86, -0.005, head);
      part(mats, hc, hs * 1.04, hs * 0.55, hs * 0.2, 0, hs * 0.62, -hs * 0.4, head);
      part(mats, hc, hs * 0.22, hs * 0.55, hs * 0.2, 0, hs * 0.4, -hs * 0.58, head);
      break;
    case "bob":
      part(mats, hc, hs * 1.08, hs * 0.3, hs * 1.0, 0, hs * 0.86, 0, head);
      part(mats, hc, hs * 0.16, hs * 0.6, hs * 0.9, -hs * 0.5, hs * 0.52, -0.01, head);
      part(mats, hc, hs * 0.16, hs * 0.6, hs * 0.9, hs * 0.5, hs * 0.52, -0.01, head);
      part(mats, hc, hs * 1.08, hs * 0.65, hs * 0.2, 0, hs * 0.55, -hs * 0.42, head);
      break;
    case "long":
      part(mats, hc, hs * 1.08, hs * 0.3, hs * 1.0, 0, hs * 0.86, 0, head);
      part(mats, hc, hs * 0.16, hs * 0.95, hs * 0.85, -hs * 0.5, hs * 0.38, -0.03, head);
      part(mats, hc, hs * 0.16, hs * 0.95, hs * 0.85, hs * 0.5, hs * 0.38, -0.03, head);
      part(mats, hc, hs * 1.08, hs * 1.15, hs * 0.22, 0, hs * 0.3, -hs * 0.44, head);
      break;
    case "spiky":
      part(mats, hc, hs * 1.02, hs * 0.26, hs * 0.94, 0, hs * 0.86, 0, head);
      for (let i = 0; i < 4; i++) part(mats, hc, hs * 0.2, hs * 0.22, hs * 0.2, (i - 1.5) * hs * 0.25, hs * 1.05, (i % 2 ? -1 : 1) * hs * 0.12, head);
      break;
    case "messy":
      part(mats, hc, hs * 1.06, hs * 0.3, hs * 0.98, 0, hs * 0.86, 0, head);
      part(mats, hc, hs * 0.4, hs * 0.18, hs * 0.3, hs * 0.18, hs * 1.04, hs * 0.2, head);
      part(mats, hc, hs * 0.3, hs * 0.2, hs * 0.2, -hs * 0.3, hs * 0.72, hs * 0.42, head);
      part(mats, hc, hs * 1.06, hs * 0.45, hs * 0.18, 0, hs * 0.66, -hs * 0.42, head);
      break;
    case "short":
      part(mats, hc, hs * 1.04, hs * 0.24, hs * 0.96, 0, hs * 0.88, 0, head);
      part(mats, hc, hs * 1.04, hs * 0.4, hs * 0.18, 0, hs * 0.66, -hs * 0.41, head);
      part(mats, hc, hs * 0.5, hs * 0.1, hs * 0.1, -hs * 0.2, hs * 0.78, hs * 0.44, head);
      break;
    case "buzz":
      part(mats, hc, hs * 1.02, hs * 0.12, hs * 0.94, 0, hs * 0.94, 0, head);
      break;
    default:
      break;
  }
  if (has("beard")) part(mats, spec.hair, hs * 0.9, hs * 0.26, hs * 0.12, 0, hs * 0.14, fz - 0.02, head), part(mats, spec.skin, hs * 0.3, hs * 0.08, 0.012, 0, hs * 0.24, fz + 0.03, head);
  if (has("glasses")) part(mats, "#1b1b1f", hs * 0.92, hs * 0.05, 0.012, 0, hs * 0.5, fz + 0.01, head), part(mats, "#cfe7ff", hs * 0.26, hs * 0.2, 0.008, -hs * 0.2, hs * 0.48, fz + 0.012, head), part(mats, "#cfe7ff", hs * 0.26, hs * 0.2, 0.008, hs * 0.2, hs * 0.48, fz + 0.012, head);
  if (has("round-glasses")) part(mats, "#c0a062", hs * 0.3, hs * 0.26, 0.012, -hs * 0.2, hs * 0.48, fz + 0.01, head), part(mats, "#c0a062", hs * 0.3, hs * 0.26, 0.012, hs * 0.2, hs * 0.48, fz + 0.01, head);
  if (has("visor")) part(mats, "#3fd6ff", hs * 1.04, hs * 0.16, 0.05, 0, hs * 0.5, fz, head);
  if (has("goggles")) part(mats, "#7fd9a8", hs * 0.9, hs * 0.14, 0.04, 0, hs * 0.82, fz - 0.01, head), part(mats, "#3a3f47", hs * 1.06, hs * 0.06, hs * 0.96, 0, hs * 0.82, 0, head);
  if (has("mask")) part(mats, "#2a1215", hs * 0.94, hs * 0.34, 0.03, 0, hs * 0.22, fz, head);
  if (has("headphones") || has("headset")) {
    part(mats, "#26262c", hs * 1.12, hs * 0.08, hs * 0.16, 0, hs * 1.0, 0, head);
    part(mats, has("headset") ? "#26262c" : "#e05b5b", hs * 0.14, hs * 0.34, hs * 0.3, -hs * 0.56, hs * 0.5, 0, head);
    part(mats, has("headset") ? "#26262c" : "#e05b5b", hs * 0.14, hs * 0.34, hs * 0.3, hs * 0.56, hs * 0.5, 0, head);
    if (has("headset")) part(mats, "#26262c", hs * 0.05, hs * 0.05, hs * 0.4, hs * 0.5, hs * 0.26, hs * 0.22, head);
  }
  if (has("beanie")) part(mats, spec.topAccent, hs * 1.08, hs * 0.36, hs * 1.0, 0, hs * 0.98, 0, head), part(mats, "#d9a066", hs * 1.1, hs * 0.1, hs * 1.02, 0, hs * 0.8, 0, head);
  if (has("hardhat")) part(mats, "#f2c230", hs * 1.12, hs * 0.3, hs * 1.04, 0, hs * 1.02, 0, head), part(mats, "#f2c230", hs * 1.2, hs * 0.05, hs * 1.22, 0, hs * 0.88, hs * 0.06, head);
  if (has("beret")) part(mats, "#c2410c", hs * 1.1, hs * 0.16, hs * 1.04, 0, hs * 1.0, 0, head), part(mats, "#c2410c", hs * 0.12, hs * 0.1, hs * 0.12, hs * 0.1, hs * 1.12, 0, head);
  if (has("cap")) part(mats, spec.top, hs * 1.06, hs * 0.22, hs * 0.98, 0, hs * 0.98, 0, head), part(mats, spec.top, hs * 0.8, hs * 0.05, hs * 0.4, 0, hs * 0.88, hs * 0.6, head);
  if (has("hood")) part(mats, spec.top, hs * 1.14, hs * 0.2, hs * 1.04, 0, hs * 1.0, -0.01, head), part(mats, spec.top, hs * 0.16, hs * 0.8, hs * 0.9, -hs * 0.58, hs * 0.5, -0.02, head), part(mats, spec.top, hs * 0.16, hs * 0.8, hs * 0.9, hs * 0.58, hs * 0.5, -0.02, head);

  // status ring + blob shadow
  const ringMat = new THREE.MeshBasicMaterial({ color: "#8b8a85", transparent: true, opacity: 0, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.45, 24), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.055;
  root.add(ring);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.55 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.05;
  root.add(shadow);
  const hit = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.4, 0.8), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 0.7;
  root.add(hit);
  return { root, body, torso, head, armL, armR, legL, legR, ring, hit, hipY };
}

function blobTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, "rgba(40,24,14,0.75)");
  grd.addColorStop(1, "rgba(40,24,14,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// Scene controller
// ---------------------------------------------------------------------------

interface Actor {
  key: string;
  rig: Rig;
  pos: THREE.Vector2; // world x,z
  yaw: number;
  targetYaw: number;
  path: THREE.Vector2[];
  seatId: string;
  pose: "sit" | "stand";
  activity: Activity;
  talkTo: string[];
  phase: number;
  sitBlend: number;
}

const SPEED = 2.6; // cells / s

export class OfficeScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private target = new THREE.Vector3(GRID_W / 2, 0, GRID_H / 2);
  private zoom = 1;
  private goalTarget = this.target.clone();
  private goalZoom = 1;
  private mats = new MatCache();
  private actors = new Map<string, Actor>();
  private leds: THREE.Mesh[] = [];
  private grid = walkableGrid();
  private clock = new THREE.Clock();
  private raf = 0;
  private visible = true;
  private running = false;
  private io?: IntersectionObserver;
  private ro?: ResizeObserver;
  private shadowTex = blobTexture();
  private packets: { mesh: THREE.Mesh; from: string; to: string; t: number }[] = [];
  private packetGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  private packetMat = new THREE.MeshBasicMaterial({ color: "#c5f04a" });
  private pointer = { down: false, x: 0, y: 0, moved: 0 };
  private ray = new THREE.Raycaster();
  private zoneMeshes: THREE.Mesh[] = [];
  private selected: string | null = null;
  private dirty = true;
  private disposed = false;
  private fitted = false;

  constructor(private canvas: HTMLCanvasElement, private cb: SceneCallbacks, private reducedMotion: boolean) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);

    const hemi = new THREE.HemisphereLight("#fff4e2", "#5a4636", 1.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight("#ffe2bd", 1.55);
    key.position.set(GRID_W * 0.75, 22, GRID_H * 1.1);
    key.target.position.set(GRID_W / 2, 0, GRID_H / 2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -22;
    sc.right = 22;
    sc.top = 18;
    sc.bottom = -18;
    sc.near = 1;
    sc.far = 70;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    this.scene.add(key, key.target);
    const fill = new THREE.DirectionalLight("#c9dcff", 0.35);
    fill.position.set(-10, 12, 30);
    this.scene.add(fill);

    const env = buildEnvironment();
    for (const m of env.meshes) this.scene.add(m);
    this.leds = env.leds;

    // invisible pick zones per location
    for (const l of LOCATIONS) {
      const [x0, z0, x1, z1] = l.rect;
      const z = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + 1, z1 - z0 + 1), new THREE.MeshBasicMaterial({ visible: false }));
      z.rotation.x = -Math.PI / 2;
      z.position.set((x0 + x1 + 1) / 2, 0.06, (z0 + z1 + 1) / 2);
      z.userData.location = l.id;
      this.zoneMeshes.push(z);
      this.scene.add(z);
    }

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.io = new IntersectionObserver((e) => {
      this.visible = e[0]?.isIntersecting ?? true;
      this.loop();
    });
    this.io.observe(canvas);
    document.addEventListener("visibilitychange", this.onVis);
    canvas.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.loop();
  }

  // ---- public API --------------------------------------------------------

  setAgents(agents: VisualAgent[], interactions: OfficeInteraction[] = []) {
    const keep = new Set(agents.map((a) => a.key));
    for (const [k, a] of this.actors)
      if (!keep.has(k)) {
        this.scene.remove(a.rig.root);
        this.actors.delete(k);
      }
    for (const v of agents) {
      const seat = SEAT_BY_ID[v.seatId];
      if (!seat) continue;
      let a = this.actors.get(v.key);
      if (!a) {
        const rig = buildCharacter(characterFor(v.key), this.mats, this.shadowTex);
        rig.hit.userData.agent = v.key;
        this.scene.add(rig.root);
        a = { key: v.key, rig, pos: new THREE.Vector2(seat.pos[0], seat.pos[1]), yaw: seat.facing, targetYaw: seat.facing, path: [], seatId: v.seatId, pose: seat.pose, activity: v.activity, talkTo: v.interactionWith, phase: hashPhase(v.key), sitBlend: seat.pose === "sit" ? 1 : 0 };
        this.actors.set(v.key, a);
      } else if (a.seatId !== v.seatId) {
        a.seatId = v.seatId;
        a.pose = seat.pose;
        if (this.reducedMotion) {
          a.pos.set(seat.pos[0], seat.pos[1]);
          a.yaw = a.targetYaw = seat.facing;
          a.path = [];
          a.sitBlend = seat.pose === "sit" ? 1 : 0;
        } else {
          const from = nearestWalkable(this.grid, a.pos.x - 0.5, a.pos.y - 0.5);
          const cells = findPath(this.grid, from, seat.cell);
          a.path = cells ? [...cells.slice(1).map(([x, z]) => new THREE.Vector2(x + 0.5, z + 0.5)), new THREE.Vector2(seat.pos[0], seat.pos[1])] : [new THREE.Vector2(seat.pos[0], seat.pos[1])];
          if (!cells) a.pos.set(seat.pos[0], seat.pos[1]); // unreachable → place (never walk through walls)
        }
      }
      a.activity = v.activity;
      a.talkTo = v.interactionWith;
      const ringMat = a.rig.ring.material as THREE.MeshBasicMaterial;
      ringMat.color.set(ACTIVITY_COLOR[v.activity]);
      ringMat.opacity = v.activity === "idle" ? 0 : 0.9;
    }
    // handoff packets travel along the interaction (from → each recipient present in the office)
    for (const p of this.packets) this.scene.remove(p.mesh);
    this.packets = [];
    for (const i of interactions)
      for (const to of i.to)
        if (this.actors.has(i.from) && this.actors.has(to))
          for (let n = 0; n < 3; n++) {
            const mesh = new THREE.Mesh(this.packetGeo, this.packetMat);
            this.scene.add(mesh);
            this.packets.push({ mesh, from: i.from, to, t: n / 3 });
          }
    this.dirty = true;
    this.loop();
  }

  select(key: string | null) {
    this.selected = key;
    this.dirty = true;
    this.loop();
  }

  focusAgent(key: string) {
    const a = this.actors.get(key);
    if (!a) return;
    const seat = SEAT_BY_ID[a.seatId];
    this.goalTarget.set(seat?.pos[0] ?? a.pos.x, 0.5, seat?.pos[1] ?? a.pos.y);
    this.goalZoom = 2.1;
    this.loop();
  }

  focusLocation(id: LocationId) {
    const l = LOCATIONS.find((x) => x.id === id);
    if (!l) return;
    const [x0, z0, x1, z1] = l.rect;
    this.goalTarget.set((x0 + x1 + 1) / 2, 0.4, (z0 + z1 + 1) / 2);
    this.goalZoom = THREE.MathUtils.clamp(26 / Math.max(x1 - x0 + 4, (z1 - z0 + 4) * 1.5), 1.2, 2.4);
    this.loop();
  }

  resetView() {
    this.goalTarget.copy(this.home);
    this.goalZoom = 1;
    this.loop();
  }

  zoomBy(f: number) {
    this.goalZoom = THREE.MathUtils.clamp(this.goalZoom * f, 0.75, 3);
    this.loop();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.io?.disconnect();
    this.ro?.disconnect();
    document.removeEventListener("visibilitychange", this.onVis);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && m.geometry !== UNIT) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mat && !Array.isArray(mat)) mat.dispose();
    });
    this.mats.dispose();
    this.shadowTex.dispose();
    this.renderer.dispose();
  }

  // ---- internals ---------------------------------------------------------

  private onVis = () => this.loop();

  private resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.dirty = true;
    const atHome = this.goalTarget.distanceTo(this.home) < 0.01 && Math.abs(this.goalZoom - 1) < 0.001;
    this.computeFit();
    if (atHome || !this.fitted) {
      this.fitted = true;
      this.target.copy(this.home);
      this.goalTarget.copy(this.home);
    }
    this.applyCamera();
    this.loop();
  }

  private dir = new THREE.Vector3(0.62, 0.95, 1).normalize().multiplyScalar(60);
  private fitHalf = 9;
  private home = new THREE.Vector3(GRID_W / 2, 0, GRID_H / 2);

  /** Fit the whole diorama (incl. walls) to the canvas at zoom 1; recomputed on resize. */
  private computeFit() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const aspect = w / h;
    const c = new THREE.Vector3(GRID_W / 2, 0, GRID_H / 2);
    const cam = new THREE.OrthographicCamera();
    cam.position.copy(c).add(this.dir);
    cam.lookAt(c);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const x of [-0.4, GRID_W + 0.4]) for (const y of [-0.5, 2.85]) for (const z of [-0.45, GRID_H + 0.4]) {
      const v = new THREE.Vector3(x, y, z).applyMatrix4(inv);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const halfH = (y1 - y0) / 2;
    const halfW = (x1 - x0) / 2;
    this.fitHalf = Math.max(halfH, halfW / aspect) * 1.03;
    // world point at the centre of the projected bounds
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    this.home.copy(c).addScaledVector(right, (x0 + x1) / 2).addScaledVector(up, (y0 + y1) / 2);
  }

  private applyCamera() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const aspect = w / h;
    const hh = this.fitHalf / this.zoom;
    this.camera.left = -hh * aspect;
    this.camera.right = hh * aspect;
    this.camera.top = hh;
    this.camera.bottom = -hh;
    this.camera.position.copy(this.target).add(this.dir);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  private loop = () => {
    if (this.disposed || this.running) return;
    if (!this.visible || document.hidden) return;
    this.running = true;
    this.clock.getDelta();
    const tick = () => {
      if (this.disposed) return;
      if (!this.visible || document.hidden) {
        this.running = false;
        return;
      }
      const dt = Math.min(0.05, this.clock.getDelta());
      const animating = this.update(dt, this.clock.elapsedTime);
      if (animating || this.dirty) {
        this.renderer.render(this.scene, this.camera);
        this.emitLabels();
        this.dirty = false;
      }
      if (!animating && this.reducedMotion) {
        this.running = false;
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  };

  /** Advance animation; returns true while anything is moving. */
  private update(dt: number, t: number): boolean {
    let moving = false;
    // camera easing
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 6);
    if (this.target.distanceTo(this.goalTarget) > 0.001 || Math.abs(this.zoom - this.goalZoom) > 0.001) {
      this.target.lerp(this.goalTarget, k);
      this.zoom += (this.goalZoom - this.zoom) * k;
      this.applyCamera();
      moving = true;
    }
    const still = this.reducedMotion;
    for (const a of this.actors.values()) {
      const r = a.rig;
      let walking = false;
      if (a.path.length) {
        walking = true;
        moving = true;
        const next = a.path[0];
        const d = next.clone().sub(a.pos);
        const step = SPEED * dt;
        if (d.length() <= step) {
          a.pos.copy(next);
          a.path.shift();
        } else {
          a.pos.add(d.normalize().multiplyScalar(step));
        }
        a.targetYaw = Math.atan2(d.x, d.y);
        if (!a.path.length) a.targetYaw = SEAT_BY_ID[a.seatId]?.facing ?? a.targetYaw;
      } else {
        a.targetYaw = SEAT_BY_ID[a.seatId]?.facing ?? a.targetYaw;
        // face a nearby conversation partner when standing
        if (a.talkTo.length && a.pose === "stand") {
          const p = this.actors.get(a.talkTo[0]);
          if (p && p.pos.distanceTo(a.pos) < 4) a.targetYaw = Math.atan2(p.pos.x - a.pos.x, p.pos.y - a.pos.y);
        }
      }
      let dy = a.targetYaw - a.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      a.yaw += still ? dy : dy * Math.min(1, dt * 10);
      if (Math.abs(dy) > 0.01) moving = true;
      const sitGoal = !walking && a.pose === "sit" ? 1 : 0;
      a.sitBlend += still ? sitGoal - a.sitBlend : (sitGoal - a.sitBlend) * Math.min(1, dt * 8);
      r.root.position.set(a.pos.x, 0.05, a.pos.y);
      r.root.rotation.y = a.yaw;
      this.pose(a, walking, still ? 0 : t, dt);
      if (!still) moving = true; // idle animations run continuously when motion is allowed
      const sel = this.selected === a.key;
      r.ring.scale.setScalar(sel ? 1.25 : 1);
      if (sel) (r.ring.material as THREE.MeshBasicMaterial).opacity = 1;
    }
    // LEDs
    if (!still)
      for (const l of this.leds) {
        const on = Math.sin(t * 2.2 + (l.userData.phase as number)) > -0.3;
        (l.material as THREE.MeshBasicMaterial).color.copy(l.userData.base as THREE.Color).multiplyScalar(on ? 1 : 0.25);
      }
    // packets
    for (const p of this.packets) {
      const A = this.actors.get(p.from);
      const B = this.actors.get(p.to);
      if (!A || !B) continue;
      if (!still) p.t = (p.t + dt * 0.45) % 1;
      const ax = A.pos.x, az = A.pos.y, bx = B.pos.x, bz = B.pos.y;
      const lift = 1.3 + Math.hypot(bx - ax, bz - az) * 0.18;
      const u = p.t;
      p.mesh.position.set(ax + (bx - ax) * u, 1.0 + Math.sin(Math.PI * u) * lift, az + (bz - az) * u);
      p.mesh.rotation.set(u * 6, u * 4, 0);
    }
    return moving;
  }

  private pose(a: Actor, walking: boolean, t: number, _dt: number) {
    const r = a.rig;
    const ph = a.phase;
    const s = a.sitBlend;
    // reset
    r.armL.rotation.set(0, 0, 0.06);
    r.armR.rotation.set(0, 0, -0.06);
    r.legL.rotation.set(0, 0, 0);
    r.legR.rotation.set(0, 0, 0);
    r.head.rotation.set(0, 0, 0);
    r.torso.rotation.set(0, 0, 0);
    r.body.position.set(0, 0, 0);
    r.body.scale.set(1, 1, 1);
    if (walking) {
      const w = Math.sin(t * 11 + ph);
      r.legL.rotation.x = w * 0.7;
      r.legR.rotation.x = -w * 0.7;
      r.armL.rotation.x = -w * 0.6;
      r.armR.rotation.x = w * 0.6;
      r.body.position.y = Math.abs(Math.cos(t * 11 + ph)) * 0.035;
      return;
    }
    // sitting: thighs forward, body lowered onto the chair
    if (s > 0.01) {
      r.legL.rotation.x = -1.45 * s;
      r.legR.rotation.x = -1.45 * s;
      // drop the hip onto the seat top (≈0.27 above the floor) and slide back over the seat
      r.body.position.y = (0.25 - r.hipY) * s;
      r.body.position.z = -0.08 * s;
    }
    const breathe = 1 + Math.sin(t * 2 + ph) * 0.012;
    r.torso.scale.y = breathe;
    switch (a.activity) {
      case "coding": {
        r.armL.rotation.x = -1.15;
        r.armR.rotation.x = -1.15;
        r.armL.rotation.x += Math.sin(t * 16 + ph) * 0.12;
        r.armR.rotation.x += Math.sin(t * 16 + ph + 1.7) * 0.12;
        r.head.rotation.x = 0.08 + Math.sin(t * 1.3 + ph) * 0.04;
        break;
      }
      case "testing": {
        r.armL.rotation.x = -1.0;
        r.armR.rotation.x = -0.9 + Math.max(0, Math.sin(t * 5 + ph)) * 0.35;
        r.head.rotation.x = 0.22;
        r.head.rotation.y = Math.sin(t * 0.8 + ph) * 0.15;
        break;
      }
      case "reviewing": {
        r.armR.rotation.x = -2.2;
        r.armR.rotation.z = 0.35;
        r.armL.rotation.x = -0.9;
        r.head.rotation.z = 0.12 + Math.sin(t * 0.9 + ph) * 0.05;
        r.head.rotation.x = 0.12;
        break;
      }
      case "planning": {
        const point = Math.sin(t * 0.7 + ph) > 0;
        r.armR.rotation.x = point ? -2.5 : -0.6;
        r.armR.rotation.z = point ? -0.2 : -0.06;
        r.armL.rotation.x = -0.8;
        r.head.rotation.x = point ? -0.15 : 0.05;
        break;
      }
      case "blocked": {
        r.head.rotation.x = 0.45;
        r.torso.rotation.x = 0.12;
        r.armL.rotation.z = 0.02;
        r.armR.rotation.z = -0.02;
        break;
      }
      case "awaiting_approval": {
        r.head.rotation.y = Math.sin(t * 0.6 + ph) * 0.35;
        r.armL.rotation.x = -0.4;
        r.armR.rotation.x = -0.4;
        r.legR.rotation.x = s > 0.5 ? r.legR.rotation.x : Math.max(0, Math.sin(t * 6 + ph)) * -0.18;
        break;
      }
      case "completed": {
        const hop = Math.max(0, Math.sin(t * 3 + ph));
        if (s < 0.5) r.body.position.y = hop * hop * 0.12;
        r.armL.rotation.x = -2.6 * hop;
        r.armR.rotation.x = -2.6 * hop;
        break;
      }
      default: {
        r.head.rotation.y = Math.sin(t * 0.35 + ph) * 0.3;
        r.armL.rotation.x = Math.sin(t * 1.1 + ph) * 0.04;
        r.armR.rotation.x = -Math.sin(t * 1.1 + ph) * 0.04;
      }
    }
    if (a.talkTo.length && a.activity !== "coding") {
      r.head.rotation.x += Math.sin(t * 7 + ph) * 0.05;
      r.armL.rotation.x = -0.9 + Math.sin(t * 3.2 + ph) * 0.35;
    }
  }

  private v = new THREE.Vector3();
  private emitLabels() {
    if (!this.cb.onFrame) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const proj = (x: number, y: number, z: number) => {
      this.v.set(x, y, z).project(this.camera);
      return { x: ((this.v.x + 1) / 2) * w, y: ((1 - this.v.y) / 2) * h };
    };
    const agents: Record<string, { x: number; y: number }> = {};
    for (const a of this.actors.values()) agents[a.key] = proj(a.pos.x, 1.95 - a.sitBlend * 0.25, a.pos.y);
    const locs: Record<string, { x: number; y: number }> = {};
    for (const l of LOCATIONS) locs[l.id] = proj((l.rect[0] + l.rect[2] + 1) / 2, 0.05, l.rect[3] + 0.95);
    this.cb.onFrame(agents, locs);
  }

  // ---- input -------------------------------------------------------------

  private onDown = (e: PointerEvent) => {
    this.pointer = { down: true, x: e.clientX, y: e.clientY, moved: 0 };
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointer.down) {
      const hit = this.pick(e.clientX, e.clientY);
      this.canvas.style.cursor = hit ? "pointer" : "grab";
      return;
    }
    const dx = e.clientX - this.pointer.x;
    const dy = e.clientY - this.pointer.y;
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.moved += Math.abs(dx) + Math.abs(dy);
    if (this.pointer.moved < 4) return;
    this.canvas.style.cursor = "grabbing";
    // pan in the floor plane, in camera-aligned axes
    const h = this.camera.top - this.camera.bottom;
    const perPx = h / (this.canvas.clientHeight || 1);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0).setY(0).normalize();
    const fwd = new THREE.Vector3(-right.z, 0, right.x);
    this.goalTarget.addScaledVector(right, -dx * perPx).addScaledVector(fwd, dy * perPx * 1.5);
    this.goalTarget.x = THREE.MathUtils.clamp(this.goalTarget.x, 2, GRID_W - 2);
    this.goalTarget.z = THREE.MathUtils.clamp(this.goalTarget.z, 2, GRID_H);
    this.target.copy(this.goalTarget);
    this.applyCamera();
    this.dirty = true;
    this.loop();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.pointer.down) return;
    const click = this.pointer.moved < 4;
    this.pointer.down = false;
    this.canvas.style.cursor = "grab";
    if (!click) return;
    const hit = this.pick(e.clientX, e.clientY);
    if (hit?.agent) this.cb.onPickAgent(hit.agent);
    else if (hit?.location) this.cb.onPickLocation(hit.location);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  private pick(cx: number, cy: number): { agent?: string; location?: LocationId } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (cx < rect.left || cy < rect.top || cx > rect.right || cy > rect.bottom) return null;
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hits = this.ray.intersectObjects([...this.actors.values()].map((a) => a.rig.hit), false);
    if (hits[0]) return { agent: hits[0].object.userData.agent as string };
    const z = this.ray.intersectObjects(this.zoneMeshes, false);
    if (z[0]) return { location: z[0].object.userData.location as LocationId };
    return null;
  }
}

