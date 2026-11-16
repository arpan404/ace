import { glyph } from "../glyph.ts";
import { circle, detail, shape } from "../parts.ts";

/** Paused: two bars in a circle. */
export const PauseCircleIcon = /* @__PURE__ */ glyph("PauseCircle", () => [
  shape(circle(12, 12, 9.25)),
  detail("M9.75 8.75v6.5M14.25 8.75v6.5"),
]);
