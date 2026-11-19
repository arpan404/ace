import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail, dot, shape } from "../parts.ts";

/** A warning: an exclamation in a soft triangle. */
export const WarningIcon = /* @__PURE__ */ glyph("Warning", () => [
  shape(
    polygon([
      [12, 3, 2.6],
      [21.6, 19.75, 2.6],
      [2.4, 19.75, 2.6],
    ]),
  ),
  detail("M12 9v4.25"),
  dot(12, 16.6, 1.2),
]);
