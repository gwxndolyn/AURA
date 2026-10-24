import { describe, it, expect } from "vitest";
import { estimateCost, priceFor } from "./pricing";

describe("pricing", () => {
  it("selects pricing by model family prefix", () => {
    expect(priceFor("claude-opus-5-5").inPerM).toBe(15);
    expect(priceFor("claude-haiku-4-5-20251001").inPerM).toBe(0.8);
    expect(priceFor("claude-sonnet-5-5").outPerM).toBe(15);
  });

  it("falls back to a sensible default for unknown models", () => {
    expect(priceFor("mystery-model")).toEqual({ inPerM: 3, outPerM: 15 });
  });

  it("estimates cost from token counts", () => {
    // 1M in + 1M out on sonnet = 3 + 15
    expect(estimateCost("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBeCloseTo(18, 5);
    expect(estimateCost("claude-haiku-4-5", 0, 0)).toBe(0);
  });
});
