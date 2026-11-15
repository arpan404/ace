import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Send: a paper plane flying up and to the right. */
export const PaperPlaneTiltIcon = /* @__PURE__ */ glyph("PaperPlaneTilt", () => [
  shape(
    polygon([
      [20.75, 3.25, 0.8],
      [14, 20.5, 1.2],
      [10.75, 13.25, 0.8],
      [3.5, 10, 1.2],
    ]),
  ),
  detail("M10.75 13.25 15 9"),
]);
