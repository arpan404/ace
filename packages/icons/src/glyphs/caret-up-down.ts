import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** A choice that opens a list: a small chevron up over a small chevron down. */
export const CaretUpDownIcon = /* @__PURE__ */ glyph("CaretUpDown", () => [
  line(
    polyline([
      [8, 9.5],
      [12, 5.5, 0.6],
      [16, 9.5],
    ]),
  ),
  line(
    polyline([
      [8, 14.5],
      [12, 18.5, 0.6],
      [16, 14.5],
    ]),
  ),
]);
