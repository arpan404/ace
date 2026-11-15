import { glyph } from "../glyph.ts";
import { polygon, scaled, turned } from "../geometry.ts";
import { shape } from "../parts.ts";

/** Work in progress: a hammer, its head tilted up to the right. */
export const HammerIcon = /* @__PURE__ */ glyph("Hammer", () => [
  shape(
    polygon(
      turned(
        scaled(
          [
            [4.75, 4.5, 1],
            [8.5, 3, 1.25],
            [19, 3, 1.5],
            [19, 8.5, 1.5],
            [8.5, 8.5, 1.25],
            [4.75, 7, 1],
          ],
          1.1,
        ),
        45,
      ),
    ),
  ),
  shape(
    polygon(
      turned(
        scaled(
          [
            [10.25, 8.5],
            [13.75, 8.5],
            [13.75, 21, 1.75],
            [10.25, 21, 1.75],
          ],
          1.1,
        ),
        45,
      ),
    ),
  ),
]);
