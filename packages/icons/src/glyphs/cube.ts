import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { detail, shape, type Part } from "../parts.ts";

/** A cube seen from above a corner, its three faces marked; also the base of the package. */
export const cube = (): Part[] => [
  shape(
    polygon([
      [12, 2.5, 1.75],
      [20.25, 7, 1.75],
      [20.25, 17, 1.75],
      [12, 21.5, 1.75],
      [3.75, 17, 1.75],
      [3.75, 7, 1.75],
    ]),
  ),
  detail(
    polyline([
      [4.2, 7.25],
      [12, 11.5, 0.8],
      [19.8, 7.25],
    ]),
  ),
  detail("M12 11.5v9.5"),
];

/** A skill: a cube. */
export const CubeIcon = /* @__PURE__ */ glyph("Cube", cube);
