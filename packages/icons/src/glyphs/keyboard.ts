import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, dot, shape } from "../parts.ts";

/** A keyboard: a row of keys over the space bar. */
export const KeyboardIcon = /* @__PURE__ */ glyph("Keyboard", () => [
  shape(rect(2.5, 5.5, 19, 13, 3.75)),
  dot(7, 10, 1.1),
  dot(10.33, 10, 1.1),
  dot(13.67, 10, 1.1),
  dot(17, 10, 1.1),
  detail("M8.5 14.25h7"),
]);
