import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { detail, dot, shape } from "../parts.ts";

/** An image that can't be drawn: the picture split in two along a jagged crack. */
export const ImageBrokenIcon = /* @__PURE__ */ glyph("ImageBroken", () => [
  shape(
    polygon([
      [2.5, 4, 4.5],
      [11, 4, 0.6],
      [9, 9.5, 0.7],
      [12, 13.5, 0.7],
      [9.5, 20, 0.6],
      [2.5, 20, 4.5],
    ]),
  ),
  detail(
    polyline([
      [2.9, 16.75],
      [6.75, 13, 1],
      [9.25, 15.25],
    ]),
  ),
  shape(
    polygon([
      [14.25, 4, 0.6],
      [21.5, 4, 4.5],
      [21.5, 20, 4.5],
      [12.75, 20, 0.6],
      [15.25, 13.5, 0.7],
      [12.25, 9.5, 0.7],
    ]),
  ),
  dot(17.5, 8.75, 1.4),
]);
