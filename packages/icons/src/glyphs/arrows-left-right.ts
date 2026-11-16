import { glyph } from "../glyph.ts";
import { arrow, smallHead } from "./arrow-up.ts";

/** A handoff: an arrow right over an arrow left. */
export const ArrowsLeftRightIcon = /* @__PURE__ */ glyph("ArrowsLeftRight", () => [
  ...arrow([4, 7.5], [20, 7.5], smallHead),
  ...arrow([20, 16.5], [4, 16.5], smallHead),
]);
