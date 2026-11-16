import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { circle, detail, shape } from "../parts.ts";

/** A publisher: a person on a square card, the profile of who made something. */
export const UserSquareIcon = /* @__PURE__ */ glyph("UserSquare", () => [
  shape(rect(3, 3, 18, 18, 5)),
  detail(circle(12, 10, 3.1)),
  detail("M7 20.6c1-2.45 2.85-3.6 5-3.6s4 1.15 5 3.6"),
]);
