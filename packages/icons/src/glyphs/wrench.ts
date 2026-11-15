import { glyph } from "../glyph.ts";
import { polygon, scaled, turned } from "../geometry.ts";
import { shape } from "../parts.ts";

/** Tools, or fix it: an open-jawed wrench, head up and to the right. */
export const WrenchIcon = /* @__PURE__ */ glyph("Wrench", () => [
  shape(
    polygon(
      turned(
        scaled(
          [
            [10.5, 2.5, 0.6],
            [10.5, 5.25, 0.8],
            [13.5, 5.25, 0.8],
            [13.5, 2.5, 0.6],
            [16.75, 4, 3],
            [16.75, 8.5, 3],
            [13.75, 10.75, 1.2],
            [13.75, 20.25, 1.75],
            [10.25, 20.25, 1.75],
            [10.25, 10.75, 1.2],
            [7.25, 8.5, 3],
            [7.25, 4, 3],
          ],
          1.12,
        ),
        45,
      ),
    ),
  ),
]);
