import { describe, expect, it } from "vitest";
import { railOrdinals } from "./rail-ordinals.ts";

describe("conversation rail overview", () => {
  it("keeps a 100,000-turn thread bounded while retaining the exact reader and endpoints", () => {
    const ordinals = railOrdinals(100_000, 53_219);
    expect(ordinals.length).toBeLessThanOrEqual(80);
    expect(ordinals).toContain(53_219);
    expect(ordinals[0]).toBe(1);
    expect(ordinals.at(-1)).toBe(100_000);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect(ordinals.every((ordinal, index) => index === 0 || ordinal > ordinals[index - 1]!)).toBe(
      true,
    );
  });
  it("keeps every small-thread turn and clamps stale reading positions after a thread switch", () => {
    expect(railOrdinals(4, 20)).toEqual([1, 2, 3, 4]);
    expect(railOrdinals(4, -2)).toEqual([1, 2, 3, 4]);
    expect(railOrdinals(0, 1)).toEqual([]);
  });
});
