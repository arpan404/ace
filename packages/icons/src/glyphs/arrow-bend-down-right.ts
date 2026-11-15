import { glyph } from "../glyph.ts";
import { arrowhead, polyline } from "../geometry.ts";
import { line } from "../parts.ts";
import { fullHead } from "./arrow-up.ts";

/** Steer, or reply to an agent: an arrow down that turns right. */
export const ArrowBendDownRightIcon = /* @__PURE__ */ glyph("ArrowBendDownRight", () => [
  line(
    polyline([
      [5, 4.5],
      [5, 14.5, 5],
      [19.5, 14.5],
    ]),
  ),
  line(arrowhead([19.5, 14.5], 0, fullHead)),
]);
