/**
 * Benchmark suite self-test: the suite must measure what it claims. A
 * benchmark that is wrong is worse than none — it can make a bad change look
 * like an improvement. (A no-op patch in gate-reject-dropped-route was found
 * this way; see suite version 2026.10.23-3.)
 */
import { describe, it, expect } from "vitest";
import { BENCHMARKS, SUITE_VERSION } from "./benchmarks";
import { buildIndex } from "@/lib/builder/intel";

describe("benchmark suite integrity", () => {
  it("ids are unique, every case has criteria and a split, and both splits exist per gate category", () => {
    expect(new Set(BENCHMARKS.map((b) => b.id)).size).toBe(BENCHMARKS.length);
    for (const b of BENCHMARKS) {
      expect(b.criteria.length, b.id).toBeGreaterThan(0);
      expect(["train", "heldout"]).toContain(b.split);
    }
    expect(BENCHMARKS.some((b) => b.split === "heldout" && b.kind === "gate" && b.expect.decision === "reject")).toBe(true);
    expect(BENCHMARKS.some((b) => b.split === "heldout" && b.kind === "gate" && b.expect.decision === "accept")).toBe(true);
    expect(SUITE_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
  });

  it("every candidate change actually changes the repository (no no-op patches)", () => {
    for (const b of BENCHMARKS.filter((x) => x.change)) {
      for (const [p, c] of Object.entries(b.change!)) {
        if (c === null) expect(b.base[p], `${b.id}: deletes a file that does not exist: ${p}`).toBeDefined();
        else expect(c, `${b.id}: patch to ${p} is identical to the base`).not.toBe(b.base[p]);
      }
    }
  });

  it("gate expectations are consistent with the cases' intent", async () => {
    for (const b of BENCHMARKS.filter((x) => x.kind === "gate")) {
      expect(["accept", "reject"], b.id).toContain(b.expect.decision);
      if (b.expect.decision === "reject") expect(b.criteria.some((c) => c.id === "rejected"), b.id).toBe(true);
    }
    // The dropped-route case must really drop a route.
    const d = BENCHMARKS.find((b) => b.id === "gate-reject-dropped-route")!;
    const before = (await buildIndex(d.base)).routes.map((r) => `${r.method} ${r.path}`);
    const after = (await buildIndex({ ...d.base, ...(d.change as Record<string, string>) })).routes.map((r) => `${r.method} ${r.path}`);
    expect(before).toContain("GET /api/users");
    expect(after).not.toContain("GET /api/users");
  });
});
