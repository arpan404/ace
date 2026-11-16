import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** An experiment: a lab flask, part full. */
export const FlaskIcon = /* @__PURE__ */ glyph("Flask", () => [
  shape(
    polygon([
      [9.5, 3.25, 0.6],
      [14.5, 3.25, 0.6],
      [14.5, 9, 1.2],
      [20.25, 18.25, 1.8],
      [18.25, 20.75, 1.8],
      [5.75, 20.75, 1.8],
      [3.75, 18.25, 1.8],
      [9.5, 9, 1.2],
    ]),
  ),
  detail("M6.6 14.5h10.8"),
]);
