import { glyph } from "../glyph.ts";
import { arrowhead, polyline } from "../geometry.ts";
import { line } from "../parts.ts";
import { fullHead } from "./arrow-up.ts";

/** Reply: an arrow up that turns left. */
export const ArrowBendUpLeftIcon = /* @__PURE__ */ glyph("ArrowBendUpLeft", () => [
  line(
    polyline([
      [19, 20],
      [19, 9.5, 5],
      [4.5, 9.5],
    ]),
  ),
  line(arrowhead([4.5, 9.5], 180, fullHead)),
]);
