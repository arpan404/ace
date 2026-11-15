import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { circle, line } from "../parts.ts";

/** Letter case: a capital A beside a small a. */
export const TextAaIcon = /* @__PURE__ */ glyph("TextAa", () => [
  line(
    polyline([
      [2.75, 19],
      [7.75, 5, 0.7],
      [12.75, 19],
    ]),
  ),
  line("M4.75 14h6"),
  line(circle(17.5, 15.75, 3.25)),
  line("M20.75 12.5V19"),
]);
