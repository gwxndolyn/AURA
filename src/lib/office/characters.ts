/**
 * Character art direction: one original voxel character per real agent key
 * (src/lib/agents/definitions.ts). Pure data, consumed by the 3D builder and
 * the 2D pixel sprites, so both views show the same person.
 *
 * Every role is a configuration of the same orchestrator and model client
 * (different prompt, capability registry entry and tool allowlist) — the
 * distinct look is personality, not a claim of a separate AI system.
 */

export type HairStyle = "bun" | "ponytail" | "short" | "messy" | "bob" | "spiky" | "buzz" | "long" | "none";
export type Accessory =
  | "glasses"
  | "round-glasses"
  | "headphones"
  | "headset"
  | "beanie"
  | "hardhat"
  | "hood"
  | "cap"
  | "visor"
  | "goggles"
  | "beard"
  | "labcoat"
  | "scarf"
  | "tie"
  | "clipboard"
  | "tablet"
  | "mug"
  | "toolbelt"
  | "mask"
  | "beret"
  | "pencil";

export interface CharacterSpec {
  key: string;
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  top: string;
  topAccent: string;
  bottom: string;
  shoes: string;
  accessories: Accessory[];
  /** Height multiplier around 1 (silhouette variety). */
  height: number;
  /** Width multiplier around 1. */
  build: number;
}

export const CHARACTERS: Record<string, CharacterSpec> = {
  ceo: { key: "ceo", skin: "#c98f6b", hair: "#2b1d16", hairStyle: "bun", top: "#6b55c9", topAccent: "#f1ecff", bottom: "#2c2a3a", shoes: "#1c1a22", accessories: ["scarf", "mug"], height: 1.04, build: 1 },
  "product-manager": { key: "product-manager", skin: "#f0c7a4", hair: "#7a3b2a", hairStyle: "ponytail", top: "#e58fbf", topAccent: "#fff1f7", bottom: "#3b3346", shoes: "#2b2230", accessories: ["clipboard"], height: 0.98, build: 1 },
  designer: { key: "designer", skin: "#e9b98f", hair: "#3b2a6b", hairStyle: "bob", top: "#f472b6", topAccent: "#fde7f3", bottom: "#2d2a3f", shoes: "#f6d365", accessories: ["beret", "pencil"], height: 0.95, build: 0.97 },
  architect: { key: "architect", skin: "#b07b57", hair: "#1f1f24", hairStyle: "short", top: "#3fb3a7", topAccent: "#e7fbf8", bottom: "#2f3b44", shoes: "#20262b", accessories: ["glasses", "beard"], height: 1.08, build: 1.02 },
  "frontend-engineer": { key: "frontend-engineer", skin: "#f3d2b4", hair: "#d9b04a", hairStyle: "messy", top: "#4e95e8", topAccent: "#d7e8ff", bottom: "#2d3a52", shoes: "#f2f2f2", accessories: ["headphones", "hood"], height: 0.94, build: 0.98 },
  "backend-engineer": { key: "backend-engineer", skin: "#8c5a3c", hair: "#18120f", hairStyle: "buzz", top: "#e0893a", topAccent: "#7a3d16", bottom: "#33302b", shoes: "#4a3424", accessories: ["beanie", "beard", "mug"], height: 1.02, build: 1.1 },
  "qa-engineer": { key: "qa-engineer", skin: "#e2b08a", hair: "#3a2a20", hairStyle: "bob", top: "#f2f4ef", topAccent: "#46b26f", bottom: "#2e4a3a", shoes: "#24332a", accessories: ["labcoat", "goggles", "tablet"], height: 0.97, build: 1 },
  reviewer: { key: "reviewer", skin: "#f5d6c0", hair: "#8d8fa8", hairStyle: "long", top: "#9a96ee", topAccent: "#ecebff", bottom: "#38364d", shoes: "#26243a", accessories: ["round-glasses"], height: 1, build: 0.96 },
  "security-engineer": { key: "security-engineer", skin: "#a8724f", hair: "#111114", hairStyle: "spiky", top: "#2d2b36", topAccent: "#e05b9a", bottom: "#1f1e26", shoes: "#e05b9a", accessories: ["visor", "hood"], height: 1.01, build: 1 },
  devops: { key: "devops", skin: "#dba27c", hair: "#5b3a24", hairStyle: "short", top: "#8b6ad8", topAccent: "#e9e0ff", bottom: "#3a3f4a", shoes: "#2a2e36", accessories: ["hardhat", "toolbelt"], height: 1, build: 1.06 },
  "red-team": { key: "red-team", skin: "#c48a64", hair: "#160c0c", hairStyle: "none", top: "#d8414f", topAccent: "#2a1215", bottom: "#251a1c", shoes: "#151012", accessories: ["hood", "mask"], height: 0.99, build: 0.98 },
  "blue-team": { key: "blue-team", skin: "#e8c09e", hair: "#2a3550", hairStyle: "short", top: "#2f7fd6", topAccent: "#d8ebff", bottom: "#253246", shoes: "#18202c", accessories: ["headset", "cap"], height: 1.02, build: 1.02 },
  "data-analyst": { key: "data-analyst", skin: "#7e5136", hair: "#e9e4dc", hairStyle: "bob", top: "#2e9e98", topAccent: "#dff7f5", bottom: "#2a3d3c", shoes: "#1d2a29", accessories: ["glasses", "tablet"], height: 0.96, build: 1 },
  support: { key: "support", skin: "#f2cfae", hair: "#c4562e", hairStyle: "long", top: "#e6c540", topAccent: "#fff8d6", bottom: "#3d3a2b", shoes: "#2c2a20", accessories: ["headset"], height: 0.97, build: 1 },
};

export const FALLBACK_CHARACTER: CharacterSpec = { key: "unknown", skin: "#d9b08c", hair: "#3a2a20", hairStyle: "short", top: "#8a8a92", topAccent: "#e0e0e4", bottom: "#33333a", shoes: "#222226", accessories: [], height: 1, build: 1 };

export function characterFor(key: string): CharacterSpec {
  return CHARACTERS[key] ?? { ...FALLBACK_CHARACTER, key };
}

/**
 * 10×10 pixel sprite (face + shoulders) for the 2D office, derived from the
 * same spec. Returns rows of hex colors or "" for transparent.
 */
export function pixelSprite(spec: CharacterSpec): string[][] {
  const g: string[][] = Array.from({ length: 10 }, () => new Array<string>(10).fill(""));
  const fill = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < 10 && y < 10) g[y][x] = c;
  };
  const has = (a: Accessory) => spec.accessories.includes(a);
  // shoulders + face
  fill(1, 8, 8, 9, spec.top);
  fill(4, 8, 5, 8, spec.topAccent);
  fill(2, 2, 7, 7, spec.skin);
  // hair
  if (spec.hairStyle !== "none") {
    fill(2, 1, 7, 2, spec.hair);
    if (spec.hairStyle === "long" || spec.hairStyle === "bob") fill(1, 2, 1, spec.hairStyle === "long" ? 7 : 5, spec.hair), fill(8, 2, 8, spec.hairStyle === "long" ? 7 : 5, spec.hair);
    if (spec.hairStyle === "bun") fill(4, 0, 5, 0, spec.hair);
    if (spec.hairStyle === "ponytail") fill(8, 2, 8, 5, spec.hair);
    if (spec.hairStyle === "spiky") (g[0][3] = spec.hair), (g[0][6] = spec.hair);
    if (spec.hairStyle === "messy") (g[0][4] = spec.hair), (g[3][2] = spec.hair);
  }
  if (has("hood")) fill(1, 1, 8, 1, spec.top), fill(1, 2, 1, 7, spec.top), fill(8, 2, 8, 7, spec.top);
  if (has("beanie")) fill(2, 0, 7, 2, spec.topAccent);
  if (has("hardhat")) fill(1, 1, 8, 1, "#f2c230"), fill(2, 0, 7, 0, "#f2c230");
  if (has("cap")) fill(2, 1, 7, 1, spec.top), fill(6, 2, 8, 2, spec.top);
  if (has("beret")) fill(2, 0, 7, 1, "#c2410c"), (g[0][8] = "#c2410c");
  if (has("pencil")) (g[2][8] = "#f6d365"), (g[3][8] = "#f6d365");
  // eyes
  g[4][3] = "#1b1b1f";
  g[4][6] = "#1b1b1f";
  if (has("glasses") || has("round-glasses")) (g[4][2] = "#9fc7e8"), (g[4][7] = "#9fc7e8"), (g[4][4] = "#5a5a60"), (g[4][5] = "#5a5a60");
  if (has("visor")) fill(2, 4, 7, 4, "#6ee7ff");
  if (has("goggles")) fill(2, 2, 7, 2, "#7fd9a8");
  if (has("mask")) fill(2, 5, 7, 7, "#2a1215");
  if (has("beard")) fill(2, 7, 7, 7, spec.hair), (g[6][2] = spec.hair), (g[6][7] = spec.hair), (g[6][4] = "#b4534e"), (g[6][5] = "#b4534e");
  else if (!has("mask")) (g[6][4] = "#b4534e"), (g[6][5] = "#b4534e");
  if (has("headphones") || has("headset")) fill(1, 3, 1, 5, "#26262c"), fill(8, 3, 8, 5, "#26262c");
  if (has("headset")) (g[6][7] = "#26262c");
  return g;
}
