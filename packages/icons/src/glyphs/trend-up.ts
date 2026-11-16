import { glyph } from "../glyph.ts";
import { arrowhead, polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Trending, or rising: a line climbing up and to the right, with an arrowhead. */
export const TrendUpIcon = /* @__PURE__ */ glyph("TrendUp", () => [
  line(
    polyline([
      [3, 17.5],
      [9, 11.5, 1],
      [13, 15.5, 1],
      [20.5, 8],
    ]),
  ),
  line(arrowhead([20.5, 8], -45, 5.25)),
]);
