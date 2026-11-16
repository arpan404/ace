import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { detail, line, shape } from "../parts.ts";

/** Delete: a bin under its lid. */
export const TrashIcon = /* @__PURE__ */ glyph("Trash", () => [
  line("M3.5 6.5h17"),
  line(
    polyline([
      [9, 6.5],
      [9, 3.75, 1.5],
      [15, 3.75, 1.5],
      [15, 6.5],
    ]),
  ),
  shape(
    polygon([
      [5.5, 6.5, 0.5],
      [18.5, 6.5, 0.5],
      [17.4, 19.5, 2.6],
      [6.6, 19.5, 2.6],
    ]),
  ),
  detail("M10 10.5v5M14 10.5v5"),
]);
