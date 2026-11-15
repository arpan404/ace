import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Done, or chosen: a check. */
export const CheckIcon = /* @__PURE__ */ glyph("Check", () => [
  line(
    polyline([
      [4.5, 12.5],
      [9.5, 17.5, 0.8],
      [19.5, 7],
    ]),
  ),
]);
