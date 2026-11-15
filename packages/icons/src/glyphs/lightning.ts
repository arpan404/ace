import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { shape } from "../parts.ts";

/** Fast, or a quick action: a lightning bolt. */
export const LightningIcon = /* @__PURE__ */ glyph("Lightning", () => [
  shape(
    polygon([
      [14, 2.5, 0.8],
      [5, 13.5, 0.8],
      [11.25, 13.5, 0.6],
      [10, 21.5, 0.8],
      [19, 10.5, 0.8],
      [12.75, 10.5, 0.6],
    ]),
  ),
]);
