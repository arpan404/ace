import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { shape, type Part } from "../parts.ts";

/** The square the split icons divide. */
export const square = (): Part => shape(rect(3.5, 3.5, 17, 17, 4.5));

/** Not yet ticked: an empty square. */
export const SquareIcon = /* @__PURE__ */ glyph("Square", () => [square()]);
