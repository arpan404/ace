import { glyph } from "../glyph.ts";
import { arrowhead, polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Opens somewhere else: an arrow leaving a box. */
export const ArrowSquareOutIcon = /* @__PURE__ */ glyph("ArrowSquareOut", () => [
  line(
    polyline([
      [10.5, 4.5],
      [4.5, 4.5, 3.5],
      [4.5, 19.5, 3.5],
      [19.5, 19.5, 3.5],
      [19.5, 13.5],
    ]),
  ),
  line(arrowhead([20, 4], -45, 5.5)),
  line("M20 4 11.5 12.5"),
]);
