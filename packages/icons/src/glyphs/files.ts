import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { detail, line, shape } from "../parts.ts";

/** Files: one page in front of another. */
export const FilesIcon = /* @__PURE__ */ glyph("Files", () => [
  line(
    polyline([
      [4, 17.5],
      [4, 2.5, 3.5],
      [12.5, 2.5],
    ]),
  ),
  shape(
    polygon([
      [8, 6, 3.5],
      [15, 6, 0.8],
      [20, 11, 0.8],
      [20, 21.5, 3.5],
      [8, 21.5, 3.5],
    ]),
  ),
  detail("M15 6.4V9a2 2 0 0 0 2 2h2.6"),
]);
