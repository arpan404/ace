import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, dot, shape } from "../parts.ts";

/** Logs: a card of rows, each a mark and a line. */
export const ScrollIcon = /* @__PURE__ */ glyph("Scroll", () => [
  shape(rect(3, 3.5, 18, 17, 5)),
  dot(7.75, 8.75, 1.1),
  dot(7.75, 12, 1.1),
  dot(7.75, 15.25, 1.1),
  detail("M10.75 8.75h5.75M10.75 12h3.75M10.75 15.25h5"),
]);
