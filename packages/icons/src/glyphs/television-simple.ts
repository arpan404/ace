import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** A TV: a wide screen with two antennae. */
export const TelevisionSimpleIcon = /* @__PURE__ */ glyph("TelevisionSimple", () => [
  shape(rect(2.5, 7, 19, 13.25, 3.75)),
  line(
    polyline([
      [8, 2.75],
      [12, 6.5, 0.8],
      [16, 2.75],
    ]),
  ),
]);
