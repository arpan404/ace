import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Thread details: the thread's live activity, a pulse across a card. */
export const CirclesThreeIcon = /* @__PURE__ */ glyph("CirclesThree", () => [
  shape(rect(3, 4, 18, 16, 5.5)),
  detail(
    polyline([
      [6.5, 12.5],
      [9, 12.5, 0.6],
      [10.75, 9, 0.6],
      [13.25, 15.75, 0.6],
      [15, 12.5, 0.6],
      [17.5, 12.5],
    ]),
  ),
]);
