import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { detail, line, shape } from "../parts.ts";

/** Many folders: one folder in front of another. */
export const FoldersIcon = /* @__PURE__ */ glyph("Folders", () => [
  line(
    polyline([
      [2.5, 17],
      [2.5, 3.5, 3],
      [7.5, 3.5, 1.75],
      [9.5, 5.5, 1.25],
      [15.5, 5.5, 3],
      [18, 8, 2.5],
      [18, 9.5],
    ]),
  ),
  shape(
    polygon([
      [6, 7.5, 3],
      [11.5, 7.5, 1.75],
      [13.5, 9.5, 1.25],
      [21.5, 9.5, 3],
      [21.5, 20.5, 3.5],
      [6, 20.5, 3.5],
    ]),
  ),
  detail("M6.5 13h14.5"),
]);
