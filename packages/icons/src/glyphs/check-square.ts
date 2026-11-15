import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { detail, shape, type Part } from "../parts.ts";

/** The soft square every in-a-square mark is drawn in. */
export const square = (): Part => shape(rect(3.5, 3.5, 17, 17, 5));

/** Viewed, ticked off: a check in a square. */
export const CheckSquareIcon = /* @__PURE__ */ glyph("CheckSquare", () => [
  square(),
  detail(
    polyline([
      [8, 12.4],
      [10.75, 15, 0.8],
      [16, 9.5],
    ]),
  ),
]);
