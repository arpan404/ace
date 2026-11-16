import { glyph } from "../glyph.ts";
import { circle, detail, dot, shape } from "../parts.ts";

/** Something failed: an exclamation in a circle. */
export const WarningCircleIcon = /* @__PURE__ */ glyph("WarningCircle", () => [
  shape(circle(12, 12, 9.25)),
  detail("M12 7.5v5"),
  dot(12, 16.25, 1.2),
]);
