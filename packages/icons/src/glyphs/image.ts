import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { detail, dot, shape, type Part } from "../parts.ts";

/** A frame holding a hill and the sun; also the base of the unavailable image. */
export const image = (): Part[] => [
  shape(rect(2.5, 4, 19, 16, 4.5)),
  detail(
    polyline([
      [2.9, 16.75],
      [8.5, 12, 1.25],
      [13, 16, 1],
      [15.5, 13.75, 1],
      [21.1, 17.5],
    ]),
  ),
  dot(15.75, 8.75, 1.5),
];

/** An image. */
export const ImageIcon = /* @__PURE__ */ glyph("Image", image);
