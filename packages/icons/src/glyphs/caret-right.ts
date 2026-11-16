import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Goes forward: a chevron. */
export const CaretRightIcon = /* @__PURE__ */ glyph("CaretRight", () => [
  line(
    polyline([
      [9.25, 6.5],
      [14.75, 12, 0.8],
      [9.25, 17.5],
    ]),
  ),
]);
