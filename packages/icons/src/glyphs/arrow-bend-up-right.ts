import { glyph } from "../glyph.ts";
import { arrowhead, polyline } from "../geometry.ts";
import { line } from "../parts.ts";
import { fullHead } from "./arrow-up.ts";

/** Send to a running agent: an arrow up that turns right. */
export const ArrowBendUpRightIcon = /* @__PURE__ */ glyph("ArrowBendUpRight", () => [
  line(
    polyline([
      [5, 20],
      [5, 9.5, 5],
      [19.5, 9.5],
    ]),
  ),
  line(arrowhead([19.5, 9.5], 0, fullHead)),
]);
