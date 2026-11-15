import { glyph } from "../glyph.ts";
import { polygon, rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Archive: a box under its lid. */
export const ArchiveIcon = /* @__PURE__ */ glyph("Archive", () => [
  shape(rect(2.5, 3.5, 19, 5, 2)),
  shape(
    polygon([
      [4, 8.5, 0],
      [20, 8.5, 0],
      [20, 20.5, 3.5],
      [4, 20.5, 3.5],
    ]),
  ),
  detail("M10 12.75h4"),
]);
