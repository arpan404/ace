import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** A watch: a rounded square face on its band, with the crown on the side. */
export const WatchIcon = /* @__PURE__ */ glyph("Watch", () => [
  line(
    polyline([
      [8, 6],
      [8.75, 2.75, 1],
      [14.25, 2.75, 1],
      [15, 6],
    ]),
  ),
  line(
    polyline([
      [8, 18],
      [8.75, 21.25, 1],
      [14.25, 21.25, 1],
      [15, 18],
    ]),
  ),
  shape(rect(5.5, 6, 12, 12, 3.75)),
  line("M19.75 10.5v3"),
]);
