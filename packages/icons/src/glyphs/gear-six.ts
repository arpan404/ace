import { glyph } from "../glyph.ts";
import { onCircle, polygon, type Vertex } from "../geometry.ts";
import { circle, detail, shape } from "../parts.ts";

/** The gear's outline: eight rounded teeth. */
function teeth(): Vertex[] {
  const points: Vertex[] = [];
  for (let k = 0; k < 8; k++) {
    const c = k * 45 + 22.5;
    for (const [r, a] of [
      [7.4, c - 15],
      [9.6, c - 8],
      [9.6, c + 8],
      [7.4, c + 15],
    ] as const)
      points.push([...onCircle(12, 12, r, a), 1.1]);
  }
  return points;
}

/** Settings: a soft eight-toothed gear around a round hole. */
export const GearSixIcon = /* @__PURE__ */ glyph("GearSix", () => [
  shape(polygon(teeth())),
  detail(circle(12, 12, 3.25)),
]);
