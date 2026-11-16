import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { line, shape, type Part } from "../parts.ts";

const layer = (y: number): Part =>
  line(
    polyline([
      [3, y],
      [12, y + 4.75, 1.5],
      [21, y],
    ]),
  );

/** A stack: one layer on top of two more. */
export const StackIcon = /* @__PURE__ */ glyph("Stack", () => [
  shape(
    polygon([
      [12, 3, 1.5],
      [21, 7.75, 1.5],
      [12, 12.5, 1.5],
      [3, 7.75, 1.5],
    ]),
  ),
  layer(12),
  layer(16.25),
]);
