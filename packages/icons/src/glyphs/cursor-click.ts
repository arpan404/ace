import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** Point at an element: a pointer with three click marks. */
export const CursorClickIcon = /* @__PURE__ */ glyph("CursorClick", () => [
  shape(
    polygon([
      [9, 9, 0.8],
      [20.5, 13, 1],
      [15, 15, 0.6],
      [13, 20.5, 1],
    ]),
  ),
  line("M9 2.75v2.75M2.75 9H5.5M4.6 4.6l1.75 1.75M13.4 4.6l-1.6 1.6M4.6 13.4l1.6-1.6"),
]);
