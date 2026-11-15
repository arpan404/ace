import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { circle, detail, shape } from "../parts.ts";

/** Finished: a check in a circle. */
export const CheckCircleIcon = /* @__PURE__ */ glyph("CheckCircle", () => [
  shape(circle(12, 12, 9.25)),
  detail(
    polyline([
      [8, 12.4],
      [10.75, 15, 0.8],
      [16, 9.5],
    ]),
  ),
]);
