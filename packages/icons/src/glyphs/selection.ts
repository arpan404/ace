import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line, type Part } from "../parts.ts";

const [lo, hi] = [3.5, 20.5];
const turn = (x: number, y: number, dx: number, dy: number): Part =>
  line(
    polyline([
      [x, y + dy * 4.25],
      [x, y, 3],
      [x + dx * 4.25, y],
    ]),
  );

/** A marquee: a square drawn in dashes, rounded at the corners. */
export const marquee = (): Part[] => [
  turn(lo, lo, 1, 1),
  turn(hi, lo, -1, 1),
  turn(hi, hi, -1, -1),
  turn(lo, hi, 1, -1),
  line(`M10.75 ${lo}h2.5M10.75 ${hi}h2.5M${lo} 10.75v2.5M${hi} 10.75v2.5`),
];

/** Annotate: a dashed selection square. */
export const SelectionIcon = /* @__PURE__ */ glyph("Selection", marquee);
