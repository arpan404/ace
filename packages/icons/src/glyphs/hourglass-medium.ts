import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { line, shape, spot } from "../parts.ts";

/** Waiting, or a usage limit: an hourglass halfway through, sand in both bulbs. */
export const HourglassMediumIcon = /* @__PURE__ */ glyph("HourglassMedium", () => [
  shape(
    polygon([
      [6.5, 3, 0.6],
      [17.5, 3, 0.6],
      [17.5, 6, 3.5],
      [13, 12, 1],
      [17.5, 18, 3.5],
      [17.5, 21, 0.6],
      [6.5, 21, 0.6],
      [6.5, 18, 3.5],
      [11, 12, 1],
      [6.5, 6, 3.5],
    ]),
  ),
  line("M4.75 3h14.5M4.75 21h14.5"),
  spot(
    polygon([
      [9.25, 7.75, 0.6],
      [14.75, 7.75, 0.6],
      [12, 10.5, 0.6],
    ]),
  ),
  spot(
    polygon([
      [12, 15.5, 0.8],
      [15.25, 18.75, 0.6],
      [8.75, 18.75, 0.6],
    ]),
  ),
]);
