import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { circle, detail, shape } from "../parts.ts";

/** A time: a clock face. */
export const ClockIcon = /* @__PURE__ */ glyph("Clock", () => [
  shape(circle(12, 12, 9.25)),
  detail(
    polyline([
      [12, 7.5],
      [12, 12, 0.8],
      [15, 14],
    ]),
  ),
]);
