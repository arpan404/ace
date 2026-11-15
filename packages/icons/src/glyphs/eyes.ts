import { glyph } from "../glyph.ts";
import { ellipse } from "../geometry.ts";
import { dot, shape } from "../parts.ts";

/** An "eyes" reaction: two eyes glancing aside. */
export const EyesIcon = /* @__PURE__ */ glyph("Eyes", () => [
  shape(ellipse(7.5, 12, 3.75, 6)),
  shape(ellipse(16.5, 12, 3.75, 6)),
  dot(8.9, 13.25, 1.6),
  dot(17.9, 13.25, 1.6),
]);
