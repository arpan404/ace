import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** A file that isn't in the checkout: the page drawn in dashes. */
export const FileDashedIcon = /* @__PURE__ */ glyph("FileDashed", () => [
  line(
    polyline([
      [5, 7.25],
      [5, 2.5, 4],
      [9.25, 2.5],
    ]),
  ),
  line(
    polyline([
      [11.75, 2.5],
      [13, 2.5, 0.8],
      [19, 8.5, 0.8],
      [19, 9.75],
    ]),
  ),
  line("M13 2.9V6.5a2 2 0 0 0 2 2h3.6"),
  line("M19 12.5v3.5M5 9.75v5.5M10.75 21.5h2.5"),
  line(
    polyline([
      [19, 18.75],
      [19, 21.5, 4],
      [15.75, 21.5],
    ]),
  ),
  line(
    polyline([
      [8.25, 21.5],
      [5, 21.5, 4],
      [5, 17.75],
    ]),
  ),
]);
