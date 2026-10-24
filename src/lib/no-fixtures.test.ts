/** Guard: application code must never import test doubles or fixtures, and customer-facing copy must not describe the product as scripted/simulated. */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

describe("production code hygiene", () => {
  it("no production module imports test/doubles or test/fixtures", () => {
    const offenders = walk("src").filter((f) => /from ["'][./]*test\/(doubles|fixtures)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("the marketing site does not describe AURA as scripted, simulated, mocked or a prototype", () => {
    const pages = ["src/app/page.tsx", ...walk("src/components/marketing")];
    const bad = pages.filter((f) => /\b(scripted|simulated|mock(ed)?|prototype|demo only|not yet real)\b/i.test(readFileSync(f, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")));
    expect(bad).toEqual([]);
  });
});
