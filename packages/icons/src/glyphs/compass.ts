import { glyph } from "../glyph.ts";
import { polygon, turned } from "../geometry.ts";
import { detail } from "../parts.ts";
import { ring } from "./circle.ts";

/** Discover, or browse: a compass, its needle pointing to the upper right. */
export const CompassIcon = /* @__PURE__ */ glyph("Compass", () => [
  ring(),
  detail(
    polygon(
      turned(
        [
          [12, 5.75, 0.6],
          [14.5, 12, 0.8],
          [12, 18.25, 0.6],
          [9.5, 12, 0.8],
        ],
        45,
      ),
    ),
  ),
]);
