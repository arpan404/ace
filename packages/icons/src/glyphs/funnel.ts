import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { shape } from "../parts.ts";

/** Filter: a funnel. */
export const FunnelIcon = /* @__PURE__ */ glyph("Funnel", () => [
  shape(
    polygon([
      [3, 4, 2],
      [21, 4, 2],
      [14, 12.5, 1],
      [14, 18.75, 1.2],
      [10, 20.75, 1.2],
      [10, 12.5, 1],
    ]),
  ),
]);
