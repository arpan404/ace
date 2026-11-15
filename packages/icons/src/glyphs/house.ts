import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { detail, shape, type Part } from "../parts.ts";

/** A house's walls under a pitched roof; also the base of the plain house. */
export const house = (): Part[] => [
  shape(
    polygon([
      [3.5, 10.25, 2],
      [12, 3, 1.75],
      [20.5, 10.25, 2],
      [20.5, 21, 3.5],
      [3.5, 21, 3.5],
    ]),
  ),
];

/** Home: a house with its door. */
export const HouseIcon = /* @__PURE__ */ glyph("House", () => [
  ...house(),
  detail(
    polyline([
      [9.75, 20.6],
      [9.75, 15.5, 1.5],
      [14.25, 15.5, 1.5],
      [14.25, 20.6],
    ]),
  ),
]);
