import { glyph } from "../glyph.ts";
import { onCircle, polygon, type Vertex } from "../geometry.ts";
import { circle, detail, shape } from "../parts.ts";

/** A cog with six broad, square-shouldered teeth: a different machine from the settings gear. */
function cog(): Vertex[] {
  const points: Vertex[] = [];
  for (let k = 0; k < 6; k++) {
    const c = k * 60;
    for (const [r, a, round] of [
      [7, c - 30 + 9, 1.6],
      [9.5, c - 13, 0.9],
      [9.5, c + 13, 0.9],
      [7, c + 30 - 9, 1.6],
    ] as const)
      points.push([...onCircle(12, 12, r, a), round]);
  }
  return points;
}

/** A project mark: a six-toothed cog with a wide hub. */
export const GearIcon = /* @__PURE__ */ glyph("Gear", () => [
  shape(polygon(cog())),
  detail(circle(12, 12, 3.5)),
]);
