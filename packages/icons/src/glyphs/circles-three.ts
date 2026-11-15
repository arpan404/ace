import { glyph } from "../glyph.ts";
import { circle, shape } from "../parts.ts";

/** Thread details: three circles in a triangle. */
export const CirclesThreeIcon = /* @__PURE__ */ glyph("CirclesThree", () => [
  shape(circle(12, 7.25, 4)),
  shape(circle(7, 16.25, 4)),
  shape(circle(17, 16.25, 4)),
]);
