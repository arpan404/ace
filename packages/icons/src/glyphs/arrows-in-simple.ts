import { glyph } from "../glyph.ts";
import { arrow, smallHead } from "./arrow-up.ts";

/** Leave full view: two arrows pointing in from opposite corners. */
export const ArrowsInSimpleIcon = /* @__PURE__ */ glyph("ArrowsInSimple", () => [
  ...arrow([20, 4], [13.75, 10.25], smallHead),
  ...arrow([4, 20], [10.25, 13.75], smallHead),
]);
