import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Source code: a pair of angle brackets around a slash. */
export const CodeIcon = /* @__PURE__ */ glyph("Code", () => [
  line(
    polyline([
      [7.5, 7],
      [2.75, 12, 0.8],
      [7.5, 17],
    ]),
  ),
  line(
    polyline([
      [16.5, 7],
      [21.25, 12, 0.8],
      [16.5, 17],
    ]),
  ),
  line("M13.75 4.75 10.25 19.25"),
]);
