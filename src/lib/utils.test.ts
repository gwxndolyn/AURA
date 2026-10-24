import { describe, it, expect } from "vitest";
import { clamp, parseJSON, seededRandom, hashString, formatCurrency } from "./utils";

describe("utils", () => {
  it("clamps values", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it("parseJSON returns fallback on invalid input", () => {
    expect(parseJSON("not json", { a: 1 })).toEqual({ a: 1 });
    expect(parseJSON('{"a":2}', { a: 1 })).toEqual({ a: 2 });
    expect(parseJSON(null, [])).toEqual([]);
  });

  it("seededRandom is deterministic and in [0,1)", () => {
    const r1 = seededRandom(42);
    const r2 = seededRandom(42);
    const a = r1();
    const b = r2();
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it("hashString is stable", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });

  it("formats currency compactly", () => {
    expect(formatCurrency(1500)).toMatch(/\$1\.5K/);
    expect(formatCurrency(500, false)).toBe("$500");
  });
});
