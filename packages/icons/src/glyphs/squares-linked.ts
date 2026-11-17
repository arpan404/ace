import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** An app connected to ace: two app tiles joined by a cable. */
export const SquaresLinkedIcon = /* @__PURE__ */ glyph("SquaresLinked", () => [
  shape(rect(2.75, 2.75, 8.5, 8.5, 3)),
  shape(rect(12.75, 12.75, 8.5, 8.5, 3)),
  line(
    polyline([
      [11.25, 7],
      [17, 7, 2.75],
      [17, 12.75],
    ]),
  ),
]);
