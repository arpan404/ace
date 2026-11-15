import { describe, expect, it } from "vitest";
import { polygon, polyline, rect } from "./geometry.ts";

/** Every x,y pair a path's commands pass through or pull toward. */
const coordinates = (d: string): [number, number][] => {
  const numbers = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2)
    pairs.push([numbers[i] ?? 0, numbers[i + 1] ?? 0]);
  return pairs;
};

describe("icon geometry", () => {
  it("keeps a rounded rectangle inside its box", () => {
    for (const [x, y] of coordinates(rect(3, 4, 18, 16, 5)))
      expect(x >= 3 && x <= 21 && y >= 4 && y <= 20, `${x},${y}`).toBe(true);
  });

  it("never lets a big radius run past the middle of a short edge", () => {
    const d = rect(10, 10, 4, 4, 9);
    for (const [x, y] of coordinates(d))
      expect(x >= 10 && x <= 14 && y >= 10 && y <= 14).toBe(true);
    expect(d).toMatch(/^M.*Z$/);
  });

  it("rounds a corner off its vertex instead of passing through it", () => {
    const d = polyline([
      [4, 4],
      [20, 4, 3],
      [20, 20],
    ]);
    expect(d).not.toContain("L20 4");
    expect(d).toMatch(/^M4 4/);
    expect(d).toMatch(/L20 20$/);
  });

  it("leaves a corner sharp when it has no radius", () => {
    expect(
      polygon([
        [2, 2],
        [10, 2],
        [10, 10],
      ]),
    ).toContain("L10 2C10 2 10 2 10 2");
  });
});
