import { glyph } from "../glyph.ts";
import { polygon, rect } from "../geometry.ts";
import { shape } from "../parts.ts";

/** The Store: three rounded tiles with a lifted diamond in the top right. */
export const StoreIcon = /* @__PURE__ */ glyph("Store", () => [
  shape(rect(3.25, 3.75, 7, 7, 2.1)),
  shape(rect(3.25, 13.5, 7, 7, 2.1)),
  shape(rect(13.25, 13.5, 7, 7, 2.1)),
  shape(
    polygon([
      [17, 2.75, 1.4],
      [21.25, 7, 1.4],
      [17, 11.25, 1.4],
      [12.75, 7, 1.4],
    ]),
  ),
]);
