import { glyph } from "../glyph.ts";
import { circle, line, shape } from "../parts.ts";

/** A bulleted list: three dots, three lines. */
export const ListBulletsIcon = /* @__PURE__ */ glyph("ListBullets", () => [
  // Tiny bodies, not spots: with no body to cut from, a spot would vanish in the solid weight.
  ...[6, 12, 18].map((y) => shape(circle(5, y, 0.55))),
  line("M9.5 6h11M9.5 12h11M9.5 18h11"),
]);
