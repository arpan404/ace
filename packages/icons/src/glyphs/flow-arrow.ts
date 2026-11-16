import { glyph } from "../glyph.ts";
import { arrowhead, polyline, rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** A workflow: one step leading to the next. */
export const FlowArrowIcon = /* @__PURE__ */ glyph("FlowArrow", () => [
  shape(rect(3, 3.5, 7, 7, 2.25)),
  line(
    polyline([
      [10, 7],
      [17.5, 7, 3.25],
      [17.5, 13.25],
    ]),
  ),
  line(arrowhead([17.5, 13.25], 90, 3.25)),
  shape(rect(14, 15.5, 7, 5, 2)),
]);
