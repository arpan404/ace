import { glyph } from "../glyph.ts";
import { polygon, turned } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** Work under way: a hammer, its head across the handle. */
export const HammerIcon = /* @__PURE__ */ glyph("Hammer", () => [
  shape(
    polygon(
      turned(
        [
          [3.25, 6.5, 2],
          [14.75, 6.5, 2],
          [14.75, 11.5, 2],
          [3.25, 11.5, 2],
        ],
        -45,
        9,
        9,
      ),
    ),
  ),
  line("M10.9 10.9 19.75 19.75"),
]);
