import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Goes back: a chevron. */
export const CaretLeftIcon = /* @__PURE__ */ glyph("CaretLeft", () => [
  line(
    polyline([
      [14.75, 6.5],
      [9.25, 12, 0.8],
      [14.75, 17.5],
    ]),
  ),
]);
