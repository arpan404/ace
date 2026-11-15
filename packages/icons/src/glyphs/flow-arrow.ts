import { glyph } from "../glyph.ts";
import { arrowhead } from "../geometry.ts";
import { circle, line } from "../parts.ts";

/** A workflow: a start node and the path it runs along. */
export const FlowArrowIcon = /* @__PURE__ */ glyph("FlowArrow", () => [
  line(circle(5.5, 18.5, 2.5)),
  line("M8 18.5c5 0 3.5-12.5 12-12.5"),
  line(arrowhead([20.25, 6], 0, 3.2)),
]);
