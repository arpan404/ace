import { glyph } from "../glyph.ts";
import { arc, arrowhead, onCircle, polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** History, or rewind: a clock's rim turning back, with its hands. */
export const ClockCounterClockwiseIcon = /* @__PURE__ */ glyph("ClockCounterClockwise", () => [
  line(arc(12, 12, 8.75, -155, 165)),
  line(arrowhead(onCircle(12, 12, 8.75, -155), 112, 3.4)),
  line(
    polyline([
      [12, 8],
      [12, 12, 0.8],
      [14.75, 13.75],
    ]),
  ),
]);
