import { glyph } from "../glyph.ts";
import { polygon, rect } from "../geometry.ts";
import { circle, shape } from "../parts.ts";

/** A visualization: a triangle, a circle and a square. */
export const ShapesIcon = /* @__PURE__ */ glyph("Shapes", () => [
  shape(
    polygon([
      [7.25, 3.25, 0.8],
      [11.25, 10.25, 0.8],
      [3.25, 10.25, 0.8],
    ]),
  ),
  shape(circle(17, 6.75, 3.75)),
  shape(rect(7.5, 13.25, 9, 8, 2)),
]);
