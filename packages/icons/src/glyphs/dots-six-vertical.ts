import { glyph } from "../glyph.ts";
import { circle, shape } from "../parts.ts";

/** A drag handle: two columns of three dots. */
export const DotsSixVerticalIcon = /* @__PURE__ */ glyph("DotsSixVertical", () =>
  // Tiny bodies, not spots: with no body to cut from, a spot would vanish in the solid weight.
  [5.5, 12, 18.5].flatMap((y) => [shape(circle(9, y, 0.6)), shape(circle(15, y, 0.6))]),
);
