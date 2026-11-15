import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { dot, shape } from "../parts.ts";

/** A label: a tag with its eyelet. */
export const TagIcon = /* @__PURE__ */ glyph("Tag", () => [
  shape(
    polygon([
      [3.25, 3.25, 2.5],
      [11.25, 3.25, 1],
      [20.75, 12.75, 2],
      [12.75, 20.75, 2],
      [3.25, 11.25, 1],
    ]),
  ),
  dot(8, 8, 1.5),
]);
