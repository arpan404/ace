import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { circle, detail, shape } from "../parts.ts";

/** Stopped: a soft square in a circle. */
export const StopCircleIcon = /* @__PURE__ */ glyph("StopCircle", () => [
  shape(circle(12, 12, 9.25)),
  detail(rect(8.75, 8.75, 6.5, 6.5, 1.75)),
]);
