import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Opens upward: a chevron. */
export const CaretUpIcon = /* @__PURE__ */ glyph("CaretUp", () => [
  line(
    polyline([
      [6.5, 14.75],
      [12, 9.25, 0.8],
      [17.5, 14.75],
    ]),
  ),
]);
