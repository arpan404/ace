import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** Copy: one sheet over another. */
export const CopyIcon = /* @__PURE__ */ glyph("Copy", () => [
  line(
    polyline([
      [8, 16],
      [3, 16, 3.5],
      [3, 3, 3.5],
      [16, 3, 3.5],
      [16, 8],
    ]),
  ),
  shape(rect(8, 8, 13, 13, 3.5)),
]);
