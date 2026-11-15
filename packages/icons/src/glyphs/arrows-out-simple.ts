import { glyph } from "../glyph.ts";
import { arrow, smallHead } from "./arrow-up.ts";

/** Full view: two arrows pointing out to opposite corners. */
export const ArrowsOutSimpleIcon = /* @__PURE__ */ glyph("ArrowsOutSimple", () => [
  ...arrow([13.75, 10.25], [20, 4], smallHead),
  ...arrow([10.25, 13.75], [4, 20], smallHead),
]);
