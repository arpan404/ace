import { glyph } from "../glyph.ts";
import { arrowhead, polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Open here: an arrow coming into a box. */
export const ArrowSquareInIcon = /* @__PURE__ */ glyph("ArrowSquareIn", () => [
  line(
    polyline([
      [10.5, 4.5],
      [4.5, 4.5, 3.5],
      [4.5, 19.5, 3.5],
      [19.5, 19.5, 3.5],
      [19.5, 13.5],
    ]),
  ),
  line("M20 4 11 13"),
  line(arrowhead([11, 13], 135, 5.5)),
]);
