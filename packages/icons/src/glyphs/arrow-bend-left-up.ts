import { glyph } from "../glyph.ts";
import { arrowhead, polyline } from "../geometry.ts";
import { line } from "../parts.ts";
import { fullHead } from "./arrow-up.ts";

/** Back to the parent: an arrow left that turns up. */
export const ArrowBendLeftUpIcon = /* @__PURE__ */ glyph("ArrowBendLeftUp", () => [
  line(
    polyline([
      [20, 19],
      [9.5, 19, 5],
      [9.5, 4.5],
    ]),
  ),
  line(arrowhead([9.5, 4.5], -90, fullHead)),
]);
