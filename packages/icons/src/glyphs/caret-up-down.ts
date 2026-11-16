import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** A choice that opens a list: a chevron up over a chevron down, each as wide as ace's caret. */
export const CaretUpDownIcon = /* @__PURE__ */ glyph("CaretUpDown", () => [
  line(
    polyline([
      [6.5, 9.75],
      [12, 4.25, 0.8],
      [17.5, 9.75],
    ]),
  ),
  line(
    polyline([
      [6.5, 14.25],
      [12, 19.75, 0.8],
      [17.5, 14.25],
    ]),
  ),
]);
